import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PowerDNSProfileStore } from '../src/profile-store.js';

const temporaryDirectories: string[] = [];

async function temporaryStore(): Promise<{ directory: string; store: PowerDNSProfileStore }> {
  const directory = await mkdtemp(join(tmpdir(), 'znvault-powerdns-profile-'));
  temporaryDirectories.push(directory);
  return { directory, store: new PowerDNSProfileStore(join(directory, 'nested', 'profiles.json')) };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

describe('PowerDNSProfileStore', () => {
  it('stores only Vault references with restrictive permissions', async () => {
    const { store } = await temporaryStore();
    await store.add('production', {
      vaultProfile: 'operators',
      secretAlias: 'services/powerdns/primary',
    });

    const file = await readFile(store.filePath, 'utf8');
    expect(file).toContain('services/powerdns/primary');
    expect(file).not.toContain('apiKey');
    expect(file).not.toContain('https://');
    expect((await lstat(store.filePath)).mode & 0o777).toBe(0o600);
    expect((await lstat(dirname(store.filePath))).mode & 0o777).toBe(0o700);
  });

  it('selects an active connection and falls back deterministically after removal', async () => {
    const { store } = await temporaryStore();
    await store.add('zeta', { vaultProfile: 'default', secretAlias: 'dns/zeta' });
    await store.add('alpha', { vaultProfile: 'default', secretAlias: 'dns/alpha' }, { activate: true });
    expect((await store.resolve()).name).toBe('alpha');

    await store.remove('alpha');
    expect((await store.resolve()).name).toBe('zeta');
  });

  it('repairs overly broad file permissions when loading', async () => {
    const { store } = await temporaryStore();
    await store.add('primary', { vaultProfile: 'default', secretAlias: 'dns/primary' });
    await chmod(store.filePath, 0o644);

    await store.load();
    expect((await lstat(store.filePath)).mode & 0o777).toBe(0o600);
  });

  it('rejects a symlinked profile file', async () => {
    const { directory, store } = await temporaryStore();
    await mkdir(dirname(store.filePath), { recursive: true });
    const target = join(directory, 'target.json');
    await writeFile(target, '{"version":1,"profiles":{}}');
    await symlink(target, store.filePath);

    await expect(store.load()).rejects.toThrow('not a symlink');
  });

  it('does not overwrite an existing connection without force', async () => {
    const { store } = await temporaryStore();
    await store.add('primary', { vaultProfile: 'default', secretAlias: 'dns/one' });
    await expect(
      store.add('primary', { vaultProfile: 'default', secretAlias: 'dns/two' }),
    ).rejects.toThrow('already exists');
  });
});
