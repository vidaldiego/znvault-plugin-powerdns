import type { Command } from 'commander';
import type { CLIPluginContext } from '../plugin-types.js';
import type { PowerDNSProfileStore } from '../profile-store.js';
import {
  absoluteDnsName,
  collect,
  positiveInteger,
  printMutation,
  printResult,
  readJsonObject,
  requireYes,
  rrType,
  withPowerDNS,
  zonePath,
} from './helpers.js';

interface RecordOptions {
  content: string[];
  disabled?: boolean;
  ttl?: string;
  comment: string[];
  account?: string;
  yes?: boolean;
}

function rrsetBody(
  changeType: 'REPLACE' | 'EXTEND' | 'PRUNE' | 'DELETE',
  name: string,
  type: string,
  options: RecordOptions,
): Record<string, unknown> {
  const rrset: Record<string, unknown> = {
    name: absoluteDnsName(name, 'Record name'),
    type: rrType(type),
    changetype: changeType,
  };
  if (changeType !== 'DELETE') {
    if (options.content.length === 0) throw new Error('At least one --content value is required');
    rrset.records = options.content.map((content) => ({ content, disabled: options.disabled === true }));
  }
  if (options.ttl !== undefined) rrset.ttl = positiveInteger(options.ttl, '--ttl', 0);
  if (options.comment.length > 0) {
    rrset.comments = options.comment.map((content) => ({
      content,
      account: options.account ?? '',
      modified_at: Math.floor(Date.now() / 1000),
    }));
  }
  return { rrsets: [rrset] };
}

function addRecordOptions(command: Command, ttlRequired: boolean): Command {
  command.option('--content <value>', 'Record content; repeatable', collect, []);
  if (ttlRequired) command.requiredOption('--ttl <seconds>', 'RRset TTL');
  else command.option('--ttl <seconds>', 'RRset TTL');
  return command
    .option('--disabled', 'Create disabled records')
    .option('--comment <text>', 'RRset comment; repeatable', collect, [])
    .option('--account <name>', 'Comment account');
}

export function registerRecordCommands(
  root: Command,
  ctx: CLIPluginContext,
  store: PowerDNSProfileStore,
): void {
  const record = root.command('record').alias('rrset').description('Manage DNS RRsets and comments');

  record
    .command('list <zone>')
    .description('List RRsets in a zone')
    .option('--name <name>', 'Filter by absolute record name')
    .option('--type <type>', 'Filter by type; requires --name')
    .action(async (zoneName: string, options: { name?: string; type?: string }) => {
      if (options.type !== undefined && options.name === undefined) throw new Error('--type requires --name');
      await withPowerDNS(root, ctx, store, async (client) => {
        const query = new URLSearchParams({ rrsets: 'true' });
        if (options.name !== undefined) query.set('rrset_name', absoluteDnsName(options.name));
        if (options.type !== undefined) query.set('rrset_type', rrType(options.type));
        const zone = await client.get<Record<string, unknown>>(`${zonePath(client, zoneName)}?${query.toString()}`);
        printResult(ctx, zone.rrsets ?? []);
      });
    });

  addRecordOptions(
    record.command('replace <zone> <name> <type>').description('Replace an entire RRset'),
    true,
  )
    .option('--yes', 'Confirm replacement')
    .action(async (zoneName: string, name: string, type: string, options: RecordOptions) => {
      requireYes(options.yes, `Replacing ${type} RRset '${name}'`);
      const body = rrsetBody('REPLACE', name, type, options);
      await withPowerDNS(root, ctx, store, async (client) => {
        printMutation(ctx, `Replaced ${rrType(type)} RRset '${absoluteDnsName(name)}'`, await client.patch(zonePath(client, zoneName), body));
      });
    });

  addRecordOptions(
    record.command('extend <zone> <name> <type>').description('Add records without replacing an RRset'),
    false,
  ).action(async (zoneName: string, name: string, type: string, options: RecordOptions) => {
    const body = rrsetBody('EXTEND', name, type, options);
    await withPowerDNS(root, ctx, store, async (client) => {
      printMutation(ctx, `Extended ${rrType(type)} RRset '${absoluteDnsName(name)}'`, await client.patch(zonePath(client, zoneName), body));
    });
  });

  addRecordOptions(
    record.command('prune <zone> <name> <type>').description('Remove matching records from an RRset'),
    false,
  )
    .option('--yes', 'Confirm record removal')
    .action(async (zoneName: string, name: string, type: string, options: RecordOptions) => {
      requireYes(options.yes, `Pruning ${type} RRset '${name}'`);
      const body = rrsetBody('PRUNE', name, type, options);
      await withPowerDNS(root, ctx, store, async (client) => {
        printMutation(ctx, `Pruned ${rrType(type)} RRset '${absoluteDnsName(name)}'`, await client.patch(zonePath(client, zoneName), body));
      });
    });

  record
    .command('delete <zone> <name> <type>')
    .description('Delete an entire RRset')
    .option('--yes', 'Confirm RRset deletion')
    .action(async (zoneName: string, name: string, type: string, options: { yes?: boolean }) => {
      requireYes(options.yes, `Deleting ${type} RRset '${name}'`);
      const body = rrsetBody('DELETE', name, type, { content: [], comment: [] });
      await withPowerDNS(root, ctx, store, async (client) => {
        printMutation(ctx, `Deleted ${rrType(type)} RRset '${absoluteDnsName(name)}'`, await client.patch(zonePath(client, zoneName), body));
      });
    });

  record
    .command('patch <zone>')
    .description('Apply a complete PowerDNS RRset patch from JSON')
    .requiredOption('--from <file>', 'JSON object containing an rrsets array')
    .option('--yes', 'Confirm patch')
    .action(async (zoneName: string, options: { from: string; yes?: boolean }) => {
      requireYes(options.yes, `Patching RRsets in zone '${zoneName}'`);
      const body = await readJsonObject(options.from);
      if (!Array.isArray(body.rrsets)) throw new Error("Patch file must contain an 'rrsets' array");
      await withPowerDNS(root, ctx, store, async (client) => {
        printMutation(ctx, `Patched RRsets in zone '${absoluteDnsName(zoneName)}'`, await client.patch(zonePath(client, zoneName), body));
      });
    });
}
