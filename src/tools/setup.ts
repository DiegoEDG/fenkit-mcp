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
- After a long pause or context reset, call \`get_status\` to ensure you still have the correct task context.

### 2. Task Lifecycle
- **Discovery**: Use \`list_tasks\` or \`search_tasks\` to find your assignment.
- **Loading**: Use \`get_full_task(taskId)\` to retrieve full context (Plan, Walkthrough, Status) before starting.
- **Planning**: Before coding, call \`update_task_plan(taskId, plan)\` with your technical approach.
- **Execution**: Set status to \`in_progress\` using \`update_task_metadata(taskId, { status: "in_progress" })\`.
- **Completion**: After verification, call \`update_task_walkthrough(taskId, walkthrough)\` and set status to \`done\` via \`update_task_metadata\`.

### 3. Compaction & Context Trimming
- If the system notifies you of context trimming or compaction:
  - Immediately call \`update_task_walkthrough\` or \`update_task_plan\` to persist any unsaved progress.
  - After trimming, re-orient using \`get_full_task(taskId)\`.

### 4. Automated Updates (Session End)
- Do not wait for the user to ask you to record progress.
- Record plans and walkthroughs as part of your natural workflow to keep the Fenkit platform updated.
- Before ending the session, ensure the current task status reflects the actual progress.`;

// ─── Config Path Helpers ───────────────────────────────────────────────────────

export type ClientType = 'claude' | 'cursor' | 'windsurf' | 'codex' | 'antigravity' | 'claudecode';

export const CLIENTS: ClientType[] = ['claude', 'cursor', 'windsurf', 'codex', 'antigravity', 'claudecode'];

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

function readJsonOrDefault<T extends Record<string, unknown>>(filePath: string, defaultValue: T): T {
  if (!fs.existsSync(filePath)) return { ...defaultValue };
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return { ...defaultValue };
  }
}

function fenKitMcpEntry(serverPath: string) {
  return {
    command: 'node',
    args: [serverPath],
  };
}

// ─── Client Setup Functions ───────────────────────────────────────────────────

export function setupClaude(serverPath: string): { path: string; action: string } {
  const configPath = claudeConfigPath();
  ensureDir(configPath);

  const config = readJsonOrDefault<Record<string, unknown>>(configPath, {});
  const mcpServers = (config['mcpServers'] as Record<string, unknown>) ?? {};
  mcpServers['fenkit'] = fenKitMcpEntry(serverPath);
  config['mcpServers'] = mcpServers;

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  return { path: configPath, action: 'Updated claude_desktop_config.json' };
}

export function setupWindsurf(serverPath: string): { path: string; action: string } {
  const configPath = windsurfConfigPath();
  ensureDir(configPath);

  const config = readJsonOrDefault<Record<string, unknown>>(configPath, {});
  const mcpServers = (config['mcpServers'] as Record<string, unknown>) ?? {};
  mcpServers['fenkit'] = fenKitMcpEntry(serverPath);
  config['mcpServers'] = mcpServers;

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');

  // Append protocol to .windsurfrules if not already present
  const rulesPath = path.join(homeDir, '.windsurfrules');
  const rulesContent = fs.existsSync(rulesPath) ? fs.readFileSync(rulesPath, 'utf-8') : '';
  if (!rulesContent.includes('Fenkit Task Protocol')) {
    fs.appendFileSync(rulesPath, `\n\n${FENKIT_MEMORY_PROTOCOL}`, 'utf-8');
  }

  return { path: configPath, action: 'Updated ~/.windsurf/mcp.json and ~/.windsurfrules' };
}

export function setupCursor(serverPath: string, projectPath?: string): { path: string; action: string } {
  // Project-level config
  const basePath = projectPath ?? process.cwd();
  const configPath = path.join(basePath, '.cursor', 'mcp.json');
  ensureDir(configPath);

  const config = readJsonOrDefault<Record<string, unknown>>(configPath, {});
  const mcpServers = (config['mcpServers'] as Record<string, unknown>) ?? {};
  mcpServers['fenkit'] = fenKitMcpEntry(serverPath);
  config['mcpServers'] = mcpServers;

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');

  // Write .cursor/rules/fenkit.mdc memory protocol
  const rulesDir = path.join(basePath, '.cursor', 'rules');
  if (!fs.existsSync(rulesDir)) {
    fs.mkdirSync(rulesDir, { recursive: true });
  }
  const mdcPath = path.join(rulesDir, 'fenkit.mdc');
  if (!fs.existsSync(mdcPath)) {
    const mdcContent = `---\nalwaysApply: true\n---\n\n${FENKIT_MEMORY_PROTOCOL}`;
    fs.writeFileSync(mdcPath, mdcContent, 'utf-8');
  }

  return { path: configPath, action: `Updated .cursor/mcp.json and .cursor/rules/fenkit.mdc in ${basePath}` };
}

export function setupAntigravity(serverPath: string): { path: string; action: string } {
  const configPath = antigravityConfigPath();
  ensureDir(configPath);

  const config = readJsonOrDefault<Record<string, unknown>>(configPath, {});
  const mcpServers = (config['mcpServers'] as Record<string, unknown>) ?? {};
  mcpServers['fenkit'] = fenKitMcpEntry(serverPath);
  config['mcpServers'] = mcpServers;

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');

  // Append protocol to ~/.gemini/GEMINI.md if not already present
  const rulesPath = antigravityRulesPath();
  ensureDir(rulesPath);
  const rulesContent = fs.existsSync(rulesPath) ? fs.readFileSync(rulesPath, 'utf-8') : '';
  if (!rulesContent.includes('Fenkit Task Protocol')) {
    fs.appendFileSync(rulesPath, `\n\n${FENKIT_MEMORY_PROTOCOL}`, 'utf-8');
  }

  return { path: configPath, action: 'Updated ~/.gemini/antigravity/mcp_config.json and ~/.gemini/GEMINI.md' };
}

export function setupCodex(serverPath: string): { path: string; action: string } {
  const configPath = codexConfigPath();
  const instructionsPath = codexInstructionsPath();

  ensureDir(configPath);

  // Write fenkit-instructions.md
  fs.writeFileSync(instructionsPath, FENKIT_MEMORY_PROTOCOL, 'utf-8');

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

  // Add [mcp_servers.fenkit] block if not present
  if (!tomlContent.includes('[mcp_servers.fenkit]')) {
    const block = `\n[mcp_servers.fenkit]\ncommand = "node"\nargs = ["${serverPath}"]\n`;
    tomlContent += block;
  }

  fs.writeFileSync(configPath, tomlContent, 'utf-8');
  return { path: configPath, action: `Updated ${configPath} and wrote ${instructionsPath}` };
}

export function setupClaudeCode(serverPath: string): { path: string; action: string } {
  const configPath = claudeCodeConfigPath();
  ensureDir(configPath);

  const config = readJsonOrDefault<Record<string, unknown>>(configPath, {});
  const mcpServers = (config['mcpServers'] as Record<string, unknown>) ?? {};
  mcpServers['fenkit'] = fenKitMcpEntry(serverPath);
  config['mcpServers'] = mcpServers;

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');

  // Write .clauderules in the current project
  const rulesPath = path.join(process.cwd(), '.clauderules');
  let rulesContent = fs.existsSync(rulesPath) ? fs.readFileSync(rulesPath, 'utf-8') : '';
  if (!rulesContent.includes('Fenkit Task Protocol')) {
    rulesContent += `\n\n${FENKIT_MEMORY_PROTOCOL}`;
    fs.writeFileSync(rulesPath, rulesContent, 'utf-8');
  }

  return { path: configPath, action: 'Updated ~/.claude/config.json and .clauderules' };
}

// ─── Tool Registration ─────────────────────────────────────────────────────────

export const setupHandlers: Record<ClientType, (serverPath: string, projectPath?: string) => { path: string; action: string }> = {
  claude: setupClaude,
  windsurf: setupWindsurf,
  cursor: setupCursor,
  antigravity: setupAntigravity,
  codex: setupCodex,
  claudecode: setupClaudeCode,
};

/**
 * Setup tools — automate client MCP configuration.
 * Supports: Claude Desktop, Cursor, Windsurf, Codex, Antigravity.
 */
export function registerSetupTools(server: McpServer): void {
  server.tool(
    'setup_client',
    'Configure a supported AI client (Claude Desktop, Cursor, Windsurf, Codex, or Antigravity) to use the Fenkit MCP server. This writes the appropriate config files so you never have to do it manually.',
    {
      client: z
        .enum(['claude', 'cursor', 'windsurf', 'codex', 'antigravity', 'claudecode'])
        .describe(
          'The AI client to configure. Options: claude (Claude Desktop), cursor (Cursor IDE), windsurf (Windsurf IDE), codex (OpenAI Codex CLI), antigravity (Google Antigravity IDE), claudecode (Claude Code CLI).',
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
          `**Server**: \`node ${serverPath}\``,
          ``,
          `**Next steps**:`,
          `1. Restart ${client === 'claude' ? 'Claude Desktop' : client === 'cursor' ? 'Cursor' : client === 'windsurf' ? 'Windsurf' : client === 'codex' ? 'Codex' : 'Antigravity'} to load the new config.`,
          `2. Run \`get_status\` to verify authentication.`,
          `3. Use \`login_browser\` with your Fenkit API key if not yet authenticated.`,
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
        .enum(['claude', 'cursor', 'windsurf', 'codex', 'antigravity', 'claudecode'])
        .describe('The AI client you want instructions for.'),
    },
    async ({ client }) => {
      const serverPath = getServerPath();
      const entry = `{\n  "command": "node",\n  "args": ["${serverPath}"]\n}`;

      const instructions: Record<string, string> = {
        claude: [
          `**Claude Desktop** — Edit \`${claudeConfigPath()}\`:`,
          '```json',
          '{',
          '  "mcpServers": {',
          '    "fenkit": ' + entry.replace(/\n/g, '\n    '),
          '  }',
          '}',
          '```',
        ].join('\n'),

        cursor: [
          `**Cursor** — Add to \`.cursor/mcp.json\` in your project:`,
          '```json',
          '{',
          '  "mcpServers": {',
          '    "fenkit": ' + entry.replace(/\n/g, '\n    '),
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
          '    "fenkit": ' + entry.replace(/\n/g, '\n    '),
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
          '    "fenkit": ' + entry.replace(/\n/g, '\n    '),
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
          '[mcp_servers.fenkit]',
          'command = "node"',
          `args = ["${serverPath}"]`,
          '```',
          '',
          `Also create \`${codexInstructionsPath()}\` with the Fenkit protocol:`,
          '```markdown',
          FENKIT_MEMORY_PROTOCOL,
          '```',
        ].join('\n'),
        claudecode: [
          `**Claude Code** — Edit \`${claudeCodeConfigPath()}\`:`,
          '```json',
          '{',
          '  "mcpServers": {',
          '    "fenkit": ' + entry.replace(/\n/g, '\n    '),
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
