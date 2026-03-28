import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { requireAuth, saveConfig } from '../config.js';
import { getApiClient, formatApiError } from '../api.js';

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

        const { loadConfig } = await import('../config.js');
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
    },
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ projectId }) => {
      try {
        requireAuth();
        const api = getApiClient();
        const { data } = await api.get<ProjectResponse[]>('/projects');

        const selected = data.find((p) => p.id === projectId || p.id.startsWith(projectId));
        if (!selected) {
          return {
            content: [{ type: 'text' as const, text: `Project "${projectId}" not found. Use \`list_projects\` to see available projects.` }],
            isError: true,
          };
        }

        saveConfig({
          currentProjectId: selected.id,
          currentProjectName: selected.name,
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: `✔ Active project set to **${selected.name}** (\`${selected.id.slice(0, 8)}\`)`,
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
