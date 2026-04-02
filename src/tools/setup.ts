import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ─── Fenkit Memory Protocol ────────────────────────────────────────────────────
// These instructions are written to client rule files so the agent knows
// how and when to use Fenkit MCP tools.
const FENKIT_MEMORY_PROTOCOL = `## Fenkit Task Protocol
You are an AI agent with access to the Fenkit platform. Follow this protocol for seamless task coordination:

### 1. Orientation & Session Start
- **Always** call \`get_status\` at the beginning of a session to verify authentication and active project.
- If no project is active, call \`list_projects\` and ask the user to select one, or try to auto-select if you're in a known repository.
- If \`chat_id\` is available, call \`resolve_session_task(chat_id)\` before loading task context:
  - \`bound\` → continue with returned task context.
  - \`unbound\` → continue with explicit task selection.
  - \`needs_confirmation\` → ask user to confirm next task; do not silently auto-bind.
- If \`chat_id\` is missing, do not infer task binding from chat title/name.
- After a long pause or context reset, call \`get_status\` to ensure you still have the correct task context.

### 2. Binding & Lifecycle Enforcement
- When you fetch a task via \`resolve_session_task\`, \`get_task_context_compact\`, or \`get_task_context_full\`, the task becomes **bound** to this session.
- **BOUND tasks are under STRICT lifecycle enforcement.** You MUST follow the lifecycle in order.
- **Do NOT skip write tools for bound tasks.** If you don't call \`update_task_plan\` or \`update_task_walkthrough\`, the system will auto-repair with fallback artifacts, but this is NOT ideal.

### 3. Strict Lifecycle Order (for bound tasks)
The lifecycle must be followed IN ORDER:

1. **READ**: Fetch task context via \`get_task_context_compact(taskId)\` or \`resolve_session_task(chat_id)\`
   → Task is now bound. Lifecycle enforcement activates.

2. **PLAN**: Immediately call \`update_task_plan(taskId, plan, mode, model?, agent?)\`
   → Use \`mode: "full"\` if you have a detailed plan, \`mode: "mini"\` otherwise.
   → Then call \`set_task_status(taskId, status: "in_progress", ...)\`

3. **WORK**: Implement the task (coding, etc.)

4. **COMPLETE**: When finished, call \`update_task_walkthrough(taskId, walkthrough, mode, model?, agent?)\`
   → Then call \`set_task_status(taskId, status: "in_review", ...)\`
   → This moves the task to \`in_review\` for review.

### 4. Confirmation for Sensitive Writes
Use preview → execute flow for:
- \`select_project\`, \`set_task_status\`, \`update_task_plan\`, \`update_task_walkthrough\`

Note: \`set_task_priority\` is optional and NOT part of the strict lifecycle.

### 5. Compaction & Context Trimming
- If the system notifies you of context trimming or compaction:
  - Immediately call \`update_task_walkthrough\` or \`update_task_plan\` to persist any unsaved progress.
  - After trimming, re-orient using \`get_task_context_compact(taskId)\`.

### 6. Automated Updates (Session End)
- Do not wait for the user to ask you to record progress.
- Record plans and walkthroughs as part of your natural workflow to keep the Fenkit platform updated.
- Do not ask whether you should call lifecycle tools each time; execute the lifecycle protocol directly unless the user explicitly requests manual confirmations.
- Full artifacts have priority over mini artifacts. Mini artifacts are only fallback when full artifacts were not provided.
- Before ending the session, ensure the current task status reflects the actual progress.`;

const FENKIT_PROTOCOL_START = '<!-- FENKIT_TASK_PROTOCOL:START -->';
const FENKIT_PROTOCOL_END = '<!-- FENKIT_TASK_PROTOCOL:END -->';

function wrapFenkitProtocolBlock(protocol: string): string {
  return `${FENKIT_PROTOCOL_START}\n${protocol}\n${FENKIT_PROTOCOL_END}`;
}

function upsertFenkitProtocol(content: string): string {
  const wrapped = wrapFenkitProtocolBlock(FENKIT_MEMORY_PROTOCOL);
  const markerRegex = new RegExp(`${FENKIT_PROTOCOL_START}[\\s\\S]*?${FENKIT_PROTOCOL_END}`, 'm');
  if (markerRegex.test(content)) {
    return content.replace(markerRegex, wrapped);
  }

  const legacyProtocolRegex = /## Fenkit Task Protocol[\s\S]*?(?=\n## [^\n]+|\s*$)/m;
  if (legacyProtocolRegex.test(content)) {
    return content.replace(legacyProtocolRegex, wrapped);
  }

  const trimmed = content.trimEnd();
  if (!trimmed) return wrapped;
  return `${trimmed}\n\n${wrapped}`;
}

function writeFenkitProtocolToSharedRulesFile(filePath: string): void {
  ensureDir(filePath);
  const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
  const next = upsertFenkitProtocol(current);
  if (next !== current) {
    fs.writeFileSync(filePath, next, 'utf-8');
  }
}

// ─── Config Path Helpers ───────────────────────────────────────────────────────

export type ClientType =
  | 'claude'
  | 'cursor'
  | 'windsurf'
  | 'codex'
  | 'opencode'
  | 'antigravity'
  | 'claudecode';

export const CLIENTS: ClientType[] = [
  'claude',
  'cursor',
  'windsurf',
  'codex',
  'opencode',
  'antigravity',
  'claudecode',
];

const isWindows = process.platform === 'win32';
const homeDir = os.homedir();
const appData = process.env['APPDATA'] ?? path.join(homeDir, 'AppData', 'Roaming');

function getServerPath(): string {
  // argv[1] is the path to the current script (index.js)
  return process.argv[1] ?? path.join(homeDir, '.fnk', 'fenkit-mcp', 'dist', 'index.js');
}

function claudeConfigPath(): string {
  if (isWindows) {
    return path.join(appData, 'Claude', 'claude_desktop_config.json');
  }
  return path.join(homeDir, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
}

function windsurfConfigPath(): string {
  if (isWindows) {
    return path.join(process.env['USERPROFILE'] ?? homeDir, '.windsurf', 'mcp.json');
  }
  return path.join(homeDir, '.windsurf', 'mcp.json');
}

function antigravityConfigPath(): string {
  return path.join(homeDir, '.gemini', 'antigravity', 'mcp_config.json');
}

function antigravityRulesPath(): string {
  return path.join(homeDir, '.gemini', 'GEMINI.md');
}

function codexConfigPath(): string {
  if (isWindows) {
    return path.join(appData, 'codex', 'config.toml');
  }
  return path.join(homeDir, '.codex', 'config.toml');
}

function opencodeConfigPath(): string {
  if (isWindows) {
    return path.join(appData, 'opencode', 'opencode.json');
  }
  return path.join(homeDir, '.config', 'opencode', 'opencode.json');
}

function claudeCodeConfigPath(): string {
  return path.join(homeDir, '.claude', 'config.json');
}

function codexInstructionsPath(): string {
  if (isWindows) {
    return path.join(appData, 'codex', 'fenkit-instructions.md');
  }
  return path.join(homeDir, '.codex', 'fenkit-instructions.md');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function resolveSafeProjectPath(projectPath?: string): string {
  const basePath = projectPath ? path.resolve(projectPath) : process.cwd();
  const workspaceRoot = path.resolve(process.cwd());
  const allowArbitraryPath = process.env['FENKIT_ALLOW_ANY_SETUP_PATH'] === 'true';

  if (allowArbitraryPath) {
    return basePath;
  }

  const isWithinWorkspace =
    basePath === workspaceRoot || basePath.startsWith(`${workspaceRoot}${path.sep}`);
  if (!isWithinWorkspace) {
    throw new Error(
      `Unsafe path "${basePath}". setup_client.path must stay within ${workspaceRoot}. Set FENKIT_ALLOW_ANY_SETUP_PATH=true to override in trusted environments.`,
    );
  }

  return basePath;
}

function readJsonOrDefault<T extends Record<string, unknown>>(filePath: string, defaultValue: T): T {
  if (!fs.existsSync(filePath)) return { ...defaultValue };
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return { ...defaultValue };
  }
}

function upsertTomlServerBlock(tomlContent: string, name: string, block: string): string {
  const pattern = new RegExp(`(^|\\n)\\[mcp_servers\\.${name}\\][\\s\\S]*?(?=\\n\\[[^\\]]+\\]|$)`);
  if (pattern.test(tomlContent)) {
    return tomlContent.replace(pattern, (_match, prefix: string) => `${prefix}${block}\n`);
  }
  const trimmed = tomlContent.trimEnd();
  if (!trimmed) return `${block}\n`;
  return `${trimmed}\n\n${block}\n`;
}

type FenkitMode = 'read-runtime' | 'write-runtime' | 'admin';

function fenKitMcpEntry(serverPath: string, mode: FenkitMode) {
  return {
    command: 'node',
    args: [serverPath, `--mode=${mode}`],
  };
}

function applyDualFenkitServers(container: Record<string, unknown>, serverPath: string): Record<string, unknown> {
  container['fenkit_read'] = fenKitMcpEntry(serverPath, 'read-runtime');
  container['fenkit_write'] = fenKitMcpEntry(serverPath, 'write-runtime');
  container['fenkit_admin'] = fenKitMcpEntry(serverPath, 'admin');
  return container;
}

// ─── Client Setup Functions ───────────────────────────────────────────────────

export function setupClaude(serverPath: string): { path: string; action: string } {
  const configPath = claudeConfigPath();
  ensureDir(configPath);

  const config = readJsonOrDefault<Record<string, unknown>>(configPath, {});
  const mcpServers = (config['mcpServers'] as Record<string, unknown>) ?? {};
  applyDualFenkitServers(mcpServers, serverPath);
  config['mcpServers'] = mcpServers;

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  return { path: configPath, action: 'Updated claude_desktop_config.json' };
}

export function setupWindsurf(serverPath: string): { path: string; action: string } {
  const configPath = windsurfConfigPath();
  ensureDir(configPath);

  const config = readJsonOrDefault<Record<string, unknown>>(configPath, {});
  const mcpServers = (config['mcpServers'] as Record<string, unknown>) ?? {};
  applyDualFenkitServers(mcpServers, serverPath);
  config['mcpServers'] = mcpServers;

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');

  // Upsert protocol in shared rules file
  const rulesPath = path.join(homeDir, '.windsurfrules');
  writeFenkitProtocolToSharedRulesFile(rulesPath);

  return { path: configPath, action: 'Updated ~/.windsurf/mcp.json and ~/.windsurfrules' };
}

export function setupCursor(serverPath: string, projectPath?: string): { path: string; action: string } {
  // Project-level config
  const basePath = resolveSafeProjectPath(projectPath);
  const configPath = path.join(basePath, '.cursor', 'mcp.json');
  ensureDir(configPath);

  const config = readJsonOrDefault<Record<string, unknown>>(configPath, {});
  const mcpServers = (config['mcpServers'] as Record<string, unknown>) ?? {};
  applyDualFenkitServers(mcpServers, serverPath);
  config['mcpServers'] = mcpServers;

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');

  // Always refresh .cursor/rules/fenkit.mdc with latest protocol
  const rulesDir = path.join(basePath, '.cursor', 'rules');
  if (!fs.existsSync(rulesDir)) {
    fs.mkdirSync(rulesDir, { recursive: true });
  }
  const mdcPath = path.join(rulesDir, 'fenkit.mdc');
  const mdcContent = `---\nalwaysApply: true\n---\n\n${wrapFenkitProtocolBlock(FENKIT_MEMORY_PROTOCOL)}`;
  fs.writeFileSync(mdcPath, mdcContent, 'utf-8');

  return { path: configPath, action: `Updated .cursor/mcp.json and .cursor/rules/fenkit.mdc in ${basePath}` };
}

export function setupAntigravity(serverPath: string): { path: string; action: string } {
  const configPath = antigravityConfigPath();
  ensureDir(configPath);

  const config = readJsonOrDefault<Record<string, unknown>>(configPath, {});
  const mcpServers = (config['mcpServers'] as Record<string, unknown>) ?? {};
  applyDualFenkitServers(mcpServers, serverPath);
  config['mcpServers'] = mcpServers;

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');

  // Upsert protocol in shared rules file
  const rulesPath = antigravityRulesPath();
  writeFenkitProtocolToSharedRulesFile(rulesPath);

  return { path: configPath, action: 'Updated ~/.gemini/antigravity/mcp_config.json and ~/.gemini/GEMINI.md' };
}

export function setupCodex(serverPath: string): { path: string; action: string } {
  const configPath = codexConfigPath();
  const instructionsPath = codexInstructionsPath();

  ensureDir(configPath);

  // Write fenkit-instructions.md
  fs.writeFileSync(instructionsPath, wrapFenkitProtocolBlock(FENKIT_MEMORY_PROTOCOL), 'utf-8');

  // Read existing TOML config or start fresh
  let tomlContent = '';
  if (fs.existsSync(configPath)) {
    tomlContent = fs.readFileSync(configPath, 'utf-8');
  }

  // Add model_instructions_file if not present
  if (!tomlContent.includes('model_instructions_file')) {
    const header = `model_instructions_file = "${instructionsPath}"\n\n`;
    tomlContent = header + tomlContent;
  }

  const readBlock = `[mcp_servers.fenkit_read]\ncommand = "node"\nargs = ["${serverPath}", "--mode=read-runtime"]`;
  const writeBlock = `[mcp_servers.fenkit_write]\ncommand = "node"\nargs = ["${serverPath}", "--mode=write-runtime"]`;
  const adminBlock = `[mcp_servers.fenkit_admin]\ncommand = "node"\nargs = ["${serverPath}", "--mode=admin"]`;
  tomlContent = upsertTomlServerBlock(tomlContent, 'fenkit_read', readBlock);
  tomlContent = upsertTomlServerBlock(tomlContent, 'fenkit_write', writeBlock);
  tomlContent = upsertTomlServerBlock(tomlContent, 'fenkit_admin', adminBlock);

  fs.writeFileSync(configPath, tomlContent, 'utf-8');
  return { path: configPath, action: `Updated ${configPath} and wrote ${instructionsPath}` };
}

export function setupOpenCode(serverPath: string): { path: string; action: string } {
  const configPath = opencodeConfigPath();
  ensureDir(configPath);

  const config = readJsonOrDefault<Record<string, unknown>>(configPath, {});
  const mcp = (config['mcp'] as Record<string, unknown>) ?? {};
  mcp['fenkit_read'] = {
    type: 'local',
    enabled: true,
    command: ['node', serverPath, '--mode=read-runtime'],
  };
  mcp['fenkit_write'] = {
    type: 'local',
    enabled: true,
    command: ['node', serverPath, '--mode=write-runtime'],
  };
  mcp['fenkit_admin'] = {
    type: 'local',
    enabled: true,
    command: ['node', serverPath, '--mode=admin'],
  };
  config['mcp'] = mcp;

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  return {
    path: configPath,
    action: 'Updated opencode.json (mcp.fenkit_read + mcp.fenkit_write + mcp.fenkit_admin)'
  };
}

export function setupClaudeCode(serverPath: string): { path: string; action: string } {
  const configPath = claudeCodeConfigPath();
  ensureDir(configPath);

  const config = readJsonOrDefault<Record<string, unknown>>(configPath, {});
  const mcpServers = (config['mcpServers'] as Record<string, unknown>) ?? {};
  applyDualFenkitServers(mcpServers, serverPath);
  config['mcpServers'] = mcpServers;

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');

  // Upsert protocol in shared project rules file
  const rulesPath = path.join(process.cwd(), '.clauderules');
  writeFenkitProtocolToSharedRulesFile(rulesPath);

  return { path: configPath, action: 'Updated ~/.claude/config.json and .clauderules' };
}

// ─── Tool Registration ─────────────────────────────────────────────────────────

export const setupHandlers: Record<ClientType, (serverPath: string, projectPath?: string) => { path: string; action: string }> = {
  claude: setupClaude,
  windsurf: setupWindsurf,
  cursor: setupCursor,
  antigravity: setupAntigravity,
  codex: setupCodex,
  opencode: setupOpenCode,
  claudecode: setupClaudeCode,
};

/**
 * Setup tools — automate client MCP configuration.
 * Supports: Claude Desktop, Cursor, Windsurf, Codex, OpenCode, Antigravity, Claude Code.
 */
export function registerSetupTools(server: McpServer): void {
  const clientDisplayName = (client: ClientType): string => {
    const labels: Record<ClientType, string> = {
      claude: 'Claude Desktop',
      cursor: 'Cursor',
      windsurf: 'Windsurf',
      codex: 'Codex',
      opencode: 'OpenCode',
      antigravity: 'Antigravity',
      claudecode: 'Claude Code',
    };
    return labels[client];
  };

  server.tool(
    'setup_client',
    'Configure a supported AI client (Claude Desktop, Cursor, Windsurf, Codex, OpenCode, Antigravity, or Claude Code) to use the Fenkit MCP server. This writes the appropriate config files so you never have to do it manually.',
    {
      client: z
        .enum(['claude', 'cursor', 'windsurf', 'codex', 'opencode', 'antigravity', 'claudecode'])
        .describe(
          'The AI client to configure. Options: claude (Claude Desktop), cursor (Cursor IDE), windsurf (Windsurf IDE), codex (OpenAI Codex CLI), opencode (OpenCode CLI), antigravity (Google Antigravity IDE), claudecode (Claude Code CLI).',
        ),
      path: z
        .string()
        .optional()
        .describe(
          'Absolute path to a project directory for project-local config (used by Cursor). Defaults to current working directory.',
        ),
    },
    async ({ client, path: projectPath }) => {
      try {
        const serverPath = getServerPath();
        const result = setupHandlers[client](serverPath, projectPath);

        const lines = [
          `✅ **Fenkit MCP configured for ${client}**`,
          ``,
          `**Action**: ${result.action}`,
          `**Config path**: \`${result.path}\``,
          `**Read runtime**: \`node ${serverPath} --mode=read-runtime\``,
          `**Write runtime**: \`node ${serverPath} --mode=write-runtime\``,
          `**Admin server**: \`node ${serverPath} --mode=admin\``,
          ``,
          `**Next steps**:`,
          `1. Restart ${clientDisplayName(client)} to load the new config.`,
          `2. Run \`get_status\` to verify authentication.`,
          `3. Use \`login\` to authenticate if not yet authenticated.`,
        ];

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Error setting up ${client}: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  // get_setup_instructions — show raw config snippets without touching the filesystem
  server.tool(
    'get_setup_instructions',
    'Get manual setup instructions for any supported AI client. Returns the exact JSON/TOML config blocks to copy-paste, without modifying any files. Useful when you want to review before applying.',
    {
      client: z
        .enum(['claude', 'cursor', 'windsurf', 'codex', 'opencode', 'antigravity', 'claudecode'])
        .describe('The AI client you want instructions for.'),
    },
    async ({ client }) => {
      const serverPath = getServerPath();
      const readEntry = `{\n  "command": "node",\n  "args": ["${serverPath}", "--mode=read-runtime"]\n}`;
      const writeEntry = `{\n  "command": "node",\n  "args": ["${serverPath}", "--mode=write-runtime"]\n}`;
      const adminEntry = `{\n  "command": "node",\n  "args": ["${serverPath}", "--mode=admin"]\n}`;

      const instructions: Record<string, string> = {
        claude: [
          `**Claude Desktop** — Edit \`${claudeConfigPath()}\`:`,
          '```json',
          '{',
          '  "mcpServers": {',
          '    "fenkit_read": ' + readEntry.replace(/\n/g, '\n    ') + ',',
          '    "fenkit_write": ' + writeEntry.replace(/\n/g, '\n    ') + ',',
          '    "fenkit_admin": ' + adminEntry.replace(/\n/g, '\n    '),
          '  }',
          '}',
          '```',
        ].join('\n'),

        cursor: [
          `**Cursor** — Add to \`.cursor/mcp.json\` in your project:`,
          '```json',
          '{',
          '  "mcpServers": {',
          '    "fenkit_read": ' + readEntry.replace(/\n/g, '\n    ') + ',',
          '    "fenkit_write": ' + writeEntry.replace(/\n/g, '\n    ') + ',',
          '    "fenkit_admin": ' + adminEntry.replace(/\n/g, '\n    '),
          '  }',
          '}',
          '```',
          '',
          'Also create `.cursor/rules/fenkit.mdc`:',
          '```',
          '---',
          'alwaysApply: true',
          '---',
          '',
          FENKIT_MEMORY_PROTOCOL,
          '```',
        ].join('\n'),

        windsurf: [
          `**Windsurf** — Edit \`${windsurfConfigPath()}\`:`,
          '```json',
          '{',
          '  "mcpServers": {',
          '    "fenkit_read": ' + readEntry.replace(/\n/g, '\n    ') + ',',
          '    "fenkit_write": ' + writeEntry.replace(/\n/g, '\n    ') + ',',
          '    "fenkit_admin": ' + adminEntry.replace(/\n/g, '\n    '),
          '  }',
          '}',
          '```',
          '',
          'Also add to `~/.windsurfrules`:',
          '```',
          FENKIT_MEMORY_PROTOCOL,
          '```',
        ].join('\n'),

        antigravity: [
          `**Antigravity** — Edit \`${antigravityConfigPath()}\`:`,
          '```json',
          '{',
          '  "mcpServers": {',
          '    "fenkit_read": ' + readEntry.replace(/\n/g, '\n    ') + ',',
          '    "fenkit_write": ' + writeEntry.replace(/\n/g, '\n    ') + ',',
          '    "fenkit_admin": ' + adminEntry.replace(/\n/g, '\n    '),
          '  }',
          '}',
          '```',
          '',
          'Also add to `~/.gemini/GEMINI.md`:',
          '```markdown',
          FENKIT_MEMORY_PROTOCOL,
          '```',
        ].join('\n'),

        codex: [
          `**Codex** — Edit \`${codexConfigPath()}\`:`,
          '```toml',
          `model_instructions_file = "${codexInstructionsPath()}"`,
          '',
          '[mcp_servers.fenkit_read]',
          'command = "node"',
          `args = ["${serverPath}", "--mode=read-runtime"]`,
          '',
          '[mcp_servers.fenkit_write]',
          'command = "node"',
          `args = ["${serverPath}", "--mode=write-runtime"]`,
          '',
          '[mcp_servers.fenkit_admin]',
          'command = "node"',
          `args = ["${serverPath}", "--mode=admin"]`,
          '```',
          '',
          `Also create \`${codexInstructionsPath()}\` with the Fenkit protocol:`,
          '```markdown',
          FENKIT_MEMORY_PROTOCOL,
          '```',
        ].join('\n'),

        opencode: [
          `**OpenCode** — Edit \`${opencodeConfigPath()}\`:`,
          '```json',
          '{',
          '  "$schema": "https://opencode.ai/config.json",',
          '  "mcp": {',
          '    "fenkit_read": {',
          '      "type": "local",',
          '      "enabled": true,',
          '      "command": ["node", "' + serverPath + '", "--mode=read-runtime"]',
          '    },',
          '    "fenkit_write": {',
          '      "type": "local",',
          '      "enabled": true,',
          '      "command": ["node", "' + serverPath + '", "--mode=write-runtime"]',
          '    },',
          '    "fenkit_admin": {',
          '      "type": "local",',
          '      "enabled": true,',
          '      "command": ["node", "' + serverPath + '", "--mode=admin"]',
          '    }',
          '  }',
          '}',
          '```',
        ].join('\n'),
        claudecode: [
          `**Claude Code** — Edit \`${claudeCodeConfigPath()}\`:`,
          '```json',
          '{',
          '  "mcpServers": {',
          '    "fenkit_read": ' + readEntry.replace(/\n/g, '\n    ') + ',',
          '    "fenkit_write": ' + writeEntry.replace(/\n/g, '\n    ') + ',',
          '    "fenkit_admin": ' + adminEntry.replace(/\n/g, '\n    '),
          '  }',
          '}',
          '```',
          '',
          'Also add to `.clauderules` in your project root:',
          '```markdown',
          FENKIT_MEMORY_PROTOCOL,
          '```',
        ].join('\n'),
      };

      return {
        content: [{ type: 'text' as const, text: instructions[client] }],
      };
    },
  );

  // native MCP prompt for instructions
  server.prompt(
    'task-protocol',
    'Get the Fenkit Task Protocol instructions for AI agents. Use this to understand how to interact with Fenkit tools autonomously.',
    {},
    () => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: FENKIT_MEMORY_PROTOCOL,
          },
        },
      ],
    }),
  );
}
