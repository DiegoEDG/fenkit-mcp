import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getApiClientAsync } from '@lib/api.js';
import { throwAsMcpError } from '@lib/mcp-error.js';

function formatJson(data: Record<string, unknown>): string {
	return JSON.stringify(data, null, 2);
}

export function registerInsightsTools(server: McpServer): void {
	// insights_get_context
	server.tool(
		'insights_get_context',
		'Get project insights from the FENKIT backend: recent observations.',
		{
			project: z.string().min(1).max(120).describe('Project ID or slug')
		},
		async (input) => {
			try {
				const api = await getApiClientAsync();
				const { data } = await api.get(`/insights/${input.project}/items`);
				return { content: [{ type: 'text' as const, text: formatJson(data as Record<string, unknown>) }] };
			} catch (err: unknown) {
				throwAsMcpError(err, { toolName: 'insights_get_context' });
			}
		}
	);

	// insights_search
	server.tool(
		'insights_search',
		'Search observations in the FENKIT backend.',
		{
			project: z.string().min(1).max(120).describe('Project ID or slug'),
			query: z.string().min(1).max(500).describe('Search query'),
			limit: z.number().int().min(1).max(100).optional().describe('Max results (default 20)')
		},
		async (input) => {
			try {
				const api = await getApiClientAsync();
				const { data } = await api.get(`/insights/${input.project}/search`, {
					params: { q: input.query, limit: input.limit ?? 20 }
				});
				return { content: [{ type: 'text' as const, text: formatJson(data as Record<string, unknown>) }] };
			} catch (err: unknown) {
				throwAsMcpError(err, { toolName: 'insights_search' });
			}
		}
	);

	// insights_delete
	server.tool(
		'insights_delete',
		'Delete an insight item from the FENKIT backend. This is irreversible.',
		{
			project: z.string().min(1).max(120).describe('Project ID or slug'),
			providerItemId: z.string().min(1).max(120).describe('Provider item ID to delete')
		},
		async (input) => {
			try {
				const api = await getApiClientAsync();
				const { data } = await api.delete(`/insights/${input.project}/items/${input.providerItemId}`, {
					data: {
						entityType: 'observation',
						entityId: input.providerItemId,
						providerItemId: input.providerItemId
					}
				});
				return { content: [{ type: 'text' as const, text: formatJson(data as Record<string, unknown>) }] };
			} catch (err: unknown) {
				throwAsMcpError(err, { toolName: 'insights_delete' });
			}
		}
	);

	// insights_sync_status
	server.tool(
		'insights_sync_status',
		'Get the sync status for a project from the FENKIT backend.',
		{
			project: z.string().min(1).max(120).describe('Project ID or slug')
		},
		async (input) => {
			try {
				const api = await getApiClientAsync();
				const { data } = await api.get(`/insights/${input.project}/sync/status`);
				return { content: [{ type: 'text' as const, text: formatJson(data as Record<string, unknown>) }] };
			} catch (err: unknown) {
				throwAsMcpError(err, { toolName: 'insights_sync_status' });
			}
		}
	);
}
