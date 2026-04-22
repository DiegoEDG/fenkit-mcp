import { z } from 'zod';

const ShortTextSchema = z.string().trim().min(1).max(240);
const MediumTextSchema = z.string().trim().min(1).max(2000);
const PathLikeSchema = z.string().trim().min(1).max(260);
const SuggestedGitCommitSchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .regex(
    /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9][a-z0-9-]{0,23}\))?!?: .+ \([a-z0-9]{5}\)$/,
    'Must be a conventional commit ending with a 5-char task id, e.g. "feat(scope): message (2f83b)"'
  );

export const TaskStatusSchema = z.enum(['todo', 'in_progress', 'in_review', 'backlog', 'frozen']);
export const TaskPrioritySchema = z.enum(['low', 'medium', 'high', 'urgent']);
export const TaskIdentifierSchema = z
  .string()
  .trim()
  .min(4)
  .max(64)
  .regex(/^[a-zA-Z0-9-]+$/, 'Task ID must contain only letters, numbers, and dashes');
export const OperationIdSchema = z
  .string()
  .trim()
  .min(8)
  .max(128)
  .regex(/^[a-zA-Z0-9._:-]+$/, 'operation_id contains invalid characters');

export const ArtifactModeSchema = z
  .enum(['mini', 'full'])
  .describe('Artifact detail level. Use "full" when the agent already produced a complete artifact (e.g. plan mode).');
export type ArtifactMode = z.infer<typeof ArtifactModeSchema>;

// --- PRD 4.2: Plan Schema ---
export const PlanSchema = z.object({
  summary: MediumTextSchema.describe('Brief summary of the implementation plan'),
  steps: z.array(ShortTextSchema).min(1).max(40).describe('Ordered list of implementation steps'),
  files_affected: z.array(PathLikeSchema).min(1).max(80).describe('Files that will be created or modified'),
  risks: z.array(ShortTextSchema).max(20).optional().describe('Potential risks or blockers'),
  assumptions: z.array(ShortTextSchema).max(20).optional().describe('Assumptions made during planning'),
  open_questions: z.array(ShortTextSchema).max(20).optional().describe('Unresolved questions'),
  estimated_complexity: z.enum(['low', 'medium', 'high']).optional().describe('Estimated task complexity'),
  notes: z.string().trim().max(12000).optional().describe('Free-form narrative context (markdown). Do not duplicate structured fields.'),
}).strict();
export type Plan = z.infer<typeof PlanSchema>;

// --- PRD 4.2: Walkthrough Schema ---
export const WalkthroughSchema = z.object({
  summary: MediumTextSchema.describe('Summary of what was accomplished'),
  changes: z.array(ShortTextSchema).min(1).max(80).describe('List of changes made'),
  files_modified: z.array(PathLikeSchema).min(1).max(120).describe('Files that were modified'),
  decisions: z.array(ShortTextSchema).max(30).optional().describe('Key decisions made during implementation'),
  testing: z.array(ShortTextSchema).max(30).optional().describe('Testing performed or verification steps'),
  known_issues: z.array(ShortTextSchema).max(30).optional().describe('Known issues remaining'),
  next_steps: z.array(ShortTextSchema).max(30).optional().describe('Recommended next steps'),
  notes: z.string().trim().max(12000).optional().describe('Free-form narrative context (markdown). Do not duplicate structured fields.'),
  suggested_git_commit: SuggestedGitCommitSchema.describe(
    'Required suggested conventional commit message ending with 5-character task id (e.g. "feat(scope): short message (2f83b)")'
  ),
}).strict();
export type Walkthrough = z.infer<typeof WalkthroughSchema>;

// --- PRD 8.3: Execution Metadata Schema ---
export const TokensSchema = z.object({
  input: z.number().optional().describe('Cumulative input tokens used for this entire chat session'),
  output: z.number().optional().describe('Cumulative output tokens used for this entire chat session'),
  total: z.number().optional().describe('Cumulative total tokens used for this entire chat session'),
  estimate: z.number().optional().describe('Estimated cumulative token count'),
  reasoning: z.number().optional().describe('Cumulative reasoning/thinking tokens (Claude thinking, o1 reasoning, etc.)'),
  tool_use: z.number().optional().describe('Cumulative tokens used by tool calls (if reported separately by the model)'),
}).strict();

// --- Session Summary Schema (PRD 4.2) ---
export const SessionSummarySchema = z.object({
  goal: MediumTextSchema.describe('What was the goal of this session'),
  tasks_worked_on: z.array(TaskIdentifierSchema).min(1).max(100).describe('Task IDs worked on'),
  accomplished: z.array(ShortTextSchema).min(1).max(60).describe('What was accomplished'),
  blockers: z.array(ShortTextSchema).max(20).optional().describe('Any blockers encountered'),
  next_recommendations: z.array(ShortTextSchema).max(20).optional().describe('Recommended next actions'),
}).strict();
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

// ─── MTB-01: Create Task Input Schema ───────────────────────────────────────
// MCP create_task input: task fields + metadata envelope
export const CreateTaskInputSchema = z.object({
  title: ShortTextSchema.describe('Task title (required)'),
  description: MediumTextSchema.max(12000).optional().describe('Task description'),
  status: TaskStatusSchema.optional().describe('Initial status (default: todo). MCP/agentic flows cannot set this to "done"'),
  priority: TaskPrioritySchema.optional().describe('Initial priority (default: medium)'),
  assigneeId: z.string().uuid().nullable().optional().describe('Assignee user ID (UUID)'),
  tags: z.array(ShortTextSchema).max(20).optional().default([]).describe('Tag names to associate'),
  blockedByTaskIds: z.array(TaskIdentifierSchema).max(20).optional().default([]).describe('Task IDs that block this task'),
  // Workstream fields for scoped execution
  workstreamId: z.string().trim().min(1).max(64).optional().describe('Workstream ID - groups related tasks'),
  rootTaskId: z.string().uuid().optional().describe('Root task ID for workstream hierarchy'),
  workstreamTag: ShortTextSchema.max(64).optional().describe('Workstream tag for semantic grouping'),
}).strict();

export const CreateTaskMetadataSchema = z.object({
  agent: z.string().trim().min(1).max(80).describe('Agent/client name (e.g. "claude-code", "cursor")'),
  model: z.string().trim().min(1).max(120).describe('Model name (e.g. "claude-sonnet-4-20250514")'),
  operation_id: OperationIdSchema.optional().describe('Optional idempotency key. Auto-generated when omitted'),
  tokens: TokensSchema.optional().describe('Optional cumulative token usage'),
  execution_mode: z.enum(['preview', 'execute']).optional().describe('Confirmation mode'),
  confirmation_token: z.string().trim().min(8).max(200).optional().describe('Token returned by preview mode'),
  chat_id: z.string().trim().min(1).max(120).describe('Chat/thread identifier'),
  projectId: TaskIdentifierSchema.optional().describe('Project ID (optional if active project)'),
}).strict();

// ─── Graph-Native Bulk Schema (PRD Workstream Graph Bulk Creation) ───────────
// Graph-level metadata defined once for the entire task graph
export const TaskGraphContextSchema = z.object({
  workstreamId: z.string().trim().min(1).max(64).optional().describe('Workstream ID for the graph. Auto-generated if not provided.'),
  workstreamTag: ShortTextSchema.max(64).describe('Semantic tag for the workstream.'),
  scopeKey: z.string().trim().min(1).max(120).describe('Machine-readable scope identifier (e.g. "feature/workstream-bulk-creation").'),
  contextSummary: z.string().trim().min(1).max(2000).describe('Short natural-language explanation of what this graph represents.'),
  strictScope: z.boolean().optional().default(true).describe('When true, execution is scoped to this graph only.'),
  rootRef: z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9._:-]+$/).optional().describe('Optional alias pointing to the root task client_ref.'),
}).strict();

// Item-level fields for graph mode - client_ref required, workstream fields disallowed (graph-level only)
export const CreateTaskGraphItemSchema = z.object({
  client_ref: z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9._:-]+$/, 'client_ref contains invalid characters').describe('Client alias for in-batch dependency references. Required in graph mode.'),
  title: ShortTextSchema.describe('Task title'),
  description: MediumTextSchema.max(12000).optional().describe('Task description'),
  status: TaskStatusSchema.optional().describe('Initial status'),
  priority: TaskPrioritySchema.optional().describe('Initial priority'),
  assigneeId: z.string().uuid().nullable().optional().describe('Assignee user ID'),
  isRootTask: z.boolean().optional().default(false).describe('When true, this item is the root task of the graph.'),
  blockedBy: z.array(z.string().trim().min(1).max(80)).max(20).optional().default([]).describe('Dependency refs. Use task IDs for existing tasks and @client_ref for in-batch references.'),
  tags: z.array(ShortTextSchema).max(20).optional().default([]).describe('Tag names'),
}).strict();

// Batch metadata for graph mode - no defaultWorkstream* fields (graph-level now)
export const CreateTaskGraphBulkMetadataSchema = z.object({
  agent: z.string().trim().min(1).max(80).describe('Agent/client name'),
  model: z.string().trim().min(1).max(120).describe('Model name'),
  operation_id_prefix: z.string().trim().min(8).max(128).optional().describe('Batch operation_id prefix for idempotent replay'),
  atomic: z.boolean().optional().default(true).describe('When true, entire graph is persisted in a single transaction.'),
  tokens: TokensSchema.optional().describe('Optional cumulative token usage'),
  execution_mode: z.enum(['preview', 'execute']).optional().describe('Confirmation mode'),
  confirmation_token: z.string().trim().min(8).max(200).optional().describe('Token returned by preview mode'),
  chat_id: z.string().trim().min(1).max(120).describe('Chat/thread identifier'),
  projectId: TaskIdentifierSchema.optional().describe('Project ID (optional if active project)'),
}).strict();

// Top-level graph bulk input
export const CreateTaskGraphBulkInputSchema = z.object({
  graph: TaskGraphContextSchema.describe('Graph-level metadata defined once for the entire task graph.'),
  items: z.array(CreateTaskGraphItemSchema).min(1).max(50).describe('Task items to create (max 50).'),
}).strict();

// Graph mode sanitization allowlist (workstream fields are graph-level only)
const ALLOWED_GRAPH_TASK_FIELDS = new Set([
  'client_ref', 'title', 'description', 'status', 'priority', 'assigneeId',
  'isRootTask', 'blockedBy', 'tags'
]);

/**
 * Sanitize graph task items by stripping unknown fields before Zod validation.
 * Graph mode disallows per-item workstream fields (those are graph-level only).
 */
export function sanitizeGraphTaskItems<T extends { [key: string]: unknown }[]>(items: T): T {
  return items.map((item) => {
    const sanitized: { [key: string]: unknown } = {};
    for (const key of Object.keys(item)) {
      if (ALLOWED_GRAPH_TASK_FIELDS.has(key)) {
        sanitized[key] = item[key];
      }
      // Log stripped fields for debugging (in production, use debug logging)
      // console.debug(`[sanitize] stripped unknown graph field: ${key}`);
    }
    return sanitized as T[number];
  }) as T;
}
