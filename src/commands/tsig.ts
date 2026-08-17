import type { Command } from 'commander';
import type { CLIPluginContext } from '../plugin-types.js';
import { encodePathSegment, serverPath } from '../powerdns-client.js';
import type { PowerDNSProfileStore } from '../profile-store.js';
import { printResult, readSecretText, requireYes, withPowerDNS } from './helpers.js';

function revealAllowed(options: { reveal?: boolean; yes?: boolean }): boolean {
  if (options.reveal === true) requireYes(options.yes, 'Revealing TSIG key material');
  return options.reveal === true;
}

export function registerTsigCommands(
  root: Command,
  ctx: CLIPluginContext,
  store: PowerDNSProfileStore,
): void {
  const tsig = root.command('tsig').description('Manage TSIG keys');

  tsig.command('list').description('List TSIG keys without key material').action(async () => {
    await withPowerDNS(root, ctx, store, async (client) => {
      printResult(ctx, await client.get(serverPath(client, 'tsigkeys')));
    });
  });

  tsig
    .command('show <id>')
    .description('Show one TSIG key; key material is redacted by default')
    .option('--reveal', 'Print TSIG key material')
    .option('--yes', 'Confirm revealing key material')
    .action(async (id: string, options: { reveal?: boolean; yes?: boolean }) => {
      const reveal = revealAllowed(options);
      await withPowerDNS(root, ctx, store, async (client) => {
        printResult(ctx, await client.get(serverPath(client, `tsigkeys/${encodePathSegment(id)}`)), reveal);
      });
    });

  tsig
    .command('create <name>')
    .description('Generate a TSIG key or import key material from a file')
    .option('--algorithm <algorithm>', 'TSIG algorithm', 'hmac-sha256')
    .option('--key-file <file>', 'Read Base64 key material from a file')
    .option('--reveal', 'Print returned TSIG key material')
    .option('--yes', 'Confirm revealing key material')
    .action(async (
      name: string,
      options: { algorithm: string; keyFile?: string; reveal?: boolean; yes?: boolean },
    ) => {
      const reveal = revealAllowed(options);
      const body: Record<string, unknown> = { name, algorithm: options.algorithm };
      if (options.keyFile !== undefined) body.key = await readSecretText(options.keyFile);
      await withPowerDNS(root, ctx, store, async (client) => {
        printResult(ctx, await client.post(serverPath(client, 'tsigkeys'), body), reveal);
      });
    });

  tsig
    .command('update <id>')
    .description('Update a TSIG key')
    .option('--name <name>', 'New key name')
    .option('--algorithm <algorithm>', 'New algorithm')
    .option('--key-file <file>', 'Read replacement Base64 key material from a file')
    .option('--reveal', 'Print returned TSIG key material')
    .option('--yes', 'Confirm update and any key reveal')
    .action(async (
      id: string,
      options: { name?: string; algorithm?: string; keyFile?: string; reveal?: boolean; yes?: boolean },
    ) => {
      requireYes(options.yes, `Updating TSIG key '${id}'`);
      const body: Record<string, unknown> = {};
      if (options.name !== undefined) body.name = options.name;
      if (options.algorithm !== undefined) body.algorithm = options.algorithm;
      if (options.keyFile !== undefined) body.key = await readSecretText(options.keyFile);
      if (Object.keys(body).length === 0) throw new Error('Specify --name, --algorithm, or --key-file');
      await withPowerDNS(root, ctx, store, async (client) => {
        printResult(
          ctx,
          await client.put(serverPath(client, `tsigkeys/${encodePathSegment(id)}`), body),
          options.reveal === true,
        );
      });
    });

  tsig
    .command('delete <id>')
    .description('Delete a TSIG key')
    .option('--yes', 'Confirm permanent key deletion')
    .action(async (id: string, options: { yes?: boolean }) => {
      requireYes(options.yes, `Deleting TSIG key '${id}'`);
      await withPowerDNS(root, ctx, store, async (client) => {
        await client.delete(serverPath(client, `tsigkeys/${encodePathSegment(id)}`));
        ctx.output.success(`Deleted TSIG key '${id}'`);
      });
    });
}
