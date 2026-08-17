import type { Command } from 'commander';
import type { CLIPluginContext } from '../plugin-types.js';
import { encodePathSegment, serverPath } from '../powerdns-client.js';
import type { PowerDNSProfileStore } from '../profile-store.js';
import {
  absoluteDnsName,
  positiveInteger,
  printMutation,
  printResult,
  requireYes,
  withPowerDNS,
} from './helpers.js';

export function registerTopologyCommands(
  root: Command,
  ctx: CLIPluginContext,
  store: PowerDNSProfileStore,
): void {
  registerAutoprimary(root, ctx, store);
  registerViews(root, ctx, store);
  registerNetworks(root, ctx, store);
}

function registerAutoprimary(root: Command, ctx: CLIPluginContext, store: PowerDNSProfileStore): void {
  const command = root.command('autoprimary').description('Manage automatic secondary provisioning sources');

  command.command('list').description('List autoprimaries').action(async () => {
    await withPowerDNS(root, ctx, store, async (client) => {
      printResult(ctx, await client.get(serverPath(client, 'autoprimaries')));
    });
  });

  command
    .command('add <ip> <nameserver>')
    .description('Add an autoprimary')
    .option('--account <account>', 'Account label', '')
    .action(async (ip: string, nameserver: string, options: { account: string }) => {
      await withPowerDNS(root, ctx, store, async (client) => {
        printMutation(
          ctx,
          `Added autoprimary '${ip}'`,
          await client.post(serverPath(client, 'autoprimaries'), {
            ip,
            nameserver: absoluteDnsName(nameserver, 'Nameserver'),
            account: options.account,
          }),
        );
      });
    });

  command
    .command('remove <ip> <nameserver>')
    .description('Remove an autoprimary')
    .option('--yes', 'Confirm removal')
    .action(async (ip: string, nameserver: string, options: { yes?: boolean }) => {
      requireYes(options.yes, `Removing autoprimary '${ip}'`);
      await withPowerDNS(root, ctx, store, async (client) => {
        const path = serverPath(
          client,
          `autoprimaries/${encodePathSegment(ip)}/${encodePathSegment(absoluteDnsName(nameserver, 'Nameserver'))}`,
        );
        await client.delete(path);
        ctx.output.success(`Removed autoprimary '${ip}'`);
      });
    });
}

function registerViews(root: Command, ctx: CLIPluginContext, store: PowerDNSProfileStore): void {
  const view = root.command('view').description('Manage PowerDNS 5.x views and their zone variants');

  view.command('list').description('List views').action(async () => {
    await withPowerDNS(root, ctx, store, async (client) => {
      printResult(ctx, await client.get(serverPath(client, 'views')));
    });
  });

  view.command('show <view>').description('List zones in a view').action(async (name: string) => {
    await withPowerDNS(root, ctx, store, async (client) => {
      printResult(ctx, await client.get(serverPath(client, `views/${encodePathSegment(name)}`)));
    });
  });

  view
    .command('add-zone <view> <zone-variant>')
    .description('Add a zone variant to a view')
    .action(async (name: string, zoneVariant: string) => {
      await withPowerDNS(root, ctx, store, async (client) => {
        printMutation(
          ctx,
          `Added zone variant '${zoneVariant}' to view '${name}'`,
          await client.post(serverPath(client, `views/${encodePathSegment(name)}`), { name: zoneVariant }),
        );
      });
    });

  view
    .command('remove-zone <view> <zone-id>')
    .description('Remove a zone from a view')
    .option('--yes', 'Confirm removal')
    .action(async (name: string, zoneId: string, options: { yes?: boolean }) => {
      requireYes(options.yes, `Removing zone '${zoneId}' from view '${name}'`);
      await withPowerDNS(root, ctx, store, async (client) => {
        await client.delete(
          serverPath(client, `views/${encodePathSegment(name)}/${encodePathSegment(zoneId)}`),
        );
        ctx.output.success(`Removed zone '${zoneId}' from view '${name}'`);
      });
    });
}

function registerNetworks(root: Command, ctx: CLIPluginContext, store: PowerDNSProfileStore): void {
  const network = root.command('network').description('Associate client networks with PowerDNS views');

  network.command('list').description('List network-to-view mappings').action(async () => {
    await withPowerDNS(root, ctx, store, async (client) => {
      printResult(ctx, await client.get(serverPath(client, 'networks')));
    });
  });

  network
    .command('show <address> <prefix>')
    .description('Show the view for a network')
    .action(async (address: string, prefix: string) => {
      const length = positiveInteger(prefix, 'prefix', 0, address.includes(':') ? 128 : 32);
      await withPowerDNS(root, ctx, store, async (client) => {
        printResult(
          ctx,
          await client.get(serverPath(client, `networks/${encodePathSegment(address)}/${length}`)),
        );
      });
    });

  network
    .command('set <address> <prefix> <view>')
    .description('Set the view for a network')
    .option('--yes', 'Confirm mapping change')
    .action(async (address: string, prefix: string, view: string, options: { yes?: boolean }) => {
      requireYes(options.yes, `Changing view mapping for '${address}/${prefix}'`);
      const length = positiveInteger(prefix, 'prefix', 0, address.includes(':') ? 128 : 32);
      await withPowerDNS(root, ctx, store, async (client) => {
        printMutation(
          ctx,
          `Mapped '${address}/${length}' to view '${view}'`,
          await client.put(
            serverPath(client, `networks/${encodePathSegment(address)}/${length}`),
            { view },
          ),
        );
      });
    });
}
