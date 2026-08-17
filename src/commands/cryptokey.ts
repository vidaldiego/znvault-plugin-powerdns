import type { Command } from 'commander';
import type { CLIPluginContext } from '../plugin-types.js';
import { encodePathSegment } from '../powerdns-client.js';
import type { PowerDNSProfileStore } from '../profile-store.js';
import {
  booleanValue,
  positiveInteger,
  printMutation,
  printResult,
  readSecretText,
  requireYes,
  withPowerDNS,
  zonePath,
} from './helpers.js';

interface KeyCreateOptions {
  keytype: string;
  active?: boolean;
  unpublished?: boolean;
  algorithm?: string;
  bits?: string;
  contentFile?: string;
  reveal?: boolean;
  yes?: boolean;
}

function keyType(value: string): string {
  const normalized = value.toLowerCase();
  if (!new Set(['ksk', 'zsk', 'csk']).has(normalized)) throw new Error('--keytype must be ksk, zsk, or csk');
  return normalized;
}

function requireRevealConfirmation(options: { reveal?: boolean; yes?: boolean }): void {
  if (options.reveal === true) requireYes(options.yes, 'Revealing private key material');
}

export function registerCryptokeyCommands(
  root: Command,
  ctx: CLIPluginContext,
  store: PowerDNSProfileStore,
): void {
  const key = root.command('cryptokey').alias('dnssec-key').description('Manage DNSSEC cryptographic keys');

  key.command('list <zone>').description('List DNSSEC keys without private material').action(async (zone: string) => {
    await withPowerDNS(root, ctx, store, async (client) => {
      printResult(ctx, await client.get(zonePath(client, zone, 'cryptokeys')));
    });
  });

  key
    .command('show <zone> <id>')
    .description('Show a DNSSEC key; private material is redacted by default')
    .option('--reveal', 'Print private key material')
    .option('--yes', 'Confirm revealing private key material')
    .action(async (zone: string, id: string, options: { reveal?: boolean; yes?: boolean }) => {
      requireRevealConfirmation(options);
      await withPowerDNS(root, ctx, store, async (client) => {
        const result = await client.get(zonePath(client, zone, `cryptokeys/${encodePathSegment(id)}`));
        printResult(ctx, result, options.reveal === true);
      });
    });

  key
    .command('create <zone>')
    .description('Generate or import a DNSSEC key')
    .option('--keytype <type>', 'ksk, zsk, or csk', 'ksk')
    .option('--active', 'Activate the key immediately')
    .option('--unpublished', 'Do not publish the DNSKEY')
    .option('--algorithm <algorithm>', 'Algorithm for generated keys')
    .option('--bits <bits>', 'Key size for generated keys')
    .option('--content-file <file>', 'Import an ISC private key from a file')
    .option('--reveal', 'Print returned private key material')
    .option('--yes', 'Confirm revealing private key material')
    .action(async (zone: string, options: KeyCreateOptions) => {
      requireRevealConfirmation(options);
      const body: Record<string, unknown> = {
        keytype: keyType(options.keytype),
        active: options.active === true,
        published: options.unpublished !== true,
      };
      if (options.algorithm !== undefined) body.algorithm = options.algorithm;
      if (options.bits !== undefined) body.bits = positiveInteger(options.bits, '--bits', 1, 65_536);
      if (options.contentFile !== undefined) body.content = await readSecretText(options.contentFile);
      await withPowerDNS(root, ctx, store, async (client) => {
        printResult(ctx, await client.post(zonePath(client, zone, 'cryptokeys'), body), options.reveal === true);
      });
    });

  key
    .command('update <zone> <id>')
    .description('Change active or published state of a DNSSEC key')
    .option('--active <true|false>', 'Set active state')
    .option('--published <true|false>', 'Set DNSKEY publication state')
    .option('--yes', 'Confirm key state update')
    .action(async (
      zone: string,
      id: string,
      options: { active?: string; published?: string; yes?: boolean },
    ) => {
      requireYes(options.yes, `Updating DNSSEC key '${id}'`);
      const body: Record<string, unknown> = {};
      if (options.active !== undefined) body.active = booleanValue(options.active, '--active');
      if (options.published !== undefined) body.published = booleanValue(options.published, '--published');
      if (Object.keys(body).length === 0) throw new Error('Specify --active or --published');
      await withPowerDNS(root, ctx, store, async (client) => {
        printMutation(
          ctx,
          `Updated DNSSEC key '${id}'`,
          await client.put(zonePath(client, zone, `cryptokeys/${encodePathSegment(id)}`), body),
        );
      });
    });

  key
    .command('delete <zone> <id>')
    .description('Delete a DNSSEC key')
    .option('--yes', 'Confirm permanent key deletion')
    .action(async (zone: string, id: string, options: { yes?: boolean }) => {
      requireYes(options.yes, `Deleting DNSSEC key '${id}'`);
      await withPowerDNS(root, ctx, store, async (client) => {
        await client.delete(zonePath(client, zone, `cryptokeys/${encodePathSegment(id)}`));
        ctx.output.success(`Deleted DNSSEC key '${id}'`);
      });
    });
}
