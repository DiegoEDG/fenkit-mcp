import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CONFIG_DIR = path.join(os.homedir(), '.fnk');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export interface FnkConfig {
  token: string;
  currentProjectId?: string;
  currentProjectName?: string;
}

const DEFAULT_CONFIG: FnkConfig = {
  token: '',
};

function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(CONFIG_DIR, 0o700);
    } catch {
      // best effort only
    }
  }
}

export function loadConfig(): FnkConfig {
  ensureConfigDir();

  if (!fs.existsSync(CONFIG_FILE)) {
    return { ...DEFAULT_CONFIG };
  }

  const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
  return { ...DEFAULT_CONFIG, ...JSON.parse(raw) } as FnkConfig;
}

export function saveConfig(config: Partial<FnkConfig>): void {
  ensureConfigDir();

  const current = loadConfig();
  const merged = { ...current, ...config };

  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), 'utf-8');
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(CONFIG_FILE, 0o600);
    } catch {
      // best effort only
    }
  }
}

export function requireAuth(): FnkConfig {
  const config = loadConfig();
  if (!config.token) {
    throw new Error('NOT_AUTHENTICATED: No token found. Run the `login` tool or configure ~/.fnk/config.json with your API key.');
  }
  return config;
}

export function requireProject(): FnkConfig {
  const config = requireAuth();
  if (!config.currentProjectId) {
    throw new Error('NO_ACTIVE_PROJECT: No project selected. Use `select_project` or `list_projects` first.');
  }
  return config;
}
