import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const PROFILE_FILE_VERSION = 1 as const;
export const DEFAULT_PROFILE_FILE = join(homedir(), '.znvault', 'powerdns', 'profiles.json');

export interface PowerDNSConnectionProfile {
  vaultProfile: string;
  secretAlias: string;
}

export interface PowerDNSProfileFile {
  version: typeof PROFILE_FILE_VERSION;
  active?: string;
  profiles: Record<string, PowerDNSConnectionProfile>;
}

const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function emptyStore(): PowerDNSProfileFile {
  return { version: PROFILE_FILE_VERSION, profiles: {} };
}

export function validateProfileName(name: string): string {
  if (!PROFILE_NAME_PATTERN.test(name)) {
    throw new Error('Connection name must be 1-64 characters using letters, numbers, dot, underscore, or hyphen');
  }
  return name;
}

export function validateSecretAlias(alias: string): string {
  const normalized = alias.trim();
  if (
    normalized.length === 0 ||
    normalized.length > 512 ||
    normalized.startsWith('alias:') ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new Error('Vault secret alias is invalid');
  }
  return normalized;
}

function validateVaultProfile(name: string): string {
  const normalized = name.trim();
  if (normalized.length === 0 || normalized.length > 128 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error('ZnVault profile name is invalid');
  }
  return normalized;
}

function parseStore(raw: string): PowerDNSProfileFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('PowerDNS profile file is not valid JSON');
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('PowerDNS profile file has an invalid structure');
  }

  const candidate = parsed as Partial<PowerDNSProfileFile>;
  if (
    candidate.version !== PROFILE_FILE_VERSION ||
    candidate.profiles === null ||
    typeof candidate.profiles !== 'object' ||
    Array.isArray(candidate.profiles)
  ) {
    throw new Error(`Unsupported PowerDNS profile file version (expected ${PROFILE_FILE_VERSION})`);
  }

  const profiles: Record<string, PowerDNSConnectionProfile> = {};
  for (const [name, value] of Object.entries(candidate.profiles)) {
    validateProfileName(name);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`PowerDNS connection '${name}' is invalid`);
    }
    const profile = value as Partial<PowerDNSConnectionProfile>;
    if (typeof profile.vaultProfile !== 'string' || typeof profile.secretAlias !== 'string') {
      throw new Error(`PowerDNS connection '${name}' is incomplete`);
    }
    profiles[name] = {
      vaultProfile: validateVaultProfile(profile.vaultProfile),
      secretAlias: validateSecretAlias(profile.secretAlias),
    };
  }

  const result: PowerDNSProfileFile = { version: PROFILE_FILE_VERSION, profiles };
  if (candidate.active !== undefined) {
    const active = validateProfileName(candidate.active);
    if (profiles[active] === undefined) {
      throw new Error(`Active PowerDNS connection '${active}' does not exist`);
    }
    result.active = active;
  }
  return result;
}

export class PowerDNSProfileStore {
  public constructor(public readonly filePath: string = DEFAULT_PROFILE_FILE) {}

  public async load(): Promise<PowerDNSProfileFile> {
    try {
      const stats = await lstat(this.filePath);
      if (stats.isSymbolicLink() || !stats.isFile()) {
        throw new Error('PowerDNS profile path must be a regular file, not a symlink');
      }
      await chmod(this.filePath, 0o600);
      return parseStore(await readFile(this.filePath, 'utf8'));
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return emptyStore();
      throw error;
    }
  }

  public async save(store: PowerDNSProfileFile): Promise<void> {
    const validated = parseStore(JSON.stringify(store));
    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);

    const temporary = join(directory, `.profiles.${process.pid}.${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, this.filePath);
      await chmod(this.filePath, 0o600);
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  public async add(
    name: string,
    profile: PowerDNSConnectionProfile,
    options: { force?: boolean; activate?: boolean } = {},
  ): Promise<PowerDNSProfileFile> {
    const normalizedName = validateProfileName(name);
    const validatedProfile: PowerDNSConnectionProfile = {
      vaultProfile: validateVaultProfile(profile.vaultProfile),
      secretAlias: validateSecretAlias(profile.secretAlias),
    };
    const store = await this.load();
    if (store.profiles[normalizedName] !== undefined && options.force !== true) {
      throw new Error(`PowerDNS connection '${normalizedName}' already exists; use --force to replace it`);
    }
    store.profiles[normalizedName] = validatedProfile;
    if (options.activate === true || store.active === undefined) store.active = normalizedName;
    await this.save(store);
    return store;
  }

  public async activate(name: string): Promise<PowerDNSProfileFile> {
    const normalizedName = validateProfileName(name);
    const store = await this.load();
    if (store.profiles[normalizedName] === undefined) {
      throw new Error(`PowerDNS connection '${normalizedName}' does not exist`);
    }
    store.active = normalizedName;
    await this.save(store);
    return store;
  }

  public async remove(name: string): Promise<PowerDNSProfileFile> {
    const normalizedName = validateProfileName(name);
    const store = await this.load();
    if (store.profiles[normalizedName] === undefined) {
      throw new Error(`PowerDNS connection '${normalizedName}' does not exist`);
    }
    delete store.profiles[normalizedName];
    if (store.active === normalizedName) {
      const next = Object.keys(store.profiles).sort()[0];
      if (next === undefined) delete store.active;
      else store.active = next;
    }
    await this.save(store);
    return store;
  }

  public async resolve(name?: string): Promise<{ name: string; profile: PowerDNSConnectionProfile }> {
    const store = await this.load();
    const selected = name === undefined ? store.active : validateProfileName(name);
    if (selected === undefined) {
      throw new Error('No active PowerDNS connection; add one with `znvault powerdns profile add`');
    }
    const profile = store.profiles[selected];
    if (profile === undefined) throw new Error(`PowerDNS connection '${selected}' does not exist`);
    return { name: selected, profile };
  }

  public async exists(): Promise<boolean> {
    try {
      await access(this.filePath, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
