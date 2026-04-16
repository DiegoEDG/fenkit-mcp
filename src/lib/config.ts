import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CONFIG_DIR = path.join(os.homedir(), '.fnk');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export interface FnkConfig {
  token: string;
  currentProjectId?: string;
  currentProjectName?: string | undefined;
}

const DEFAULT_CONFIG: FnkConfig = {
  token: '',
};

// Cache to avoid repeated disk reads within same operation batch
let configCache: FnkConfig | null = null;
let cacheValid = false;

async function ensureConfigDirAsync(): Promise<void> {
  try {
    await fs.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  } catch (err: unknown) {
    // EEXIST is OK - directory already exists
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  if (process.platform !== 'win32') {
    try {
      await fs.chmod(CONFIG_DIR, 0o700);
    } catch {
      // best effort only
    }
  }
}

/**
 * Async version of config loading with caching.
 * Use in hot paths to avoid repeated disk I/O.
 */
export async function loadConfigAsync(): Promise<FnkConfig> {
  if (cacheValid && configCache) {
    return { ...configCache };
  }

  await ensureConfigDirAsync();

  try {
    const raw = await fs.readFile(CONFIG_FILE, 'utf-8');
    try {
      configCache = { ...DEFAULT_CONFIG, ...JSON.parse(raw) } as FnkConfig;
    } catch (parseErr) {
      // Backup invalid config and return defaults
      const backupPath = `${CONFIG_FILE}.bak`;
      try {
        await fs.copyFile(CONFIG_FILE, backupPath);
        // eslint-disable-next-line no-console
        console.warn(`[fnk] Warning: config.json is corrupted (${parseErr instanceof Error ? parseErr.message : 'parse error'}). Backup saved to ${backupPath}. Using defaults.`);
      } catch {
        // eslint-disable-next-line no-console
        console.warn(`[fnk] Warning: config.json is corrupted and could not be backed up. Using defaults.`);
      }
      configCache = { ...DEFAULT_CONFIG };
    }
  } catch {
    // File read error (doesn't exist, permissions, etc.) - use defaults
    configCache = { ...DEFAULT_CONFIG };
  }

  cacheValid = true;
  return { ...configCache };
}

/**
 * Async version of config saving.
 * Invalidates cache after write to ensure consistency.
 */
export async function saveConfigAsync(config: Partial<FnkConfig>): Promise<void> {
  await ensureConfigDirAsync();

  const current = await loadConfigAsync();
  const merged = { ...current, ...config };

  try {
    await fs.writeFile(CONFIG_FILE, JSON.stringify(merged, null, 2), 'utf-8');
  } catch (err) {
    throw new Error(`Failed to save config: ${err instanceof Error ? err.message : 'unknown error'}`);
  }

  if (process.platform !== 'win32') {
    try {
      await fs.chmod(CONFIG_FILE, 0o600);
    } catch {
      // best effort only
    }
  }

  // Update cache with new values
  configCache = merged;
  cacheValid = true;
}

/**
 * Invalidate config cache.
 * Call after external modifications or when forcing reload.
 */
export function invalidateConfigCache(): void {
  cacheValid = false;
  configCache = null;
}

// === Synchronous versions (for startup/initialization only) ===

function ensureConfigDirSync(): void {
  if (!fsSync.existsSync(CONFIG_DIR)) {
    fsSync.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  if (process.platform !== 'win32') {
    try {
      fsSync.chmodSync(CONFIG_DIR, 0o700);
    } catch {
      // best effort only
    }
  }
}

/**
 * Synchronous config loading.
 * Use only at startup or for one-off operations.
 * Prefer loadConfigAsync() in hot paths.
 */
export function loadConfig(): FnkConfig {
  ensureConfigDirSync();

  if (!fsSync.existsSync(CONFIG_FILE)) {
    return { ...DEFAULT_CONFIG };
  }

  const raw = fsSync.readFileSync(CONFIG_FILE, 'utf-8');
  cacheValid = false; // Invalidate cache on sync read

  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) } as FnkConfig;
  } catch (err) {
    // Backup invalid config and return defaults
    const backupPath = `${CONFIG_FILE}.bak`;
    try {
      fsSync.copyFileSync(CONFIG_FILE, backupPath);
      // eslint-disable-next-line no-console
      console.warn(`[fnk] Warning: config.json is corrupted (${err instanceof Error ? err.message : 'parse error'}). Backup saved to ${backupPath}. Using defaults.`);
    } catch {
      // eslint-disable-next-line no-console
      console.warn(`[fnk] Warning: config.json is corrupted and could not be backed up. Using defaults.`);
    }
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Synchronous config saving.
 * Use only at startup or for one-off operations.
 * Prefer saveConfigAsync() in hot paths.
 */
export function saveConfig(config: Partial<FnkConfig>): void {
  ensureConfigDirSync();

  const current = loadConfig();
  const merged = { ...current, ...config };

  fsSync.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), 'utf-8');
  if (process.platform !== 'win32') {
    try {
      fsSync.chmodSync(CONFIG_FILE, 0o600);
    } catch {
      // best effort only
    }
  }

  // Sync write invalidates cache
  cacheValid = false;
  configCache = merged;
}

/**
 * Synchronous auth check.
 * Use only at startup or for one-off operations.
 * Prefer requireAuthAsync() in hot paths.
 */
export function requireAuth(): FnkConfig {
  const config = loadConfig();
  if (!config.token) {
    throw new Error('NOT_AUTHENTICATED: No token found. Run the `login` tool or configure ~/.fnk/config.json with your API key.');
  }
  return config;
}

/**
 * Synchronous project check.
 * Use only at startup or for one-off operations.
 * Prefer requireProjectAsync() in hot paths.
 */
export function requireProject(): FnkConfig {
  const config = requireAuth();
  if (!config.currentProjectId) {
    throw new Error('NO_ACTIVE_PROJECT: No project selected. Use `select_project` or `list_projects` first.');
  }
  return config;
}

/**
 * Async auth check with caching.
 * Use in hot paths to avoid repeated disk I/O.
 */
export async function requireAuthAsync(): Promise<FnkConfig> {
  const config = await loadConfigAsync();
  if (!config.token) {
    throw new Error('NOT_AUTHENTICATED: No token found. Run the `login` tool or configure ~/.fnk/config.json with your API key.');
  }
  return config;
}

/**
 * Async project check with caching.
 * Use in hot paths to avoid repeated disk I/O.
 */
export async function requireProjectAsync(): Promise<FnkConfig> {
  const config = await requireAuthAsync();
  if (!config.currentProjectId) {
    throw new Error('NO_ACTIVE_PROJECT: No project selected. Use `select_project` or `list_projects` first.');
  }
  return config;
}
