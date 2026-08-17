import type { Command } from 'commander';
import type { CLIPluginContext } from '../plugin-types.js';
import type { PowerDNSMethod } from '../powerdns-client.js';
import type { PowerDNSProfileStore } from '../profile-store.js';
import { printResult, readJsonObject, requireYes, withPowerDNS } from './helpers.js';

const METHODS = new Set<PowerDNSMethod>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

export function registerApiCommands(
  root: Command,
  ctx: CLIPluginContext,
  store: PowerDNSProfileStore,
): void {
  const api = root.command('api').description('Use any PowerDNS API endpoint on the configured origin');

  api
    .command('request <method> <path>')
    .description('Make a same-origin API request; mutating methods require --yes')
    .option('--body <file>', 'Read a JSON request body from a file')
    .option('--reveal-secrets', 'Disable response redaction')
    .option('--yes', 'Confirm mutation or secret reveal')
    .action(async (
      methodInput: string,
      path: string,
      options: { body?: string; revealSecrets?: boolean; yes?: boolean },
    ) => {
      const method = methodInput.toUpperCase() as PowerDNSMethod;
      if (!METHODS.has(method)) throw new Error('Method must be GET, POST, PUT, PATCH, or DELETE');
      if (method !== 'GET') requireYes(options.yes, `${method} API request`);
      if (options.revealSecrets === true) requireYes(options.yes, 'Revealing fields that may contain secrets');
      if (method === 'GET' && options.body !== undefined) throw new Error('GET requests cannot include --body');
      const body = options.body === undefined ? undefined : await readJsonObject(options.body);

      await withPowerDNS(root, ctx, store, async (client) => {
        const result = await client.request(method, path, body);
        printResult(
          ctx,
          { status: result.status, contentType: result.contentType, data: result.data },
          options.revealSecrets === true,
        );
      });
    });
}
