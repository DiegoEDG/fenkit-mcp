import { z } from 'zod';

const ShortTextSchema = z.string().trim().min(1).max(240);
const MediumTextSchema = z.string().trim().min(1).max(2000);
const PathLikeSchema = z.string().trim().min(1).max(260);

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
}).strict();
export type Walkthrough = z.infer<typeof WalkthroughSchema>;

// --- PRD 8.3: Execution Metadata Schema ---
export const TokensSchema = z.object({
  input: z.number().optional().describe('Input tokens used'),
  output: z.number().optional().describe('Output tokens used'),
  total: z.number().optional().describe('Total tokens used'),
  estimate: z.number().optional().describe('Estimated token count'),
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
