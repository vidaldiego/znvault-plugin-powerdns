import { createServer, type RequestListener, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { PowerDNSClient, PowerDNSRequestError } from '../src/powerdns-client.js';
import { POWERDNS_SECRET_SCHEMA, type PowerDNSVaultConfig } from '../src/vault-config.js';

const servers: Server[] = [];

async function listen(
  handler: RequestListener,
): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Unexpected test server address');
  return { server, baseUrl: `http://127.0.0.1:${address.port}/api/v1` };
}

function config(apiUrl: string, overrides: Partial<PowerDNSVaultConfig> = {}): PowerDNSVaultConfig {
  return {
    schema: POWERDNS_SECRET_SCHEMA,
    apiUrl,
    apiKey: 'test-api-key',
    serverId: 'localhost',
    timeoutMs: 2_000,
    maxResponseBytes: 1024 * 1024,
    tls: { rejectUnauthorized: true },
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    server.close();
    await once(server, 'close');
  }));
});

describe('PowerDNSClient', () => {
  it('authenticates with X-API-Key and sends JSON to the configured API base', async () => {
    let receivedBody = '';
    const { baseUrl } = await listen((request, response) => {
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => { receivedBody += chunk; });
      request.on('end', () => {
        expect(request.headers['x-api-key']).toBe('test-api-key');
        expect(request.url).toBe('/api/v1/servers/localhost/zones/example.com.');
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{"ok":true}');
      });
    });

    const result = await new PowerDNSClient(config(baseUrl)).patch('/servers/localhost/zones/example.com.', {
      rrsets: [],
    });
    expect(result).toEqual({ ok: true });
    expect(JSON.parse(receivedBody)).toEqual({ rrsets: [] });
  });

  it('rejects absolute URLs, cross-origin paths, and redirects', async () => {
    const { baseUrl } = await listen((_request, response) => {
      response.writeHead(302, { Location: 'https://attacker.example/' });
      response.end();
    });
    const client = new PowerDNSClient(config(baseUrl));

    await expect(client.get('https://attacker.example/api/v1/servers')).rejects.toThrow('relative path');
    await expect(client.get('//attacker.example/api/v1/servers')).rejects.toThrow('relative path');
    await expect(client.get('/servers')).rejects.toThrow('redirects are not allowed');
  });

  it('does not include a potentially sensitive error response body in exceptions', async () => {
    const { baseUrl } = await listen((_request, response) => {
      response.writeHead(422, { 'Content-Type': 'application/json' });
      response.end('{"error":"invalid value SECRET-MATERIAL"}');
    });

    let thrown: unknown;
    try {
      await new PowerDNSClient(config(baseUrl)).post('/servers/localhost/tsigkeys', { key: 'SECRET-MATERIAL' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PowerDNSRequestError);
    expect(String(thrown)).not.toContain('SECRET-MATERIAL');
    expect(String(thrown)).toContain('HTTP 422');
  });

  it('enforces the configured response size limit', async () => {
    const { baseUrl } = await listen((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ value: 'x'.repeat(500) }));
    });
    await expect(new PowerDNSClient(config(baseUrl, { maxResponseBytes: 100 })).get('/servers'))
      .rejects.toThrow('size limit');
  });
});
