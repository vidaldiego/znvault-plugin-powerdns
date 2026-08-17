import { describe, expect, it, vi } from 'vitest';
import type { CLIPluginContext } from '../src/plugin-types.js';
import { POWERDNS_SECRET_SCHEMA, readPowerDNSConfig, validatePowerDNSConfig } from '../src/vault-config.js';

function context(data: Record<string, unknown>, profile = 'operators'): CLIPluginContext {
  return {
    client: {
      get: vi.fn(async () => (
        { id: 'secret-id', alias: 'dns/config', type: 'setting' }
      )) as unknown as CLIPluginContext['client']['get'],
      post: vi.fn(async () => (
        { id: 'secret-id', alias: 'dns/config', type: 'setting', data }
      )) as unknown as CLIPluginContext['client']['post'],
    },
    output: {
      json: vi.fn(),
      success: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    getConfig: () => ({}),
    getProfileName: () => profile,
    isPlainMode: () => true,
  };
}

const secureDocument = {
  schema: POWERDNS_SECRET_SCHEMA,
  apiUrl: 'https://dns-api.example.com/api/v1',
  apiKey: 'never-print-this',
  serverId: 'localhost',
};

describe('PowerDNS Vault configuration', () => {
  it('resolves metadata and decrypts a direct setting without tenant parameters', async () => {
    const ctx = context(secureDocument);
    const result = await readPowerDNSConfig(ctx, {
      vaultProfile: 'operators',
      secretAlias: 'dns/config',
    });

    expect(result.apiUrl).toBe('https://dns-api.example.com/api/v1');
    expect(result.tls.rejectUnauthorized).toBe(true);
    expect(ctx.client.get).toHaveBeenCalledWith('/v1/secrets/alias/dns%2Fconfig');
    expect(ctx.client.post).toHaveBeenCalledWith('/v1/secrets/secret-id/decrypt?resolve=false', {});
  });

  it('accepts an opaque text secret containing the schema document', () => {
    const result = validatePowerDNSConfig({ text: JSON.stringify(secureDocument) });
    expect(result.apiKey).toBe('never-print-this');
  });

  it('refuses to use a connection from another ZnVault profile before decryption', async () => {
    const ctx = context(secureDocument, 'personal');
    await expect(
      readPowerDNSConfig(ctx, { vaultProfile: 'operators', secretAlias: 'dns/config' }),
    ).rejects.toThrow("belongs to ZnVault profile 'operators'");
    expect(ctx.client.get).not.toHaveBeenCalled();
  });

  it('requires HTTPS unless an HTTP endpoint is explicitly allowed in Vault', () => {
    expect(() => validatePowerDNSConfig({ ...secureDocument, apiUrl: 'http://127.0.0.1:8081/api/v1' }))
      .toThrow("allowInsecureHttp: true");
    expect(
      validatePowerDNSConfig({
        ...secureDocument,
        apiUrl: 'http://127.0.0.1:8081/api/v1',
        allowInsecureHttp: true,
      }).apiUrl,
    ).toBe('http://127.0.0.1:8081/api/v1');
  });

  it('rejects URL credentials and the wrong schema', () => {
    expect(() => validatePowerDNSConfig({ ...secureDocument, apiUrl: 'https://user:pass@example.com/api/v1' }))
      .toThrow('cannot contain credentials');
    expect(() => validatePowerDNSConfig({ ...secureDocument, schema: 'unexpected/v1' }))
      .toThrow('must use schema');
  });
});
