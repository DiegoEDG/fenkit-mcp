# Fenkit Task Protocol

This protocol defines how AI agents should coordinate work using Fenkit MCP so task state always remains synchronized.

## 🧠 Core Principles

1. **AI-Native First**: Task operations are structured for autonomous agents.
2. **Continuous Synchronization**: Plans, status, and walkthroughs are updated during execution.
3. **Traceable Delivery**: Metadata history captures model/agent execution context.

---

## 🛠️ Standard Flow

### 1) Orientation
At session start (or after context reset):
- Call `get_status`.
- If no project is active, call `list_projects` then `select_project`.

### 2) Task Discovery
- Use `list_tasks` or `search_tasks` to identify work.
- Retrieve context with `get_task_context_compact(taskId)`.
- If needed, expand with `get_task_context_full(taskId)` or `get_task_section(...)`.
- `get_full_task` remains supported as a deprecated alias.

### 3) Planning
Before coding, submit a structured plan:
```text
update_task_plan(taskId, plan, model, agent)
```

### 4) Execution
When starting implementation:
```text
update_task_metadata(taskId, status, priority?, model, agent)
```
Use `status="in_progress"` when work begins.

### 5) Completion
After verification:
1. Submit walkthrough:
```text
update_task_walkthrough(taskId, walkthrough, model, agent)
```
2. Mark task complete:
```text
update_task_metadata(taskId, status="done", model, agent)
```

---

## ⚙️ Tooling Notes

- `model` and `agent` fields are required in write operations for execution tracking.
- Compact retrieval is preferred to reduce tokens.
- Metadata history is appended on each write operation.

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
