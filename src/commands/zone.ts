import { writeFile } from 'node:fs/promises';
import type { Command } from 'commander';
import type { CLIPluginContext } from '../plugin-types.js';
import { serverPath } from '../powerdns-client.js';
import type { PowerDNSProfileStore } from '../profile-store.js';
import {
  absoluteDnsName,
  collect,
  printMutation,
  printResult,
  readJsonObject,
  requireYes,
  withPowerDNS,
  zonePath,
} from './helpers.js';

const ZONE_KINDS = new Set(['Native', 'Master', 'Slave', 'Producer', 'Consumer']);

interface ZoneCreateOptions {
  kind: string;
  nameserver: string[];
  master: string[];
  account?: string;
  catalog?: string;
  dnssec?: boolean;
  from?: string;
}

function validateKind(value: string): string {
  if (!ZONE_KINDS.has(value)) {
    throw new Error('--kind must be Native, Master, Slave, Producer, or Consumer');
  }
  return value;
}

export function registerZoneCommands(
  root: Command,
  ctx: CLIPluginContext,
  store: PowerDNSProfileStore,
): void {
  const zone = root.command('zone').description('Create, inspect, update, and operate zones');

  zone
    .command('list')
    .description('List zones')
    .option('--name <zone>', 'Filter by zone name')
    .action(async (options: { name?: string }) => {
      await withPowerDNS(root, ctx, store, async (client) => {
        const query = options.name === undefined
          ? ''
          : `?${new URLSearchParams({ zone: absoluteDnsName(options.name, 'Zone') }).toString()}`;
        printResult(ctx, await client.get(`${serverPath(client, 'zones')}${query}`));
      });
    });

  zone
    .command('show <zone>')
    .description('Show a zone and optionally filter its RRsets')
    .option('--without-rrsets', 'Do not include RRsets')
    .option('--record-count', 'Include record count')
    .option('--rrset-name <name>', 'Limit output to one absolute record name')
    .option('--rrset-type <type>', 'Limit output to one record type; requires --rrset-name')
    .option('--exclude-disabled', 'Exclude disabled records')
    .action(async (
      zoneName: string,
      options: {
        withoutRrsets?: boolean;
        recordCount?: boolean;
        rrsetName?: string;
        rrsetType?: string;
        excludeDisabled?: boolean;
      },
    ) => {
      if (options.rrsetType !== undefined && options.rrsetName === undefined) {
        throw new Error('--rrset-type requires --rrset-name');
      }
      await withPowerDNS(root, ctx, store, async (client) => {
        const query = new URLSearchParams({
          rrsets: String(options.withoutRrsets !== true),
          record_count: String(options.recordCount === true),
          include_disabled: String(options.excludeDisabled !== true),
        });
        if (options.rrsetName !== undefined) query.set('rrset_name', absoluteDnsName(options.rrsetName));
        if (options.rrsetType !== undefined) query.set('rrset_type', options.rrsetType.toUpperCase());
        printResult(ctx, await client.get(`${zonePath(client, zoneName)}?${query.toString()}`));
      });
    });

  zone
    .command('create <zone>')
    .description('Create a zone from options or a JSON file')
    .option('--kind <kind>', 'Zone kind', 'Native')
    .option('--nameserver <name>', 'Authoritative nameserver; repeatable', collect, [])
    .option('--master <address>', 'Primary address for secondary zones; repeatable', collect, [])
    .option('--account <account>', 'PowerDNS account value')
    .option('--catalog <zone>', 'Catalog zone')
    .option('--dnssec', 'Enable DNSSEC')
    .option('--from <file>', 'Read the complete zone object from JSON')
    .action(async (zoneName: string, options: ZoneCreateOptions) => {
      let body: Record<string, unknown>;
      if (options.from !== undefined) {
        body = await readJsonObject(options.from);
        if (body.name === undefined) body.name = absoluteDnsName(zoneName, 'Zone');
      } else {
        body = {
          name: absoluteDnsName(zoneName, 'Zone'),
          kind: validateKind(options.kind),
          masters: options.master,
          nameservers: options.nameserver.map((value) => absoluteDnsName(value, 'Nameserver')),
        };
        if (options.account !== undefined) body.account = options.account;
        if (options.catalog !== undefined) body.catalog = absoluteDnsName(options.catalog, 'Catalog zone');
        if (options.dnssec === true) body.dnssec = true;
      }
      await withPowerDNS(root, ctx, store, async (client) => {
        printResult(ctx, await client.post(serverPath(client, 'zones'), body));
      });
    });

  zone
    .command('update <zone>')
    .description('Update zone settings from a JSON object')
    .requiredOption('--from <file>', 'JSON object containing mutable zone fields')
    .option('--yes', 'Confirm zone settings update')
    .action(async (zoneName: string, options: { from: string; yes?: boolean }) => {
      requireYes(options.yes, `Updating zone '${zoneName}'`);
      const body = await readJsonObject(options.from);
      await withPowerDNS(root, ctx, store, async (client) => {
        printMutation(ctx, `Updated zone '${absoluteDnsName(zoneName)}'`, await client.put(zonePath(client, zoneName), body));
      });
    });

  zone
    .command('delete <zone>')
    .description('Delete a zone, its RRsets, metadata, and keys')
    .option('--yes', 'Confirm permanent deletion')
    .action(async (zoneName: string, options: { yes?: boolean }) => {
      requireYes(options.yes, `Deleting zone '${zoneName}'`);
      await withPowerDNS(root, ctx, store, async (client) => {
        await client.delete(zonePath(client, zoneName));
        ctx.output.success(`Deleted zone '${absoluteDnsName(zoneName)}'`);
      });
    });

  zone
    .command('export <zone>')
    .description('Export a zone in AXFR format')
    .option('--output <file>', 'Write the export to a file instead of stdout')
    .action(async (zoneName: string, options: { output?: string }) => {
      await withPowerDNS(root, ctx, store, async (client) => {
        const result = await client.get<unknown>(zonePath(client, zoneName, 'export'));
        const content = typeof result === 'string'
          ? result
          : (result !== null && typeof result === 'object' && 'zone' in result && typeof result.zone === 'string'
              ? result.zone
              : JSON.stringify(result, null, 2));
        if (options.output !== undefined) {
          await writeFile(options.output, `${content.replace(/\n?$/u, '\n')}`, { mode: 0o600 });
          ctx.output.success(`Exported zone '${absoluteDnsName(zoneName)}' to '${options.output}'`);
        } else {
          process.stdout.write(content.endsWith('\n') ? content : `${content}\n`);
        }
      });
    });

  zone
    .command('notify <zone>')
    .description('Send DNS NOTIFY for a zone')
    .option('--yes', 'Confirm notification')
    .action(async (zoneName: string, options: { yes?: boolean }) => {
      requireYes(options.yes, `Sending NOTIFY for '${zoneName}'`);
      await withPowerDNS(root, ctx, store, async (client) => {
        printMutation(ctx, `Sent NOTIFY for '${absoluteDnsName(zoneName)}'`, await client.put(zonePath(client, zoneName, 'notify')));
      });
    });

  zone
    .command('rectify <zone>')
    .description('Rectify DNSSEC ordering and auth data')
    .option('--yes', 'Confirm rectification')
    .action(async (zoneName: string, options: { yes?: boolean }) => {
      requireYes(options.yes, `Rectifying zone '${zoneName}'`);
      await withPowerDNS(root, ctx, store, async (client) => {
        printMutation(ctx, `Rectified zone '${absoluteDnsName(zoneName)}'`, await client.put(zonePath(client, zoneName, 'rectify')));
      });
    });

  zone
    .command('retrieve-axfr <zone>')
    .description('Retrieve a secondary zone from its primary')
    .option('--primary <address>', 'Use a specific primary server')
    .option('--yes', 'Confirm AXFR retrieval')
    .action(async (zoneName: string, options: { primary?: string; yes?: boolean }) => {
      requireYes(options.yes, `Retrieving AXFR for '${zoneName}'`);
      const body = options.primary === undefined ? undefined : { primary: options.primary };
      await withPowerDNS(root, ctx, store, async (client) => {
        printMutation(
          ctx,
          `Retrieved AXFR for '${absoluteDnsName(zoneName)}'`,
          await client.put(zonePath(client, zoneName, 'axfr-retrieve'), body),
        );
      });
    });
}
