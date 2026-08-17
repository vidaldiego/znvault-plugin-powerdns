import type { Command } from 'commander';
import type { CLIPluginContext } from '../plugin-types.js';
import type { PowerDNSProfileStore } from '../profile-store.js';
import { PowerDNSClient, serverPath } from '../powerdns-client.js';
import { readPowerDNSConfig } from '../vault-config.js';
import { printResult, requireYes } from './helpers.js';

interface AddOptions {
  secretAlias: string;
  activate?: boolean;
  force?: boolean;
}

export function registerProfileCommands(
  root: Command,
  ctx: CLIPluginContext,
  store: PowerDNSProfileStore,
): void {
  const profile = root.command('profile').description('Manage local connection names backed by Vault secrets');

  profile
    .command('add <name>')
    .description('Add a connection without storing credentials locally')
    .requiredOption('--secret-alias <alias>', 'Alias of the PowerDNS configuration secret in ZnVault')
    .option('--activate', 'Make this the active PowerDNS connection')
    .option('--force', 'Replace an existing connection with the same name')
    .action(async (name: string, options: AddOptions) => {
      const result = await store.add(
        name,
        { vaultProfile: ctx.getProfileName(), secretAlias: options.secretAlias },
        { force: options.force === true, activate: options.activate === true },
      );
      printResult(ctx, { name, active: result.active === name, ...result.profiles[name] });
    });

  profile
    .command('list')
    .description('List connection names and Vault references')
    .action(async () => {
      const result = await store.load();
      printResult(
        ctx,
        Object.entries(result.profiles)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([name, value]) => ({ name, active: result.active === name, ...value })),
      );
    });

  profile
    .command('show [name]')
    .description('Show a connection reference; never decrypts or prints its secret')
    .action(async (name?: string) => {
      const result = await store.resolve(name);
      printResult(ctx, { name: result.name, ...result.profile });
    });

  profile
    .command('use <name>')
    .description('Select the default PowerDNS connection')
    .action(async (name: string) => {
      await store.activate(name);
      ctx.output.success(`PowerDNS connection '${name}' is active`);
    });

  profile
    .command('remove <name>')
    .description('Remove a local connection reference; the Vault secret is not deleted')
    .option('--yes', 'Confirm removal')
    .action(async (name: string, options: { yes?: boolean }) => {
      requireYes(options.yes, `Removing PowerDNS connection '${name}'`);
      await store.remove(name);
      ctx.output.success(`Removed PowerDNS connection '${name}'; its Vault secret was not changed`);
    });

  profile
    .command('check [name]')
    .description('Decrypt the Vault configuration in memory and verify PowerDNS connectivity')
    .action(async (name?: string) => {
      const resolved = await store.resolve(name);
      const config = await readPowerDNSConfig(ctx, resolved.profile);
      const client = new PowerDNSClient(config);
      const server = await client.get<Record<string, unknown>>(serverPath(client));
      printResult(ctx, {
        connection: resolved.name,
        vaultProfile: resolved.profile.vaultProfile,
        secretAlias: resolved.profile.secretAlias,
        server,
      });
    });
}
