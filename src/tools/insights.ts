import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getApiClientAsync } from '@lib/api.js';
import { getBridgeClient, formatBridgeError, isBridgeReachable } from '@lib/bridge-client.js';
import { throwAsMcpError } from '@lib/mcp-error.js';
import { loadConfigAsync } from '@lib/config.js';

function formatJson(data: Record<string, unknown>): string {
	return JSON.stringify(data, null, 2);
}

/**
 * Resolve project identifier to full UUID.
 * If input matches current project slug or is empty, use config's currentProjectId.
 * Otherwise, return input as-is (assumed to be a full UUID).
 */
async function resolveProjectId(projectInput: string): Promise<string> {
	// If empty or matches current project name (slug), use config's currentProjectId
	if (!projectInput) {
		const config = await loadConfigAsync();
		return config.currentProjectId || projectInput;
	}

	const config = await loadConfigAsync();
	const currentSlug = config.currentProjectName?.toLowerCase().replace(/[^a-z0-9]/g, '');
	const inputSlug = projectInput.toLowerCase().replace(/[^a-z0-9]/g, '');

	// If input matches current project slug, use currentProjectId
	if (currentSlug && inputSlug === currentSlug) {
		return config.currentProjectId || projectInput;
	}

	// Otherwise return input as-is (could be a full UUID or different project)
	return projectInput;
}

export function registerInsightsTools(server: McpServer): void {
	// ─── Bridge Orchestration Tools ───

	// insights_bridge_status
	server.tool(
		'insights_bridge_status',
		'Check the status of the local Insights bridge daemon.',
		{},
		async () => {
			try {
				const bridge = getBridgeClient();
				const { data } = await bridge.get('/bridge/status');
				return { content: [{ type: 'text' as const, text: formatJson(data as Record<string, unknown>) }] };
			} catch (err: unknown) {
				const formatted = formatBridgeError(err);
				return {
					content: [{ type: 'text' as const, text: formatJson({ error: formatted.message, code: formatted.code }) }],
					isError: true,
				};
			}
		}
	);

	// insights_bridge_init
	server.tool(
		'insights_bridge_init',
		'Initialize the local Insights bridge configuration.',
		{},
		async () => {
			try {
				const bridge = getBridgeClient();
				const { data } = await bridge.post('/bridge/init');
				return { content: [{ type: 'text' as const, text: formatJson(data as Record<string, unknown>) }] };
			} catch (err: unknown) {
				const formatted = formatBridgeError(err);
				return {
					content: [{ type: 'text' as const, text: formatJson({ error: formatted.message, code: formatted.code }) }],
					isError: true,
				};
			}
		}
	);

	// insights_bridge_start
	server.tool(
		'insights_bridge_start',
		'Start the local Insights bridge daemon in the background.',
		{},
		async () => {
			try {
				const bridge = getBridgeClient();
				const { data } = await bridge.post('/bridge/start');
				return { content: [{ type: 'text' as const, text: formatJson(data as Record<string, unknown>) }] };
			} catch (err: unknown) {
				const formatted = formatBridgeError(err);
				return {
					content: [{ type: 'text' as const, text: formatJson({ error: formatted.message, code: formatted.code }) }],
					isError: true,
				};
			}
		}
	);

	// insights_bridge_stop
	server.tool(
		'insights_bridge_stop',
		'Stop the local Insights bridge daemon.',
		{},
		async () => {
			try {
				const bridge = getBridgeClient();
				const { data } = await bridge.post('/bridge/stop');
				return { content: [{ type: 'text' as const, text: formatJson(data as Record<string, unknown>) }] };
			} catch (err: unknown) {
				const formatted = formatBridgeError(err);
				return {
					content: [{ type: 'text' as const, text: formatJson({ error: formatted.message, code: formatted.code }) }],
					isError: true,
				};
			}
		}
	);

	// insights_bridge_doctor
	server.tool(
		'insights_bridge_doctor',
		'Diagnose the Insights bridge and provide actionable recommendations.',
		{},
		async () => {
			try {
				const bridge = getBridgeClient();
				const { data } = await bridge.get('/bridge/doctor');
				return { content: [{ type: 'text' as const, text: formatJson(data as Record<string, unknown>) }] };
			} catch (err: unknown) {
				const formatted = formatBridgeError(err);
				return {
					content: [{ type: 'text' as const, text: formatJson({ error: formatted.message, code: formatted.code }) }],
					isError: true,
				};
			}
		}
	);

	// insights_refresh
	server.tool(
		'insights_refresh',
		'Trigger a sync cycle for the active project through the bridge.',
		{
			project: z.string().min(1).max(120).describe('Project ID or slug')
		},
		async (input) => {
			try {
				const bridge = getBridgeClient();
				const { data } = await bridge.post('/insights/refresh', { project: input.project });
				return { content: [{ type: 'text' as const, text: formatJson(data as Record<string, unknown>) }] };
			} catch (err: unknown) {
				const formatted = formatBridgeError(err);
				return {
					content: [{ type: 'text' as const, text: formatJson({ error: formatted.message, code: formatted.code }) }],
					isError: true,
				};
			}
		}
	);

	// ─── Data Query Tools (Backend) ───

	// insights_get_context
	server.tool(
		'insights_get_context',
		'Get project insights from the FENKIT backend: recent observations.',
		{
			project: z.string().min(1).max(120).describe('Project ID or slug')
		},
		async (input) => {
			try {
				const projectId = await resolveProjectId(input.project);
				const api = await getApiClientAsync();
				const { data } = await api.get(`/insights/${projectId}/items`);
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
				const projectId = await resolveProjectId(input.project);
				const api = await getApiClientAsync();
				const { data } = await api.get(`/insights/${projectId}/search`, {
					params: { q: input.query, limit: input.limit ?? 20 }
				});
				return { content: [{ type: 'text' as const, text: formatJson(data as Record<string, unknown>) }] };
			} catch (err: unknown) {
				throwAsMcpError(err, { toolName: 'insights_search' });
			}
		}
	);

	// insights_delete (orchestration-sensitive: use bridge)
	server.tool(
		'insights_delete',
		'Delete an insight item. This removes it from Engram and enqueues a delete to the backend.',
		{
			project: z.string().min(1).max(120).describe('Project ID or slug'),
			providerItemId: z.string().min(1).max(120).describe('Provider item ID to delete')
		},
		async (input) => {
			try {
				// Prefer bridge delete (handles Engram + outbox)
				const bridgeAvailable = await isBridgeReachable();
				if (bridgeAvailable) {
					const bridge = getBridgeClient();
					const { data } = await bridge.delete(`/insights/items/${input.providerItemId}`, {
						params: { type: 'observation' }
					});
					return { content: [{ type: 'text' as const, text: formatJson(data as Record<string, unknown>) }] };
				}

				// Fallback to backend direct delete
				const projectId = await resolveProjectId(input.project);
				const api = await getApiClientAsync();
				const { data } = await api.delete(`/insights/${projectId}/items/${input.providerItemId}`, {
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

	// insights_sync_status (prefer bridge, fallback to backend)
	server.tool(
		'insights_sync_status',
		'Get the sync status for a project.',
		{
			project: z.string().min(1).max(120).describe('Project ID or slug')
		},
		async (input) => {
			try {
				const bridgeAvailable = await isBridgeReachable();
				if (bridgeAvailable) {
					const bridge = getBridgeClient();
					const { data } = await bridge.get('/bridge/status');
					return { content: [{ type: 'text' as const, text: formatJson(data as Record<string, unknown>) }] };
				}

				// Fallback to backend
				const projectId = await resolveProjectId(input.project);
				const api = await getApiClientAsync();
				const { data } = await api.get(`/insights/${projectId}/sync/status`);
				return { content: [{ type: 'text' as const, text: formatJson(data as Record<string, unknown>) }] };
			} catch (err: unknown) {
				throwAsMcpError(err, { toolName: 'insights_sync_status' });
			}
		}
	);
}
