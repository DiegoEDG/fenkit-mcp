# Fenkit Task Protocol

This protocol defines how AI agents should coordinate work using Fenkit MCP so task state always remains synchronized.

## 🧠 Core Principles

1. **AI-Native First**: Task operations are structured for autonomous agents.
2. **Strict Read/Write Split**: Use read-only tools/resources for discovery and context; use write tools only for state changes.
3. **Continuous Synchronization**: Plans, status, and walkthroughs are updated during execution.
4. **Traceable Delivery**: Metadata history captures model/agent execution context.

---

## 🛠️ Standard Flow

### 1) Orientation
At session start (or after context reset):
- Call `get_status`.
- If no project is active, call `list_projects` then `select_project`.
- If `chat_id` is available, call `resolve_chat_task(chat_id)` before loading task context.
  - `bound`: continue with the returned task context.
  - `unbound`: continue with explicit task selection flow.
  - `needs_confirmation`: ask user which task to bind next (no silent auto-bind).

### 2) Task Discovery
- Use `list_tasks` or `search_tasks` to identify work.
- Retrieve context with `get_task_context_compact(taskId)`.
- If needed, expand with `get_task_context_full(taskId)` or `get_task_section(...)`.

### 3) Planning
Before coding, submit a structured plan:
```text
update_task_plan(taskId, operation_id?, plan, model?, agent?)
```
Use `execution_mode="preview"` first (when confirmation is enabled), then execute with `confirmation_token`.

### 4) Execution
When starting implementation:
```text
set_task_status(taskId, status, operation_id?, model?, agent?)
```
Use `status="in_progress"` when work begins.
For sensitive writes (`select_project`, status changes, plan/walkthrough updates), prefer preview → execute flow.

### 5) Completion
After verification:
1. Submit walkthrough:
```text
update_task_walkthrough(taskId, operation_id?, walkthrough, model?, agent?)
```
2. Task is automatically moved to `in_review` after walkthrough persistence.

---

## ⚙️ Tooling Notes

- `operation_id`, `model`, and `agent` are optional in write operations (auto-derived when omitted).
- Agents should persist lifecycle writes proactively; do not ask the user for every routine tool call.
- Compact retrieval is preferred to reduce tokens.
- Metadata history is appended on each write operation.
- Task read/write operations refresh chat-task heartbeat when `chat_id` is present.
- If `chat_id` is missing, never infer binding from `chat_name`; require explicit selection first.

---

## 🔌 Setup Injection Targets

During `setup` / `setup_client`, protocol guidance is injected into:
- Cursor (`.cursor/rules/fenkit.mdc`)
- Windsurf (`~/.windsurfrules`)
- Claude Desktop (client config + MCP connection)
- Claude Code (`.clauderules`)
- Codex (`~/.codex/fenkit-instructions.md`)
- OpenCode (`~/.config/opencode/opencode.json`)
- Antigravity (`~/.gemini/GEMINI.md`)

## 🔐 Runtime Profiles

- `--mode=read-runtime`: read-only discovery + context tools/resources/prompts.
- `--mode=write-runtime`: mutating task tools.
- `--mode=admin`: authentication/setup tools.
