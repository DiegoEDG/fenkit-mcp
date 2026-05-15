# APP-STACK — 03-ickit-mcp

MCP server package (`fenkit-mcp`) that connects AI agents to the FENKIT platform.

## Purpose

Provides Model Context Protocol tools for AI agents to autonomously manage tasks, projects, sessions, and metadata. Enables the SDD (Spec-Driven Development) loop: agents self-document plans, walkthroughs, and execution metrics back to the platform.

## Stack

| Layer | Technology |
|-------|------------|
| Language | TypeScript |
| Protocol | MCP SDK |
| HTTP | Axios |
| Validation | Zod |
| Package Manager | pnpm |

## Tools Exposed

| Tool | Purpose |
|------|---------|
| `login`, `get_status`, `setup_client` | Auth and configuration |
| `list_projects`, `select_project` | Project navigation |
| `list_tasks`, `get_task_context_compact`, `get_task_context_full` | Task reading |
| `update_task_plan`, `update_task_walkthrough`, `set_task_status` | Task writing |
| `fenkit_write_create_task`, `fenkit_write_create_tasks_bulk` | Task creation |

## Quality Commands

```bash
pnpm run lint
pnpm run build
pnpm run test
```
