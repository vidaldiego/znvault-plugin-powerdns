import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPowerDNSPlugin } from '../src/cli.js';
import { registerPowerDNSCommands } from '../src/commands/index.js';
import type { CLIPluginContext } from '../src/plugin-types.js';
import { PowerDNSProfileStore } from '../src/profile-store.js';
import { POWERDNS_SECRET_SCHEMA } from '../src/vault-config.js';

const directories: string[] = [];
const servers: Server[] = [];

function output() {
  return {
    json: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function context(apiUrl = 'https://dns-api.example.com/api/v1'): CLIPluginContext {
  return {
    client: {
      get: vi.fn(async () => (
        { id: 'id-1', alias: 'dns/config', type: 'setting' }
      )) as unknown as CLIPluginContext['client']['get'],
      post: vi.fn(async () => ({
          id: 'id-1',
          alias: 'dns/config',
          type: 'setting',
          data: {
            schema: POWERDNS_SECRET_SCHEMA,
            apiUrl,
            apiKey: 'credential-only-in-vault',
            allowInsecureHttp: apiUrl.startsWith('http:'),
          },
        })) as unknown as CLIPluginContext['client']['post'],
    },
    output: output(),
    getConfig: () => ({}),
    getProfileName: () => 'operators',
    isPlainMode: () => true,
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
  await Promise.all(servers.splice(0).map(async (server) => {
    server.close();
    await once(server, 'close');
  }));
});

describe('PowerDNS CLI commands', () => {
  it('registers the plugin factory and all management groups', () => {
    const program = new Command();
    createPowerDNSPlugin().registerCommands(program, context());
    const powerdns = program.commands.find((command) => command.name() === 'powerdns');
    expect(powerdns).toBeDefined();
    expect(powerdns?.commands.map((command) => command.name())).toEqual(expect.arrayContaining([
      'profile',
      'server',
      'zone',
      'record',
      'metadata',
      'cryptokey',
      'tsig',
      'autoprimary',
      'view',
      'network',
      'api',
    ]));
  });

  it('never exposes an API key option in the command tree', () => {
    const program = new Command();
    createPowerDNSPlugin().registerCommands(program, context());
    const visit = (command: Command): string[] => [
      ...command.options.flatMap((option) => [option.long ?? '', option.short ?? '']),
      ...command.commands.flatMap(visit),
    ];
    expect(visit(program).join(' ')).not.toMatch(/api[-_]?key/iu);
  });

  it('adds and lists local connection references without decrypting them', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'znvault-powerdns-command-'));
    directories.push(directory);
    const store = new PowerDNSProfileStore(join(directory, 'profiles.json'));
    const ctx = context();
    const program = new Command().exitOverride();
    const root = program.command('powerdns').option('-c, --connection <name>');
    registerPowerDNSCommands(root, ctx, store);

    await program.parseAsync([
      'node',
      'test',
      'powerdns',
      'profile',
      'add',
      'primary',
      '--secret-alias',
      'dns/config',
      '--activate',
    ]);
    expect(ctx.client.get).not.toHaveBeenCalled();

    await program.parseAsync(['node', 'test', 'powerdns', 'profile', 'list']);
    expect(ctx.output.json).toHaveBeenLastCalledWith([
      {
        name: 'primary',
        active: true,
        vaultProfile: 'operators',
        secretAlias: 'dns/config',
      },
    ]);
  });

  it('resolves the API credential from Vault and applies an RRset patch', async () => {
    let body = '';
    const server = createServer((request, response) => {
      expect(request.method).toBe('PATCH');
      expect(request.headers['x-api-key']).toBe('credential-only-in-vault');
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => { body += chunk; });
      request.on('end', () => {
        response.writeHead(204);
        response.end();
      });
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Unexpected test server address');

    const directory = await mkdtemp(join(tmpdir(), 'znvault-powerdns-command-'));
    directories.push(directory);
    const store = new PowerDNSProfileStore(join(directory, 'profiles.json'));
    await store.add('primary', { vaultProfile: 'operators', secretAlias: 'dns/config' });
    const ctx = context(`http://127.0.0.1:${address.port}/api/v1`);
    const program = new Command().exitOverride();
    const root = program.command('powerdns').option('-c, --connection <name>');
    registerPowerDNSCommands(root, ctx, store);

    await program.parseAsync([
      'node',
      'test',
      'powerdns',
      'record',
      'replace',
      'example.com',
      'www.example.com',
      'A',
      '--ttl',
      '300',
      '--content',
      '192.0.2.20',
      '--yes',
    ]);

    expect(JSON.parse(body)).toEqual({
      rrsets: [{
        name: 'www.example.com.',
        type: 'A',
        changetype: 'REPLACE',
        records: [{ content: '192.0.2.20', disabled: false }],
        ttl: 300,
      }],
    });
    expect(ctx.output.success).toHaveBeenCalledWith("Replaced A RRset 'www.example.com.'");
  });
});
