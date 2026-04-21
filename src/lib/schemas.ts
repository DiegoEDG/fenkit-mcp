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

// ─── MTB-02: Create Tasks Bulk Input Schema ─────────────────────────────────────────
// MCP create_tasks_bulk input: items array + batch metadata
export const CreateTaskBulkItemSchema = z.object({
  title: ShortTextSchema.describe('Task title'),
  description: MediumTextSchema.max(12000).optional().describe('Task description'),
  status: TaskStatusSchema.optional().describe('Initial status'),
  priority: TaskPrioritySchema.optional().describe('Initial priority'),
  assigneeId: z.string().uuid().nullable().optional().describe('Assignee user ID'),
  client_ref: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9._:-]+$/, 'client_ref contains invalid characters')
    .optional()
    .describe('Client alias to support in-batch dependency references (e.g. "task-root")'),
  blockedBy: z
    .array(z.string().trim().min(1).max(80))
    .max(20)
    .optional()
    .default([])
    .describe('Dependency refs. Use task IDs for existing tasks and @client_ref for in-batch references'),
  tags: z.array(ShortTextSchema).max(20).optional().default([]).describe('Tag names'),
  blockedByTaskIds: z.array(TaskIdentifierSchema).max(20).optional().default([]).describe('Blocker task IDs'),
}).strict();

export const CreateTasksBulkMetadataSchema = z.object({
  agent: z.string().trim().min(1).max(80).describe('Agent/client name'),
  model: z.string().trim().min(1).max(120).describe('Model name'),
  operation_id_prefix: z.string().trim().min(8).max(128).optional().describe('Batch operation_id prefix for idempotent replay'),
  atomic: z.boolean().optional().describe('When true, enforce bulk-level atomic intent (server support may vary by endpoint)'),
  tokens: TokensSchema.optional().describe('Optional cumulative token usage'),
  execution_mode: z.enum(['preview', 'execute']).optional().describe('Confirmation mode'),
  confirmation_token: z.string().trim().min(8).max(200).optional().describe('Token returned by preview mode'),
  chat_id: z.string().trim().min(1).max(120).describe('Chat/thread identifier'),
  projectId: TaskIdentifierSchema.optional().describe('Project ID (optional if active project)'),
}).strict();

export const CreateTasksBulkInputSchema = z.object({
  items: z.array(CreateTaskBulkItemSchema).min(1).max(50).describe('Task items to create (max 50)'),
}).strict();
