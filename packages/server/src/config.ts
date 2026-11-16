import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface ServerConfig {
  dataDir: string;
  port: number;
  host: string;
  driver: 'windows' | 'mock';
  /** Directory of the built web app (customer + admin), served statically. */
  webDir: string | null;
  sumatraPath: string | null;
}

export function defaultDataDir(): string {
  if (process.platform === 'win32') return join(process.env.ProgramData ?? 'C:\\ProgramData', 'PrintHub');
  return join(homedir(), '.printhub');
}

export function loadConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const env = process.env;
  return {
    dataDir: resolve(overrides.dataDir ?? env.PRINTHUB_DATA ?? defaultDataDir()),
    port: overrides.port ?? Number(env.PRINTHUB_PORT ?? 3000),
    // Bound to all interfaces; non-private clients are rejected per request (see http.ts),
    // which keeps working when DHCP hands the PC a new LAN address.
    host: overrides.host ?? env.PRINTHUB_HOST ?? '0.0.0.0',
    driver: overrides.driver ?? (env.PRINTHUB_DRIVER === 'mock' || process.platform !== 'win32' ? 'mock' : 'windows'),
    webDir: overrides.webDir ?? env.PRINTHUB_WEB ?? null,
    sumatraPath: overrides.sumatraPath ?? env.PRINTHUB_SUMATRA ?? null,
  };
}

export const dirs = (dataDir: string) => ({
  root: dataDir,
  database: join(dataDir, 'database'),
  jobs: join(dataDir, 'jobs'),
  logs: join(dataDir, 'logs'),
  mockOutput: join(dataDir, 'mock-output'),
});

export function ensureDirs(dataDir: string) {
  for (const d of Object.values(dirs(dataDir))) mkdirSync(d, { recursive: true });
}
