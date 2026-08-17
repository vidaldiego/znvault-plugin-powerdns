import { readFile } from 'node:fs/promises';
import type { Command } from 'commander';
import type { CLIPluginContext } from '../plugin-types.js';
import { PowerDNSClient } from '../powerdns-client.js';
import type { PowerDNSProfileStore } from '../profile-store.js';
import { readPowerDNSConfig } from '../vault-config.js';

const SENSITIVE_FIELDS = new Set([
  'api-key',
  'apikey',
  'api_key',
  'key',
  'password',
  'private-key',
  'private_key',
  'privatekey',
  'secret',
  'token',
]);

export interface ConnectionOptions {
  connection?: string;
}

export function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function positiveInteger(value: string, field: string, minimum = 1, maximum = 2_147_483_647): number {
  if (!/^\d+$/u.test(value)) throw new Error(`${field} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${field} must be from ${minimum} to ${maximum}`);
  }
  return parsed;
}

export function booleanValue(value: string, field: string): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${field} must be true or false`);
}

export function absoluteDnsName(value: string, field = 'DNS name'): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 255 || /[\s\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`${field} is invalid`);
  }
  return normalized.endsWith('.') ? normalized : `${normalized}.`;
}

export function rrType(value: string): string {
  const normalized = value.toUpperCase();
  if (!/^[A-Z][A-Z0-9-]{0,15}$/u.test(normalized)) throw new Error('RR type is invalid');
  return normalized;
}

export function requireYes(yes: boolean | undefined, operation: string): void {
  if (yes !== true) throw new Error(`${operation} requires --yes`);
}

export async function readJsonObject(path: string, maximumBytes = 5 * 1024 * 1024): Promise<Record<string, unknown>> {
  const raw = await readBoundedFile(path, maximumBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`File '${path}' is not valid JSON`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`File '${path}' must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

export async function readSecretText(path: string, maximumBytes = 1024 * 1024): Promise<string> {
  const raw = await readBoundedFile(path, maximumBytes);
  const value = raw.trim();
  if (value.length === 0) throw new Error(`File '${path}' is empty`);
  return value;
}

async function readBoundedFile(path: string, maximumBytes: number): Promise<string> {
  const data = await readFile(path);
  if (data.length > maximumBytes) throw new Error(`File '${path}' exceeds the ${maximumBytes}-byte limit`);
  return data.toString('utf8');
}

export function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item));
  if (value === null || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = SENSITIVE_FIELDS.has(key.toLowerCase()) ? '[REDACTED]' : redactSensitive(item);
  }
  return output;
}

export function printResult(ctx: CLIPluginContext, value: unknown, revealSecrets = false): void {
  ctx.output.json(revealSecrets ? value : redactSensitive(value));
}

export function printMutation(ctx: CLIPluginContext, action: string, result: unknown): void {
  if (result === null || result === undefined || result === '') ctx.output.success(action);
  else printResult(ctx, result);
}

export async function withPowerDNS<T>(
  root: Command,
  ctx: CLIPluginContext,
  store: PowerDNSProfileStore,
  operation: (client: PowerDNSClient, connectionName: string) => Promise<T>,
): Promise<T> {
  const options = root.opts<ConnectionOptions>();
  const resolved = await store.resolve(options.connection);
  const config = await readPowerDNSConfig(ctx, resolved.profile);
  return await operation(new PowerDNSClient(config), resolved.name);
}

export function zonePath(client: PowerDNSClient, zone: string, suffix = ''): string {
  const root = `/servers/${encodeURIComponent(client.serverId)}/zones/${encodeURIComponent(absoluteDnsName(zone, 'Zone'))}`;
  return suffix.length === 0 ? root : `${root}/${suffix.replace(/^\/+/, '')}`;
}
