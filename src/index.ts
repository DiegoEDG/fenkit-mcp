#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAuthTools } from './tools/auth.js';
import { registerProjectTools } from './tools/projects.js';
import { registerTaskReadTools } from './tools/task-read.js';
import { registerTaskWriteTools } from './tools/task-write.js';
import { registerSetupTools, setupHandlers, CLIENTS, ClientType } from './tools/setup.js';

const server = new McpServer({
	name: 'fenkit-mcp',
	version: '1.0.0',
	description:
		'Fenkit MCP Server — LLM-native task coordination layer for AI agents. Discover, plan, execute, and track tasks in the Fenkit platform.'
});

// Phase 1: Auth & Config
registerAuthTools(server);

// Phase 1: Project Management
registerProjectTools(server);

// Phase 1: Task Discovery & Retrieval
registerTaskReadTools(server);

// Phase 2: Task Writes (Plan, Walkthrough, Metadata)
registerTaskWriteTools(server);

// Setup: Client Configuration (Claude, Cursor, Windsurf, Codex, OpenCode, Antigravity, Claude Code)
registerSetupTools(server);

// Start the server with stdio transport
async function main(): Promise<void> {
	const args = process.argv.slice(2);

	// Manual Setup Command: node dist/index.js setup <client>
	if (args[0] === 'setup') {
		const client = args[1] as ClientType;
		if (!client || !CLIENTS.includes(client)) {
			console.error(`Usage: fenkit-mcp setup <${CLIENTS.join('|')}>`);
			process.exit(1);
		}

		try {
			// In CLI mode, we assume argv[1] is the absolute path to the current script
			const serverPath = process.argv[1];
			const result = setupHandlers[client](serverPath);
			console.log(`✅ Fenkit MCP configured for ${client}`);
			console.log(`Action: ${result.action}`);
			console.log(`Config path: ${result.path}`);
			console.log(`\nNext steps:`);
			console.log(`1. Restart ${client} to load the new config.`);
			console.log(`2. Call 'get_status' to verify the connection.`);
			process.exit(0);
		} catch (error) {
			console.error(`❌ Error setting up ${client}:`, error instanceof Error ? error.message : error);
			process.exit(1);
		}
	}

	// Default: Start MCP Server
	const transport = new StdioServerTransport();
	await server.connect(transport);
}

main().catch((error) => {
	console.error('Fatal error starting MCP server:', error);
	process.exit(1);
});
