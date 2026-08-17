import type { Command } from 'commander';
import type { CLIPluginContext } from '../plugin-types.js';
import { encodePathSegment, serverPath } from '../powerdns-client.js';
import type { PowerDNSProfileStore } from '../profile-store.js';
import { positiveInteger, printMutation, printResult, requireYes, withPowerDNS } from './helpers.js';

export function registerServerCommands(
  root: Command,
  ctx: CLIPluginContext,
  store: PowerDNSProfileStore,
): void {
  const server = root.command('server').description('Inspect PowerDNS servers and statistics');

  server.command('list').description('List API servers').action(async () => {
    await withPowerDNS(root, ctx, store, async (client) => printResult(ctx, await client.get('/servers')));
  });

  server.command('show [server-id]').description('Show a server').action(async (serverId?: string) => {
    await withPowerDNS(root, ctx, store, async (client) => {
      const path = serverId === undefined ? serverPath(client) : `/servers/${encodePathSegment(serverId)}`;
      printResult(ctx, await client.get(path));
    });
  });

  server.command('statistics').alias('stats').description('Show server statistics').action(async () => {
    await withPowerDNS(root, ctx, store, async (client) => {
      printResult(ctx, await client.get(serverPath(client, 'statistics')));
    });
  });

  root
    .command('search <term>')
    .description('Search zones, records, and comments')
    .option('--max <count>', 'Maximum results', '100')
    .option('--object-type <type>', 'all, zone, record, or comment', 'all')
    .action(async (term: string, options: { max: string; objectType: string }) => {
      const allowed = new Set(['all', 'zone', 'record', 'comment']);
      if (!allowed.has(options.objectType)) throw new Error('--object-type must be all, zone, record, or comment');
      const maximum = positiveInteger(options.max, '--max', 1, 100_000);
      await withPowerDNS(root, ctx, store, async (client) => {
        const query = new URLSearchParams({ q: term, max: String(maximum), object_type: options.objectType });
        printResult(ctx, await client.get(`${serverPath(client, 'search-data')}?${query.toString()}`));
      });
    });

  const cache = root.command('cache').description('Manage PowerDNS caches');
  cache
    .command('flush <name>')
    .description('Flush cached data for a DNS name; use . to flush everything')
    .option('--yes', 'Confirm cache flush')
    .action(async (name: string, options: { yes?: boolean }) => {
      requireYes(options.yes, `Flushing cache entry '${name}'`);
      await withPowerDNS(root, ctx, store, async (client) => {
        const query = new URLSearchParams({ domain: name });
        const result = await client.put(`${serverPath(client, 'cache/flush')}?${query.toString()}`);
        printMutation(ctx, `Flushed PowerDNS cache entry '${name}'`, result);
      });
    });
}
