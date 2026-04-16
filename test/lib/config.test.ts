import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('loadConfig robustness', () => {
  let tempDir: string;

  beforeEach(() => {
    // Create a temp config directory for testing
    tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'fnk-test-'));
    // Override home directory for the config module
    // We need to re-import after setting up temp env
    
    vi.resetModules();
    process.env.HOME = tempDir;
    process.env.USERPROFILE = tempDir;
  });

  afterEach(() => {
    // Cleanup
    try {
      fsSync.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('should not crash on malformed config.json and return defaults', async () => {
    // Create a temporary config directory in the temp home
    const testConfigDir = path.join(tempDir, '.fnk');
    fsSync.mkdirSync(testConfigDir, { recursive: true });
    
    // Write malformed JSON
    fsSync.writeFileSync(
      path.join(testConfigDir, 'config.json'),
      '{ "token": "123", broken json }',
      'utf-8'
    );

    // Re-require config with the test environment
    const { loadConfig } = await import('../../src/lib/config.js');
    
    // Should not throw - this is the key test
    const config = loadConfig();
    
    // Should return defaults
    expect(config.token).toBe('');
    expect(config.currentProjectId).toBeUndefined();
  });

  it('should backup corrupted config file', async () => {
    const testConfigDir = path.join(tempDir, '.fnk');
    fsSync.mkdirSync(testConfigDir, { recursive: true });
    
    // Write malformed JSON
    fsSync.writeFileSync(
      path.join(testConfigDir, 'config.json'),
      '{ invalid',
      'utf-8'
    );

    const { loadConfig } = await import('../../src/lib/config.js');
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    
    loadConfig();
    
    // Should have called warn
    expect(consoleSpy).toHaveBeenCalled();
    const firstCall = consoleSpy.mock.calls[0]?.[0];
    expect(firstCall).toContain('Warning');
    expect(firstCall).toContain('corrupted');
    
    // Backup file should exist
    const backupPath = path.join(testConfigDir, 'config.json.bak');
    expect(fsSync.existsSync(backupPath)).toBe(true);
    
    consoleSpy.mockRestore();
  });

  it('should handle valid JSON config normally', async () => {
    const testConfigDir = path.join(tempDir, '.fnk');
    fsSync.mkdirSync(testConfigDir, { recursive: true });
    
    // Write valid JSON
    fsSync.writeFileSync(
      path.join(testConfigDir, 'config.json'),
      JSON.stringify({ token: 'test-token-123', currentProjectId: 'proj-456' }),
      'utf-8'
    );

    const { loadConfig } = await import('../../src/lib/config.js');
    
    const config = loadConfig();
    
    expect(config.token).toBe('test-token-123');
    expect(config.currentProjectId).toBe('proj-456');
  });

  it('loadConfigAsync should handle corrupted config', async () => {
    const testConfigDir = path.join(tempDir, '.fnk');
    fsSync.mkdirSync(testConfigDir, { recursive: true });
    
    // Write malformed JSON
    fsSync.writeFileSync(
      path.join(testConfigDir, 'config.json'),
      'not valid json at all',
      'utf-8'
    );

    const { loadConfigAsync } = await import('../../src/lib/config.js');
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    
    // Should not throw
    const config = await loadConfigAsync();
    
    // Should return defaults
    expect(config.token).toBe('');
    
    // Should have warned
    expect(consoleSpy).toHaveBeenCalled();
    
    consoleSpy.mockRestore();
  });
});