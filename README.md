# Fenkit MCP Server

The **Fenkit MCP Server** is a Model Context Protocol (MCP) implementation designed to bridge LLM agents (like Claude, Cursor, and Windsurf) with the Fenkit task management system. It provides a structured, LLM-native interface for task coordination, discovery, and lifecycle management.

## 🚀 Overview

This server enables AI agents to interact with your projects and tasks in a deterministic way, ensuring that implementation plans and walkthroughs follow structured schemas for better visibility and record-keeping in the Fenkit Web UI.

### Key Capabilities:
- **Project Discovery**: List and select active projects.
- **Task Search**: Find tasks by title, description, or status.
- **Context Retrieval**: Fetch full task context (description, history, plans) in a single optimized markdown blob.
- **Structured Writes**: Submit versioned implementation plans and completion walkthroughs.
- **Metadata Tracking**: Automatically captures execution signals (duration, model, token usage).

## 🛠️ Prerequisites

- **Node.js**: v18 or later
- **PNPM**: Installed on your system
- **Fenkit API Key**: Obtainable from the Fenkit Web UI (Settings → API Keys)

## 🏗️ Installation & Setup

### 1. Build the Server
Clone the repository and build the project:

```bash
cd 04-ickit-mcp
pnpm install
pnpm run build
```

### 2. Configure for AI Agents

The fastest way is to use the `setup_client` MCP tool after connecting the server once:

```
setup_client(client: "claude")
setup_client(client: "cursor", path: "/path/to/your/project")
setup_client(client: "windsurf")
setup_client(client: "codex")
setup_client(client: "antigravity")
```

To review config snippets without touching any files, use `get_setup_instructions(client: "claude")`.

#### Manual Configuration

| Client | Config Path | Format |
|--------|------------|--------|
| **Claude Desktop** | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) | JSON `mcpServers` |
| **Cursor** | `.cursor/mcp.json` in project + `.cursor/rules/fenkit.mdc` | JSON + MDC |
| **Windsurf** | `~/.windsurf/mcp.json` | JSON `mcpServers` |
| **Codex** | `~/.codex/config.toml` | TOML `[mcp_servers.fenkit]` |
| **Antigravity** | `~/.gemini/antigravity/mcp_config.json` | JSON `mcpServers` |

All use `node /absolute/path/to/04-ickit-mcp/dist/index.js` as the command.

## 🔑 Authentication

Once the server is connected, use the `login` tool to save your API key:

```bash
# Obtain a token from Fenkit Web UI first
login(token: "your-api-key")
```

Verify your connection with:
```bash
get_status()
```

## 🧰 Available Tools

| Tool | Description |
|------|-------------|
| `login` | Set your Fenkit API token and API URL. |
| `get_status` | Check authentication and active project status. |
| `list_projects` | List all available Fenkit projects. |
| `select_project` | Set the active project for subsequent task operations. |
| `list_tasks` | List tasks in the active project (supports status filters). |
| `search_tasks` | Search tasks by name or description. |
| `get_full_task` | Retrieve the complete context of a task in one call. |
| `update_task_plan` | Propose or update an implementation plan for a task. |
| `update_task_walkthrough` | Submit a walkthrough of completed work. |
| `update_task_metadata` | Update task status, priority, or custom metadata. |
| `setup_client` | Automatically configure an AI client to use Fenkit MCP (writes config files). |
| `get_setup_instructions` | Get manual config snippets for any client without touching files. |

## 🧪 Testing Locally

The easiest way to test the MCP server during development is using the **MCP Inspector**.

### 1. Build the project
```bash
pnpm run build
```

### 2. Run the Inspector
Execute the following command to start the inspector and connect it to your local server:

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

This will provide a web interface (usually at `http://localhost:5173`) where you can:
- List available tools.
- Execute tools with custom JSON arguments.
- Inspect JSON-RPC traffic.

## 📐 Design Principles

1. **Task-Centric**: Tasks are the primary unit of coordination.
2. **Minimal Overhead**: Optimized tools to reduce LLM token usage (e.g., `get_full_task`).
3. **Safe Writes**: All writes are versioned; no destructive overwrites are performed.
4. **Privacy First**: Automatically redacts content wrapped in `<private>` tags.

## 💻 Development

- `pnpm run dev`: Build the server in watch mode.
- `pnpm run build`: Production ESM build using `tsup`.
- `pnpm run lint`: Run ESLint to check for stylistic and type issues.

---

*Part of the Fenkit AI-Native Creator App Platform.*
