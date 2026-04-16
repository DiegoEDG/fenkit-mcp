import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import open from 'open';
import { loadConfigAsync, saveConfigAsync } from '@lib/config.js';
import { createApiClient } from '@lib/api.js';
import { getActiveApiUrl, getActiveAppUrl, isLocalDevEnabled, validateServiceUrl } from '@lib/security.js';

interface ProjectResponse {
	id: string;
	name: string;
	description?: string;
}

const CallbackPayloadSchema = z
	.object({
		token: z.string().min(1),
		state: z.string().min(1)
	})
	.strict();

const MAX_CALLBACK_BODY_BYTES = 16 * 1024;

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
function waitForToken(port: number, expectedState: string, allowedOrigin: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const timeoutRef: { current?: ReturnType<typeof setTimeout> } = {};
		let settled = false;
		const finalize = (fn: () => void): void => {
			if (settled) return;
			settled = true;
			if (timeoutRef.current) clearTimeout(timeoutRef.current);
			fn();
		};
		const isAllowedOrigin = (origin: string | undefined): boolean => origin === allowedOrigin;
		const setCorsHeaders = (res: http.ServerResponse): void => {
			res.setHeader('Vary', 'Origin');
			res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
			res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
			res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
		};

		const server = http.createServer((req, res) => {
			const requestOrigin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;

			if (req.method === 'OPTIONS') {
				if (!isAllowedOrigin(requestOrigin)) {
					res.writeHead(403, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: 'Origin not allowed' }));
					return;
				}
				setCorsHeaders(res);
				res.writeHead(204);
				res.end();
				return;
			}

			if (req.method === 'POST' && req.url === '/callback') {
				if (!isAllowedOrigin(requestOrigin)) {
					res.writeHead(403, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: 'Origin not allowed' }));
					return;
				}
				setCorsHeaders(res);

				const contentType = req.headers['content-type'];
				if (!contentType?.includes('application/json')) {
					res.writeHead(415, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: 'Content-Type must be application/json' }));
					return;
				}
				const contentLengthHeader = req.headers['content-length'];
				if (contentLengthHeader) {
					const contentLength = Number.parseInt(contentLengthHeader, 10);
					if (!Number.isNaN(contentLength) && contentLength > MAX_CALLBACK_BODY_BYTES) {
						res.writeHead(413, { 'Content-Type': 'application/json' });
						res.end(JSON.stringify({ error: 'Request body too large' }));
						return;
					}
				}

				let body = '';
				let bodySize = 0;
				let rejectedForSize = false;
				req.on('data', (chunk: Buffer) => {
					bodySize += chunk.length;
					if (bodySize > MAX_CALLBACK_BODY_BYTES) {
						rejectedForSize = true;
						res.writeHead(413, { 'Content-Type': 'application/json' });
						res.end(JSON.stringify({ error: 'Request body too large' }));
						req.destroy();
						return;
					}
					body += chunk.toString();
				});
				req.on('end', () => {
					if (rejectedForSize) return;
					try {
						const parsed = CallbackPayloadSchema.parse(JSON.parse(body));
						if (parsed.state !== expectedState) {
							res.writeHead(401, { 'Content-Type': 'application/json' });
							res.end(JSON.stringify({ error: 'Invalid auth state' }));
							return;
						}
						res.writeHead(200, { 'Content-Type': 'application/json' });
						res.end(JSON.stringify({ ok: true }));
						finalize(() => {
							server.close();
							resolve(parsed.token);
						});
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
			finalize(() => reject(err));
		});

		// Timeout after 2 minutes
		timeoutRef.current = setTimeout(() => {
			finalize(() => {
				server.close();
				reject(new Error('Authentication timed out after 2 minutes.'));
			});
		}, 120_000);
	});
}

/**
 * Phase 1: Authentication tools
 * PRD Section 6.5 + 9
 */
export function registerAuthTools(
	server: McpServer,
	options?: { includeLogin?: boolean; includeStatus?: boolean }
): void {
	const includeLogin = options?.includeLogin ?? true;
	const includeStatus = options?.includeStatus ?? true;

	// login — Shared handler for browser-based auth
	const loginHandler = async () => {
		const resolvedAppUrl = getActiveAppUrl();
		const resolvedApiUrl = getActiveApiUrl();
		let validatedAppUrl: ReturnType<typeof validateServiceUrl>;
		let validatedApiUrl: ReturnType<typeof validateServiceUrl>;
		try {
			validatedAppUrl = validateServiceUrl(resolvedAppUrl, 'app');
			validatedApiUrl = validateServiceUrl(resolvedApiUrl, 'api');
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Invalid URL';
			return {
				content: [{ type: 'text' as const, text: `❌ ${message}` }],
				isError: true
			};
		}

		const authState = randomBytes(16).toString('hex');

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

		const authUrl = `${validatedAppUrl.url}/tool-auth?port=${port}&tool=mcp&state=${authState}`;

		// Start the token receiver before opening the browser
		const tokenPromise = waitForToken(port, authState, validatedAppUrl.origin);

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

		let projects: ProjectResponse[];
		let autoSelectedProjectName: string | undefined;
		try {
			const api = createApiClient({ apiUrl: validatedApiUrl.url, token });
			const { data } = await api.get<ProjectResponse[]>('/projects');
			projects = data;
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown validation error';
			return {
				content: [
					{
						type: 'text' as const,
						text: `❌ Authentication failed: token validation against API failed (${message}).`
					}
				],
				isError: true
			};
		}

		const configUpdate: Parameters<typeof saveConfigAsync>[0] = {
			token
		};

		if (projects.length === 1) {
			const project = projects[0];
			if (!project) {
				return {
					content: [
						{
							type: 'text' as const,
							text: '⚠️ Received an empty project list. Token saved but no project was auto-selected.'
						}
					]
				};
			}
			configUpdate.currentProjectId = project.id;
			configUpdate.currentProjectName = project.name;
			autoSelectedProjectName = project.name;
		}

		await saveConfigAsync(configUpdate);

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
	if (includeLogin) {
		server.tool(
			'login',
			'Authenticate via browser. Opens a browser window pointing to the Fenkit app, waits for authentication, then saves the token automatically.',
			{},
			{
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true
			},
			loginHandler
		);
	}

	// get_status — Returns current auth and project status
	if (includeStatus) {
		server.tool(
			'get_status',
			'Check current authentication status and active project. Call this to verify your setup before starting work.',
			{},
			{
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false
			},
			async () => {
				const config = await loadConfigAsync();
				const authenticated = !!config.token;
				const hasProject = !!config.currentProjectId;

				const lines = [
					`**Authenticated**: ${authenticated ? '✅ Yes' : "❌ No — run 'login' first"}`,
					`**Environment**: ${isLocalDevEnabled() ? '🧪 Localhost' : '🚀 Production'}`,
					`**API URL**: ${getActiveApiUrl()}`
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
}
