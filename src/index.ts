#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAuthTools } from './tools/auth.js';
import { registerProjectTools } from './tools/projects.js';
import { registerTaskReadTools } from './tools/task-read.js';
import { registerTaskWriteTools } from './tools/task-write.js';
import { registerSetupTools, setupHandlers, CLIENTS, ClientType } from './tools/setup.js';

type ServerMode = 'all' | 'runtime' | 'admin';

function parseMode(args: string[]): { mode: ServerMode; args: string[] } {
	const modeArg = args.find((arg) => arg.startsWith('--mode='));
	if (!modeArg) return { mode: 'all', args };
	const raw = modeArg.slice('--mode='.length);
	const mode: ServerMode = raw === 'runtime' || raw === 'admin' ? raw : 'all';
	return { mode, args: args.filter((arg) => arg !== modeArg) };
}

// Start the server with stdio transport
async function main(): Promise<void> {
	const parsed = parseMode(process.argv.slice(2));
	const args = parsed.args;
	const mode = parsed.mode;

	const server = new McpServer({
		name: mode === 'all' ? 'fenkit-mcp' : `fenkit-mcp-${mode}`,
		version: '1.0.0',
		description:
			'Fenkit MCP Server — LLM-native task coordination layer for AI agents. Discover, plan, execute, and track tasks in the Fenkit platform.'
	});

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

	if (mode === 'admin') {
		registerAuthTools(server, { includeLogin: true, includeStatus: true });
		registerSetupTools(server);
	} else if (mode === 'runtime') {
		registerAuthTools(server, { includeLogin: false, includeStatus: true });
		registerProjectTools(server);
		registerTaskReadTools(server);
		registerTaskWriteTools(server);
	} else {
		// Backward-compatible single-server mode
		registerAuthTools(server);
		registerProjectTools(server);
		registerTaskReadTools(server);
		registerTaskWriteTools(server);
		registerSetupTools(server);
	}

	// Default: Start MCP Server
	const transport = new StdioServerTransport();
	await server.connect(transport);
}

main().catch((error) => {
	console.error('Fatal error starting MCP server:', error);
	process.exit(1);
});
