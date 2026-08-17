import type { Command } from 'commander';

export interface VaultClientLike {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
}

export interface CLIOutputLike {
  json(data: unknown): void;
  success(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface CLIPluginContext {
  client: VaultClientLike;
  output: CLIOutputLike;
  getConfig(): unknown;
  getProfileName(): string;
  isPlainMode(): boolean;
}

export interface CLIPlugin {
  name: string;
  version: string;
  description?: string;
  registerCommands(program: Command, ctx: CLIPluginContext): void;
}
