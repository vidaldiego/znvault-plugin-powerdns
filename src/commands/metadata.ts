import type { Command } from 'commander';
import type { CLIPluginContext } from '../plugin-types.js';
import { encodePathSegment } from '../powerdns-client.js';
import type { PowerDNSProfileStore } from '../profile-store.js';
import { collect, printMutation, printResult, requireYes, withPowerDNS, zonePath } from './helpers.js';

export function registerMetadataCommands(
  root: Command,
  ctx: CLIPluginContext,
  store: PowerDNSProfileStore,
): void {
  const metadata = root.command('metadata').description('Manage per-zone PowerDNS metadata');

  metadata.command('list <zone>').description('List all metadata for a zone').action(async (zone: string) => {
    await withPowerDNS(root, ctx, store, async (client) => {
      printResult(ctx, await client.get(zonePath(client, zone, 'metadata')));
    });
  });

  metadata.command('get <zone> <kind>').description('Get one metadata kind').action(async (zone: string, kind: string) => {
    await withPowerDNS(root, ctx, store, async (client) => {
      printResult(ctx, await client.get(zonePath(client, zone, `metadata/${encodePathSegment(kind)}`)));
    });
  });

  metadata
    .command('set <zone> <kind>')
    .description('Replace all values of one metadata kind')
    .option('--value <value>', 'Metadata value; repeatable', collect, [])
    .option('--yes', 'Confirm replacement')
    .action(async (zone: string, kind: string, options: { value: string[]; yes?: boolean }) => {
      requireYes(options.yes, `Replacing metadata '${kind}'`);
      await withPowerDNS(root, ctx, store, async (client) => {
        printResult(
          ctx,
          await client.put(zonePath(client, zone, `metadata/${encodePathSegment(kind)}`), {
            kind,
            metadata: options.value,
          }),
        );
      });
    });

  metadata
    .command('add <zone> <kind>')
    .description('Add metadata entries without replacing the existing kind')
    .requiredOption('--value <value>', 'Metadata value; repeatable', collect, [])
    .action(async (zone: string, kind: string, options: { value: string[] }) => {
      await withPowerDNS(root, ctx, store, async (client) => {
        printMutation(
          ctx,
          `Added metadata '${kind}'`,
          await client.post(zonePath(client, zone, 'metadata'), { kind, metadata: options.value }),
        );
      });
    });

  metadata
    .command('delete <zone> <kind>')
    .description('Delete every value of one metadata kind')
    .option('--yes', 'Confirm metadata deletion')
    .action(async (zone: string, kind: string, options: { yes?: boolean }) => {
      requireYes(options.yes, `Deleting metadata '${kind}'`);
      await withPowerDNS(root, ctx, store, async (client) => {
        await client.delete(zonePath(client, zone, `metadata/${encodePathSegment(kind)}`));
        ctx.output.success(`Deleted metadata '${kind}'`);
      });
    });
}
