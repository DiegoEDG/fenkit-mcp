import { z } from 'zod';

export const ArtifactModeSchema = z
  .enum(['mini', 'full'])
  .describe('Artifact detail level. Use "full" when the agent already produced a complete artifact (e.g. plan mode).');
export type ArtifactMode = z.infer<typeof ArtifactModeSchema>;

// --- PRD 4.2: Plan Schema ---
export const PlanSchema = z.object({
  summary: z.string().describe('Brief summary of the implementation plan'),
  steps: z.array(z.string()).describe('Ordered list of implementation steps'),
  files_affected: z.array(z.string()).describe('Files that will be created or modified'),
  risks: z.array(z.string()).optional().describe('Potential risks or blockers'),
  assumptions: z.array(z.string()).optional().describe('Assumptions made during planning'),
  open_questions: z.array(z.string()).optional().describe('Unresolved questions'),
  estimated_complexity: z.enum(['low', 'medium', 'high']).optional().describe('Estimated task complexity'),
  notes: z.string().optional().describe('Free-form narrative context (markdown). Do not duplicate structured fields.'),
});
export type Plan = z.infer<typeof PlanSchema>;

// --- PRD 4.2: Walkthrough Schema ---
export const WalkthroughSchema = z.object({
  summary: z.string().describe('Summary of what was accomplished'),
  changes: z.array(z.string()).describe('List of changes made'),
  files_modified: z.array(z.string()).describe('Files that were modified'),
  decisions: z.array(z.string()).optional().describe('Key decisions made during implementation'),
  testing: z.array(z.string()).optional().describe('Testing performed or verification steps'),
  known_issues: z.array(z.string()).optional().describe('Known issues remaining'),
  next_steps: z.array(z.string()).optional().describe('Recommended next steps'),
  notes: z.string().optional().describe('Free-form narrative context (markdown). Do not duplicate structured fields.'),
});
export type Walkthrough = z.infer<typeof WalkthroughSchema>;

// --- PRD 8.3: Execution Metadata Schema ---
export const TokensSchema = z.object({
  input: z.number().optional().describe('Input tokens used'),
  output: z.number().optional().describe('Output tokens used'),
  total: z.number().optional().describe('Total tokens used'),
  estimate: z.number().optional().describe('Estimated token count'),
});
export const TokenSourceSchema = z
  .enum(['exact', 'estimate', 'mixed'])
  .optional()
  .describe('How token values were produced: exact from client, estimate fallback, or mixed.');

export const ExecutionMetadataSchema = z.object({
  durationMs: z.number().optional().describe('Time spent in milliseconds'),
  agent: z.string().optional().describe('Agent/client name (e.g. cursor, claude-desktop)'),
  model: z.string().optional().describe('Model identifier (e.g. gpt-4.1, claude-sonnet)'),
  provider: z.string().optional().describe('Provider name (e.g. openai, anthropic)'),
  tokens: TokensSchema.optional().describe('Token usage'),
  token_source: TokenSourceSchema,
  chat_id: z.string().optional().describe('Chat/thread identifier from the AI client'),
  chat_name: z.string().optional().describe('Chat/thread display name from the AI client'),
  session_id: z.string().optional().describe('MCP transport session identifier'),
  timestamp: z.string().optional().describe('ISO-8601 timestamp'),
});
export type ExecutionMetadata = z.infer<typeof ExecutionMetadataSchema>;

// --- Session Summary Schema (PRD 4.2) ---
export const SessionSummarySchema = z.object({
  goal: z.string().describe('What was the goal of this session'),
  tasks_worked_on: z.array(z.string()).describe('Task IDs worked on'),
  accomplished: z.array(z.string()).describe('What was accomplished'),
  blockers: z.array(z.string()).optional().describe('Any blockers encountered'),
  next_recommendations: z.array(z.string()).optional().describe('Recommended next actions'),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;
