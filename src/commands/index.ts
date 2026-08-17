import type { Command } from 'commander';
import type { CLIPluginContext } from '../plugin-types.js';
import { PowerDNSProfileStore } from '../profile-store.js';
import { registerApiCommands } from './api.js';
import { registerCryptokeyCommands } from './cryptokey.js';
import { registerMetadataCommands } from './metadata.js';
import { registerProfileCommands } from './profile.js';
import { registerRecordCommands } from './record.js';
import { registerServerCommands } from './server.js';
import { registerTopologyCommands } from './topology.js';
import { registerTsigCommands } from './tsig.js';
import { registerZoneCommands } from './zone.js';

export function registerPowerDNSCommands(
  root: Command,
  ctx: CLIPluginContext,
  store: PowerDNSProfileStore = new PowerDNSProfileStore(),
): void {
  registerProfileCommands(root, ctx, store);
  registerServerCommands(root, ctx, store);
  registerZoneCommands(root, ctx, store);
  registerRecordCommands(root, ctx, store);
  registerMetadataCommands(root, ctx, store);
  registerCryptokeyCommands(root, ctx, store);
  registerTsigCommands(root, ctx, store);
  registerTopologyCommands(root, ctx, store);
  registerApiCommands(root, ctx, store);
}
