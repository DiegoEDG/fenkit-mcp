import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { requireProject } from '../config.js';
import { getApiClient, formatApiError } from '../api.js';
import { PlanSchema, WalkthroughSchema } from '../schemas.js';
import { buildExecutionMetadata } from '../utils.js';

interface TaskResponse {
  id: string;
  plan?: string | null;
  walkthrough?: string | null;
  implementationMetadata?: Record<string, unknown> | null;
}

/**
 * Phase 2 + 3: Task write tools
 * PRD Sections 6.4, 8.2 (auto-inject execution_metadata on writes)
 */
export function registerTaskWriteTools(server: McpServer): void {
  // update_task_plan — PATCH with structured plan
  server.tool(
    'update_task_plan',
    'Submit or update an implementation plan for a task. The plan must follow the structured schema with summary, steps, files_affected, etc. Use this after retrieving a task with `get_full_task` and analyzing the requirements. Plans are versioned — previous versions are preserved in history.',
    {
      taskId: z.string().describe('Task ID (full UUID or truncated prefix)'),
      plan: PlanSchema,
      model: z.string().describe('Model used for this plan (e.g. "claude-sonnet-4-20250514")'),
      agent: z.string().describe('Agent/client name (e.g. "cursor", "claude-desktop")'),
    },
    async ({ taskId, plan, model, agent }) => {
      try {
        // Validate plan schema
        const parsed = PlanSchema.parse(plan);
        const planContent = JSON.stringify(parsed, null, 2);

        const config = requireProject();
        const api = getApiClient();

        // Fetch current task for metadata context
        const { data: currentTask } = await api.get<TaskResponse>(
          `/projects/${config.currentProjectId}/tasks/${taskId}`,
        );

        const existingMetadata = (currentTask.implementationMetadata as Record<string, unknown>) || {};
        const history = (existingMetadata.history as unknown[]) || [];

        // Build execution metadata (Phase 3: auto-inject)
        const execution = buildExecutionMetadata(planContent, {
          model,
          agent,
          lastRetrievedAt: existingMetadata.lastRetrievedAt as string | undefined,
        });

        const updatedMetadata = {
          ...existingMetadata,
          lastExecution: execution,
          history: [...history, { ...execution, action: 'update_plan' }],
        };

        await api.patch(`/projects/${config.currentProjectId}/tasks/${taskId}`, {
          plan: planContent,
          implementationMetadata: updatedMetadata,
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: `✔ Plan updated for task \`${taskId}\`.\n\n**Steps**: ${parsed.steps.length}\n**Files affected**: ${parsed.files_affected.length}\n**Complexity**: ${parsed.estimated_complexity || 'not specified'}`,
            },
          ],
        };
      } catch (error) {
        if (error instanceof z.ZodError) {
          const issues = error.issues.map((i) => `- ${i.path.join('.')}: ${i.message}`).join('\n');
          return {
            content: [{ type: 'text' as const, text: `INVALID_INPUT: Plan validation failed:\n${issues}` }],
            isError: true,
          };
        }
        const err = formatApiError(error);
        return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }], isError: true };
      }
    },
  );

  // update_task_walkthrough — PATCH with structured walkthrough
  server.tool(
    'update_task_walkthrough',
    'Submit or update an implementation walkthrough for a task. The walkthrough must follow the structured schema with summary, changes, files_modified, decisions, testing, etc. Use this after completing implementation work. Walkthroughs are versioned — previous versions are preserved in history.',
    {
      taskId: z.string().describe('Task ID (full UUID or truncated prefix)'),
      walkthrough: WalkthroughSchema,
      model: z.string().describe('Model used for this walkthrough'),
      agent: z.string().describe('Agent/client name'),
    },
    async ({ taskId, walkthrough, model, agent }) => {
      try {
        const parsed = WalkthroughSchema.parse(walkthrough);
        const walkthroughContent = JSON.stringify(parsed, null, 2);

        const config = requireProject();
        const api = getApiClient();

        const { data: currentTask } = await api.get<TaskResponse>(
          `/projects/${config.currentProjectId}/tasks/${taskId}`,
        );

        const existingMetadata = (currentTask.implementationMetadata as Record<string, unknown>) || {};
        const history = (existingMetadata.history as unknown[]) || [];

        const execution = buildExecutionMetadata(walkthroughContent, {
          model,
          agent,
          lastRetrievedAt: existingMetadata.lastRetrievedAt as string | undefined,
        });

        const updatedMetadata = {
          ...existingMetadata,
          lastExecution: execution,
          history: [...history, { ...execution, action: 'update_walkthrough' }],
        };

        await api.patch(`/projects/${config.currentProjectId}/tasks/${taskId}`, {
          walkthrough: walkthroughContent,
          implementationMetadata: updatedMetadata,
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: `✔ Walkthrough updated for task \`${taskId}\`.\n\n**Changes**: ${parsed.changes.length}\n**Files modified**: ${parsed.files_modified.length}`,
            },
          ],
        };
      } catch (error) {
        if (error instanceof z.ZodError) {
          const issues = error.issues.map((i) => `- ${i.path.join('.')}: ${i.message}`).join('\n');
          return {
            content: [{ type: 'text' as const, text: `INVALID_INPUT: Walkthrough validation failed:\n${issues}` }],
            isError: true,
          };
        }
        const err = formatApiError(error);
        return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }], isError: true };
      }
    },
  );

  // update_task_metadata — PATCH for status/priority changes
  server.tool(
    'update_task_metadata',
    'Update task status, priority, or other metadata fields. Use this for lifecycle transitions (e.g. moving a task from "todo" to "in_progress" or marking it "done").',
    {
      taskId: z.string().describe('Task ID (full UUID or truncated prefix)'),
      status: z.string().optional().describe('New status: todo, in_progress, done, backlog, frozen'),
      priority: z.string().optional().describe('New priority: low, medium, high, urgent'),
      model: z.string().describe('Model used (for execution metadata tracking)'),
      agent: z.string().describe('Agent/client name'),
    },
    async ({ taskId, status, priority, model, agent }) => {
      try {
        const config = requireProject();
        const api = getApiClient();

        const updatePayload: Record<string, unknown> = {};
        if (status) updatePayload.status = status;
        if (priority) updatePayload.priority = priority;

        if (Object.keys(updatePayload).length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'INVALID_INPUT: Must provide at least one of: status, priority' }],
            isError: true,
          };
        }

        // Fetch current metadata for history tracking
        const { data: currentTask } = await api.get<TaskResponse>(
          `/projects/${config.currentProjectId}/tasks/${taskId}`,
        );

        const existingMetadata = (currentTask.implementationMetadata as Record<string, unknown>) || {};
        const history = (existingMetadata.history as unknown[]) || [];

        const execution = buildExecutionMetadata(JSON.stringify(updatePayload), {
          model,
          agent,
          lastRetrievedAt: existingMetadata.lastRetrievedAt as string | undefined,
        });

        updatePayload.implementationMetadata = {
          ...existingMetadata,
          lastExecution: execution,
          history: [...history, { ...execution, action: 'update_metadata', changes: updatePayload }],
        };

        await api.patch(`/projects/${config.currentProjectId}/tasks/${taskId}`, updatePayload);

        const changes = [];
        if (status) changes.push(`Status → ${status}`);
        if (priority) changes.push(`Priority → ${priority}`);

        return {
          content: [
            {
              type: 'text' as const,
              text: `✔ Task \`${taskId}\` updated: ${changes.join(', ')}`,
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
