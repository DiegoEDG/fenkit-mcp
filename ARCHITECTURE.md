# ARCHITECTURE — 03-ickit-mcp

How the MCP server is structured, organized, and connected.

## Purpose

Connects AI agents to the FENKIT platform via the Model Context Protocol. Enables autonomous task management, session tracking, and metadata recording.

## Tools Lifecycle

```
Agent sends: resolve_session_task(chat_id)
  -> Server looks up chat_id → task binding
  -> Returns deterministic context (the bound task)

Agent sends: update_task_plan(task_id, plan)
  -> Server validates structured plan (summary, steps, files_affected)
  -> Persists to backend via API

Agent sends: update_task_walkthrough(task_id, walkthrough)
  -> Server validates structured walkthrough
     (summary, changes, files_modified, git_commit)
  -> Persists + transitions task to in_review

Agent sends: set_task_status(task_id, status)
  -> Server validates state machine transition
  -> Records metadata (model, agent, tokens, git info)
```

## Deterministic Session Resolution

Tasks are bound to chat sessions via `resolve_session_task(chat_id)`. This creates a stable binding: the same chat always resolves to the same task, regardless of when the agent asks. This prevents an agent from working on the wrong task.

## Idempotency

All write operations use an operation ledger stored in the backend. Each request carries an `operation_id`:

- Same `operation_id` + same `payload_hash` → **replayed** (idempotent, returns existing result)
- Same `operation_id` + different `payload_hash` → **conflict** (flagged, not executed)
- New `operation_id` → **created** (normal execution)

This allows safe retries without duplicate task creation.

## Metadata Recording

Every write automatically captures:

- Model name (e.g., `claude-sonnet-4-20250514`)
- Agent name (e.g., `cursor`, `claude-code`)
- Token usage (input, output, total)
- Git context (branch, commit)
- Duration
