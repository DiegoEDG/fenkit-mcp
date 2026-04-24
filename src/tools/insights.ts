import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { InsightsBridgeClient } from '@lib/insights-bridge-client.js';
import { throwAsMcpError } from '@lib/mcp-error.js';

const bridgeClient = new InsightsBridgeClient();

function formatJson(data: Record<string, unknown>): string {
	return JSON.stringify(data, null, 2);
}

export function registerInsightsTools(server: McpServer): void {
	// insights_get_context
	server.tool(
		'insights_get_context',
		'Get project context from Insights Bridge: sessions, recent observations, and prompts.',
		{
			project: z.string().min(1).max(120).describe('Project ID or slug')
		},
		async (input) => {
			try {
				const result = await bridgeClient.getContext(input.project);
				return { content: [{ type: 'text' as const, text: formatJson(result) }] };
			} catch (err: unknown) {
				throwAsMcpError(err, { toolName: 'insights_get_context' });
			}
		}
	);

	// insights_search
	server.tool(
		'insights_search',
		'Search observations and prompts in the Insights Bridge.',
		{
			project: z.string().min(1).max(120).describe('Project ID or slug'),
			query: z.string().min(1).max(500).describe('Search query'),
			limit: z.number().int().min(1).max(100).optional().describe('Max results (default 20)')
		},
		async (input) => {
			try {
				const result = await bridgeClient.search(input.project, input.query, input.limit);
				return { content: [{ type: 'text' as const, text: formatJson(result) }] };
			} catch (err: unknown) {
				throwAsMcpError(err, { toolName: 'insights_search' });
			}
		}
	);

	// insights_refresh
	server.tool(
		'insights_refresh',
		'Trigger reconciliation: fetch latest data from the memory provider and sync to local mirror.',
		{
			project: z.string().min(1).max(120).describe('Project ID or slug')
		},
		async (input) => {
			try {
				const result = await bridgeClient.refresh(input.project);
				return { content: [{ type: 'text' as const, text: formatJson(result) }] };
			} catch (err: unknown) {
				throwAsMcpError(err, { toolName: 'insights_refresh' });
			}
		}
	);

	// insights_delete
	server.tool(
		'insights_delete',
		'Delete an insight item from the source provider. This is irreversible.',
		{
			id: z.string().min(1).max(120).describe('Bridge item ID to delete'),
			type: z.enum(['observation', 'prompt']).describe('Item type')
		},
		async (input) => {
			try {
				const result = await bridgeClient.deleteItem(input.id, input.type);
				return { content: [{ type: 'text' as const, text: formatJson(result) }] };
			} catch (err: unknown) {
				throwAsMcpError(err, { toolName: 'insights_delete' });
			}
		}
	);

	// insights_sync_status
	server.tool(
		'insights_sync_status',
		'Get the sync status for a project: pending count, failed count, last synced.',
		{
			project: z.string().min(1).max(120).describe('Project ID or slug')
		},
		async (input) => {
			try {
				const result = await bridgeClient.getSyncStatus(input.project);
				return { content: [{ type: 'text' as const, text: formatJson(result) }] };
			} catch (err: unknown) {
				throwAsMcpError(err, { toolName: 'insights_sync_status' });
			}
		}
	);

	// insights_bridge_status
	server.tool(
		'insights_bridge_status',
		'Check whether the Insights Bridge is installed, initialized, running, and healthy.',
		{},
		async () => {
			try {
				const result = await bridgeClient.getStatus();
				return { content: [{ type: 'text' as const, text: formatJson(result) }] };
			} catch (err: unknown) {
				throwAsMcpError(err, { toolName: 'insights_bridge_status' });
			}
		}
	);

	// insights_bridge_init
	server.tool(
		'insights_bridge_init',
		'Initialize local bridge configuration and data directory.',
		{
			dataDir: z.string().min(1).max(500).optional().describe('Data directory path'),
			defaultProvider: z.string().min(1).max(50).optional().describe('Provider name (default: engram)'),
			project: z.string().min(1).max(120).optional().describe('Project ID')
		},
		async (input) => {
			try {
				const result = await bridgeClient.init(input as Record<string, unknown>);
				return { content: [{ type: 'text' as const, text: formatJson(result) }] };
			} catch (err: unknown) {
				throwAsMcpError(err, { toolName: 'insights_bridge_init' });
			}
		}
	);

	// insights_bridge_start
	server.tool(
		'insights_bridge_start',
		'Start the local Insights Bridge process.',
		{
			port: z.number().int().min(1024).max(65535).optional().describe('Port to run on (default: 7438)'),
			background: z.boolean().optional().describe('Run in background (default: true)')
		},
		async (input) => {
			try {
				const result = await bridgeClient.start(input as Record<string, unknown>);
				return { content: [{ type: 'text' as const, text: formatJson(result) }] };
			} catch (err: unknown) {
				throwAsMcpError(err, { toolName: 'insights_bridge_start' });
			}
		}
	);

	// insights_bridge_doctor
	server.tool(
		'insights_bridge_doctor',
		'Run full diagnostics on the Insights Bridge: installation, configuration, provider connectivity, and runtime health.',
		{},
		async () => {
			try {
				const result = await bridgeClient.doctor();
				return { content: [{ type: 'text' as const, text: formatJson(result) }] };
			} catch (err: unknown) {
				throwAsMcpError(err, { toolName: 'insights_bridge_doctor' });
			}
		}
	);
}
