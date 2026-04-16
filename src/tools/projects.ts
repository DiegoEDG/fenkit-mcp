import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { requireAuth, saveConfig } from '../lib/config.js';
import { getApiClient, formatApiError } from '../lib/api.js';
import { OperationIdSchema, TokensSchema } from '../lib/schemas.js';
import { stableHash } from '../lib/observability.js';
import {
	consumeConfirmationToken,
	isSensitiveConfirmationEnabled,
	issueConfirmationToken
} from '../lib/confirmation.js';
import {
	appendLocalAuditLog,
	checkLocalIdempotency,
	recordLocalOperation
} from '../lib/write-audit.js';

interface ProjectResponse {
  id: string;
  name: string;
  description?: string;
}

/**
 * Phase 1: Project management tools
 * PRD Section 6.1
 */
export function registerProjectTools(server: McpServer): void {
  // list_projects — GET /projects
  server.tool(
    'list_projects',
    'Use when the user asks which Fenkit projects are available before choosing one.',
    {},
    {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    async () => {
      try {
        requireAuth();
        const api = getApiClient();
        const { data } = await api.get<ProjectResponse[]>('/projects');

        if (data.length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'No projects found. Create one in the Fenkit web UI first.' }],
          };
        }

        const { loadConfig } = await import('../lib/config.js');
        const config = loadConfig();

        const lines = data.map((p) => {
          const active = p.id === config.currentProjectId ? ' ← **active**' : '';
          return `- **${p.name}** (\`${p.id.slice(0, 8)}\`)${p.description ? ` — ${p.description}` : ''}${active}`;
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: `## Projects\n\n${lines.join('\n')}`,
            },
          ],
        };
      } catch (error) {
        const err = formatApiError(error);
        return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }], isError: true };
      }
    },
  );

  // get_active_project — reads config
  server.tool(
    'get_active_project',
    'Use when the user asks which project is currently active for subsequent task operations.',
    {},
    {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async () => {
      try {
        const config = requireAuth();
        if (!config.currentProjectId) {
          return {
            content: [{ type: 'text' as const, text: 'No active project. Use `list_projects` and `select_project` to choose one.' }],
          };
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: `**Active Project**: ${config.currentProjectName || 'Unknown'}\n**ID**: \`${config.currentProjectId}\``,
            },
          ],
        };
      } catch (error) {
        const err = formatApiError(error);
        return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }], isError: true };
      }
    },
  );

  // select_project — updates currentProjectId in config
  server.tool(
    'select_project',
    'Use when the user explicitly asks to switch task context to a different project.',
    {
      projectId: z.string().trim().min(4).max(64).describe('Project ID to select as active'),
      operation_id: OperationIdSchema.optional().describe(
        'Client-generated idempotency key for this write (recommended)',
      ),
      model: z
        .string()
        .trim()
        .min(1)
        .max(120)
        .optional()
        .describe('Model used (MCP event metadata)'),
      agent: z
        .string()
        .trim()
        .min(1)
        .max(80)
        .optional()
        .describe('Agent/client name (MCP event metadata)'),
      tokens: TokensSchema.optional().describe('Optional token usage for this write operation'),
      mode: z
        .enum(['preview', 'execute'])
        .optional()
        .describe('Confirmation mode: preview issues token, execute performs mutation'),
      confirmation_token: z
        .string()
        .trim()
        .min(8)
        .max(200)
        .optional()
        .describe('Token returned by preview mode for sensitive confirmations'),
    },
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ projectId, operation_id, model, agent, tokens, mode, confirmation_token }) => {
      try {
        const config = requireAuth();
        const api = getApiClient();
        const { data } = await api.get<ProjectResponse[]>('/projects');

        const selected = data.find((p) => p.id === projectId || p.id.startsWith(projectId));
        if (!selected) {
          return {
            content: [{ type: 'text' as const, text: `Project "${projectId}" not found. Use \`list_projects\` to see available projects.` }],
            isError: true,
          };
        }

        const payloadHash = stableHash({
          project_id: selected.id,
          previous_project_id: config.currentProjectId || null,
        });
        const executionMode =
          mode ?? (isSensitiveConfirmationEnabled() ? 'preview' : 'execute');
        const scope = `project:${selected.id}`;
        const operationId =
          operation_id ?? `select_project:${Date.now()}:${selected.id.substring(0, 8)}`;
        const actor = agent ?? 'mcp-client';

        if (executionMode === 'preview') {
          const confirmation = issueConfirmationToken({
            tool: 'select_project',
            payloadHash,
            scope,
            actor,
          });
          return {
            content: [
              {
                type: 'text' as const,
                text: [
                  `## select_project · preview`,
                  `- from: ${config.currentProjectName || 'none'} (${config.currentProjectId || 'n/a'})`,
                  `- to: ${selected.name} (${selected.id})`,
                  `- operation_id: ${operationId}`,
                  `- payload_hash: ${payloadHash}`,
                  `- confirmation_token: ${confirmation.token}`,
                  `- confirmation_expires_at: ${confirmation.expiresAt}`,
                  `- result_code: preview_ready`,
                ].join('\n'),
              },
            ],
          };
        }

        let confirmationMeta:
          | { tokenId: string; confirmedAt: string; requestedAt: string }
          | undefined;
        if (isSensitiveConfirmationEnabled()) {
          if (!confirmation_token) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: 'CONFIRMATION_REQUIRED: call with mode="preview" first, then execute with confirmation_token.',
                },
              ],
              isError: true,
            };
          }
          confirmationMeta = consumeConfirmationToken({
            token: confirmation_token,
            tool: 'select_project',
            payloadHash,
            scope,
            actor,
          });
        }

        const localIdempotency = checkLocalIdempotency(
          'select_project',
          operationId,
          payloadHash,
        );
        if (localIdempotency === 'idempotency_conflict') {
          return {
            content: [
              {
                type: 'text' as const,
                text: `IDEMPOTENCY_CONFLICT: operation_id "${operationId}" was reused with a different payload.`,
              },
            ],
            isError: true,
          };
        }
        if (localIdempotency === 'duplicate_replayed') {
          return {
            content: [
              {
                type: 'text' as const,
                text: `✔ Duplicate replay accepted for select_project.\n\nresult_code: duplicate_replayed`,
              },
            ],
          };
        }

        saveConfig({
          currentProjectId: selected.id,
          currentProjectName: selected.name,
        });
        recordLocalOperation('select_project', operationId, payloadHash);
        appendLocalAuditLog({
          tool: 'select_project',
          operation_id: operationId,
          payload_hash: payloadHash,
          actor,
          model: model || 'unknown',
          tokens,
          result_code: 'applied',
          from_project_id: config.currentProjectId || null,
          to_project_id: selected.id,
          confirmation_id: confirmationMeta?.tokenId,
          confirmation_confirmed_at: confirmationMeta?.confirmedAt,
          confirmation_requested_at: confirmationMeta?.requestedAt,
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: `✔ Active project set to **${selected.name}** (\`${selected.id.slice(0, 8)}\`)\n\nresult_code: applied`,
            },
          ],
        };
      } catch (error) {
        const err = formatApiError(error);
        return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }], isError: true };
      }
    },
  );
}
