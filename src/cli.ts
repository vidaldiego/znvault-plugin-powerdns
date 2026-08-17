import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import { registerPowerDNSCommands } from './commands/index.js';
import type { CLIPlugin, CLIPluginContext } from './plugin-types.js';

export const PLUGIN_VERSION: string = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

export function createPowerDNSPlugin(): CLIPlugin {
  return {
    name: 'powerdns',
    version: PLUGIN_VERSION,
    description: 'Manage PowerDNS Authoritative through Vault-backed connections',
    registerCommands(program: Command, ctx: CLIPluginContext): void {
      const root = program
        .command('powerdns')
        .alias('pdns')
        .description('Manage PowerDNS Authoritative without locally stored credentials')
        .option('-c, --connection <name>', 'PowerDNS connection name; defaults to the active connection');
      registerPowerDNSCommands(root, ctx);
    },
  };
}

export default createPowerDNSPlugin;
