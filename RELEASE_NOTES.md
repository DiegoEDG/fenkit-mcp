# Release Notes — v1.0.0 (MVP)

## Highlights
- First MVP release of **fenkit-mcp**.
- Stable end-to-end task lifecycle for AI agents: discovery, planning, execution updates, and delivery walkthroughs.
- Multi-client setup support via CLI and MCP tools.

## What’s Included

### Core MCP capabilities
- Auth/session tools: `login`, `get_status`
- Project tools: `list_projects`, `get_active_project`, `select_project`
- Task read tools: `list_tasks`, `search_tasks`, `get_task_context_compact`, `get_task_context_full`, `get_task_section`
- Task write tools with MCP metadata payloads (`mcpContext` + `mcpEvent`): `update_task_plan`, `update_task_walkthrough`, `set_task_status`, `set_task_priority`

### Setup & onboarding
- One-command setup for: Claude Desktop, Cursor, Windsurf, Claude Code, Codex, and Antigravity.
- Automatic protocol/rules injection for supported clients.

### Reliability & safety
- Structured plan/walkthrough validation via schemas.
- Metadata history tracking on task write operations.
- Privacy-aware sanitization and safe-path guards for setup operations.

## Documentation updates in this release
- README aligned with the current tool surface and recommended lifecycle.
- PROTOCOL updated to reflect compact-first retrieval and current write signatures.

## Versioning
- Package version bumped to **1.0.0** to mark MVP baseline.
