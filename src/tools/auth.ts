import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import open from 'open';
import { loadConfig, saveConfig } from '../config.js';
import { getApiClient } from '../api.js';

interface ProjectResponse {
	id: string;
	name: string;
	description?: string;
}

/**
 * Finds an available port by letting the OS pick one.
 */
function getAvailablePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = http.createServer();
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (address && typeof address !== 'string') {
				const port = address.port;
				server.close(() => resolve(port));
			} else {
				server.close(() => reject(new Error('Could not determine port')));
			}
		});
		server.on('error', reject);
	});
}

/**
 * Starts a temporary local HTTP server that waits for a token callback
 * from the frontend auth page.
 */
function waitForToken(port: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const server = http.createServer((req, res) => {
			// Enable CORS for the frontend origin
			res.setHeader('Access-Control-Allow-Origin', '*');
			res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
			res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

			if (req.method === 'OPTIONS') {
				res.writeHead(204);
				res.end();
				return;
			}

			if (req.method === 'POST' && req.url === '/callback') {
				let body = '';
				req.on('data', (chunk: Buffer) => {
					body += chunk.toString();
				});
				req.on('end', () => {
					try {
						const { token } = JSON.parse(body) as { token: string };
						res.writeHead(200, { 'Content-Type': 'application/json' });
						res.end(JSON.stringify({ ok: true }));
						server.close();
						resolve(token);
					} catch {
						res.writeHead(400, { 'Content-Type': 'application/json' });
						res.end(JSON.stringify({ error: 'Invalid payload' }));
					}
				});
				return;
			}

			res.writeHead(404);
			res.end();
		});

		server.listen(port, '127.0.0.1');

		server.on('error', (err) => {
			reject(err);
		});

		// Timeout after 2 minutes
		setTimeout(() => {
			server.close();
			reject(new Error('Authentication timed out after 2 minutes.'));
		}, 120_000);
	});
}

/**
 * Phase 1: Authentication tools
 * PRD Section 6.5 + 9
 */
export function registerAuthTools(server: McpServer): void {
	// login — Shared handler for browser-based auth
	const loginHandler = async ({ appUrl, apiUrl }: { appUrl?: string; apiUrl?: string }) => {
		const resolvedAppUrl = appUrl ?? 'https://ickit-fe.vercel.app';
		const resolvedApiUrl = apiUrl ?? 'https://ickit-be.vercel.app/api/v1';

		// Save API URL first so subsequent calls use it
		saveConfig({ apiUrl: resolvedApiUrl });

		let port: number;
		try {
			port = await getAvailablePort();
		} catch {
			return {
				content: [
					{
						type: 'text' as const,
						text: '❌ Could not find an available port for the auth callback server.'
					}
				]
			};
		}

		const authUrl = `${resolvedAppUrl}/tool-auth?port=${port}&tool=mcp`;

		// Start the token receiver before opening the browser
		const tokenPromise = waitForToken(port);

		try {
			await open(authUrl);
		} catch {
			return {
				content: [
					{
						type: 'text' as const,
						text: `❌ Could not open browser. Please visit manually:\n\n${authUrl}`
					}
				]
			};
		}

		let token: string;
		try {
			token = await tokenPromise;
		} catch (err) {
			const message = err instanceof Error ? err.message : 'Unknown error';
			return {
				content: [
					{
						type: 'text' as const,
						text: `❌ Authentication failed: ${message}`
					}
				]
			};
		}

		saveConfig({ token });

		let autoSelectedProjectName: string | undefined;
		try {
			const api = getApiClient(true);
			const { data } = await api.get<ProjectResponse[]>('/projects');

			if (data.length === 1) {
				const project = data[0];
				saveConfig({
					currentProjectId: project.id,
					currentProjectName: project.name
				});
				autoSelectedProjectName = project.name;
			}
		} catch (error) {
			// We don't want to fail the whole login if project fetching fails
			console.error('Failed to fetch projects for auto-selection:', error);
		}

		let successMessage = '✅ Authenticated successfully! Token saved to ~/.fnk/config.json.';
		if (autoSelectedProjectName) {
			successMessage += `\n\n✔ **Auto-selected project**: ${autoSelectedProjectName}. You're ready to go!`;
		} else {
			successMessage += '\n\nUse `list_projects` to see your projects and `select_project` to set an active one.';
		}

		return {
			content: [
				{
					type: 'text' as const,
					text: successMessage
				}
			]
		};
	};

	// Primary login tool
	server.tool(
		'login',
		'Authenticate via browser. Opens a browser window pointing to the Fenkit app, waits for authentication, then saves the token automatically.',
		{
			appUrl: z.string().optional().describe('Frontend app URL (default: https://ickit-fe.vercel.app)'),
			apiUrl: z.string().optional().describe('API base URL (default: https://ickit-be.vercel.app/api/v1)')
		},
		loginHandler
	);

	// get_status — Returns current auth and project status
	server.tool(
		'get_status',
		'Check current authentication status and active project. Call this to verify your setup before starting work.',
		{},
		async () => {
			const config = loadConfig();
			const authenticated = !!config.token;
			const hasProject = !!config.currentProjectId;

			const lines = [
				`**Authenticated**: ${authenticated ? '✅ Yes' : "❌ No — run 'login_browser' first"}`,
				`**API URL**: ${config.apiUrl}`
			];

			if (hasProject) {
				lines.push(`**Active Project**: ${config.currentProjectName || config.currentProjectId}`);
				lines.push(`**Project ID**: ${config.currentProjectId}`);
			} else {
				lines.push('**Active Project**: None — use `list_projects` and `select_project` first');
			}

			return {
				content: [{ type: 'text' as const, text: lines.join('\n') }]
			};
		}
	);
}
