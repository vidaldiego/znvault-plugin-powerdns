import type { CLIPluginContext } from './plugin-types.js';
import type { PowerDNSConnectionProfile } from './profile-store.js';

export const POWERDNS_SECRET_SCHEMA = 'io.zincapp.znvault.powerdns/v1';

interface SecretMetadata {
  id: string;
  alias: string;
  type: string;
}

interface DecryptedSecret extends SecretMetadata {
  data: Record<string, unknown>;
}

export interface PowerDNSTlsConfig {
  rejectUnauthorized: boolean;
  ca?: string;
}

export interface PowerDNSVaultConfig {
  schema: typeof POWERDNS_SECRET_SCHEMA;
  apiUrl: string;
  apiKey: string;
  serverId: string;
  timeoutMs: number;
  maxResponseBytes: number;
  tls: PowerDNSTlsConfig;
}

function requiredString(value: unknown, field: string, maximum = 8192): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) {
    throw new Error(`Vault PowerDNS configuration field '${field}' is missing or invalid`);
  }
  return value;
}

function optionalInteger(
  value: unknown,
  field: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`Vault PowerDNS configuration field '${field}' must be an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function optionalBoolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    throw new Error(`Vault PowerDNS configuration field '${field}' must be boolean`);
  }
  return value;
}

function parseDocument(data: Record<string, unknown>): Record<string, unknown> {
  if (typeof data.text !== 'string') return data;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.text);
  } catch {
    throw new Error("Vault PowerDNS configuration field 'text' is not valid JSON");
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Vault PowerDNS configuration must decrypt to a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function validateApiUrl(value: unknown, allowInsecureHttp: unknown): string {
  const raw = requiredString(value, 'apiUrl', 2048);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Vault PowerDNS configuration field 'apiUrl' is not a valid URL");
  }

  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error("Vault PowerDNS configuration field 'apiUrl' cannot contain credentials, a query, or a fragment");
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error("Vault PowerDNS configuration field 'apiUrl' must use HTTPS");
  }
  if (url.protocol === 'http:' && allowInsecureHttp !== true) {
    throw new Error("HTTP PowerDNS endpoints require 'allowInsecureHttp: true' in the Vault secret");
  }

  const pathname = url.pathname.replace(/\/+$/u, '');
  if (!pathname.endsWith('/api/v1')) {
    throw new Error("Vault PowerDNS configuration field 'apiUrl' must end in '/api/v1'");
  }
  url.pathname = pathname;
  return url.toString().replace(/\/$/u, '');
}

function parseTls(value: unknown): PowerDNSTlsConfig {
  if (value === undefined) return { rejectUnauthorized: true };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error("Vault PowerDNS configuration field 'tls' must be an object");
  }
  const tls = value as Record<string, unknown>;
  const rejectUnauthorized = optionalBoolean(tls.rejectUnauthorized, 'tls.rejectUnauthorized', true);
  const result: PowerDNSTlsConfig = { rejectUnauthorized };
  if (tls.ca !== undefined) result.ca = requiredString(tls.ca, 'tls.ca', 1024 * 1024);
  return result;
}

export function validatePowerDNSConfig(data: Record<string, unknown>): PowerDNSVaultConfig {
  const document = parseDocument(data);
  if (document.schema !== POWERDNS_SECRET_SCHEMA) {
    throw new Error(`Vault PowerDNS configuration must use schema '${POWERDNS_SECRET_SCHEMA}'`);
  }

  return {
    schema: POWERDNS_SECRET_SCHEMA,
    apiUrl: validateApiUrl(document.apiUrl, document.allowInsecureHttp),
    apiKey: requiredString(document.apiKey, 'apiKey'),
    serverId: requiredString(document.serverId ?? 'localhost', 'serverId', 256),
    timeoutMs: optionalInteger(document.timeoutMs, 'timeoutMs', 15_000, 500, 120_000),
    maxResponseBytes: optionalInteger(
      document.maxResponseBytes,
      'maxResponseBytes',
      10 * 1024 * 1024,
      1024,
      100 * 1024 * 1024,
    ),
    tls: parseTls(document.tls),
  };
}

export async function readPowerDNSConfig(
  ctx: CLIPluginContext,
  connection: PowerDNSConnectionProfile,
): Promise<PowerDNSVaultConfig> {
  const currentVaultProfile = ctx.getProfileName();
  if (currentVaultProfile !== connection.vaultProfile) {
    throw new Error(
      `PowerDNS connection belongs to ZnVault profile '${connection.vaultProfile}', but '${currentVaultProfile}' is active`,
    );
  }

  const alias = connection.secretAlias;
  const metadata = await ctx.client.get<SecretMetadata>(
    `/v1/secrets/alias/${encodeURIComponent(alias)}`,
  );
  if (
    typeof metadata?.id !== 'string' ||
    metadata.id.length === 0 ||
    metadata.alias !== alias ||
    typeof metadata.type !== 'string' ||
    metadata.type.length === 0
  ) {
    throw new Error(`Vault secret '${alias}' is not the expected PowerDNS configuration`);
  }

  const secret = await ctx.client.post<DecryptedSecret>(
    `/v1/secrets/${encodeURIComponent(metadata.id)}/decrypt?resolve=false`,
    {},
  );
  if (
    secret?.id !== metadata.id ||
    secret.alias !== alias ||
    secret.type !== metadata.type ||
    secret.data === null ||
    typeof secret.data !== 'object' ||
    Array.isArray(secret.data)
  ) {
    throw new Error(`Vault secret '${alias}' changed while it was being resolved`);
  }

  return validatePowerDNSConfig(secret.data);
}
