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

### 1. Quick Start (NPM - Recommended)
The fastest way to get started is via `npx`. This command will automatically configure your AI client:

```bash
npx -y fenkit-mcp setup <client>
```
*Supported clients: `claude`, `cursor`, `windsurf`, `codex`, `antigravity`, `claudecode`.*

### 2. Manual Installation
If you prefer a global installation for faster startup:

```bash
# Install globally
npm install -g fenkit-mcp

# Setup your client using the shorter 'fnk' alias
fnk setup <client>
```

### 3. Build from Source
If you are developing or prefer to build locally:

```bash
cd 04-ickit-mcp
pnpm install
pnpm run build
```

Then use the `setup_client` MCP tool or the CLI:
```bash
node dist/index.js setup <client>
```

For more details on sharing with your team or publishing, see the [MCP Distribution Guide](docs/mcp_distribution_guide.md).

---

## 🔑 Authentication

Once the server is connected, use the `login` tool to authenticate:
 
```bash
login()
```

Verify your connection with:
```bash
get_status()
```

## 🧠 Auto-Invoke Protocol

Fenkit MCP is designed for **autonomous task coordination**. It includes a built-in protocol that teaches AI agents how to manage tasks without user intervention.

Key lifecycle rules for agents:
1.  **Context**: Always call `get_status` and `get_full_task` before starting work.
2.  **Planning**: Automatically submit implementation plans via `update_task_plan`.
3.  **Execution**: Update task status to `in_progress` via `update_task_metadata`.
4.  **Completion**: Submit walkthroughs via `update_task_walkthrough` and mark as `done`.

See the full [Fenkit Task Protocol](PROTOCOL.md) for details.

## 🧰 Available Tools

| Tool | Description |
|------|-------------|
| `login` | Authenticate via browser and save your API token automatically. |
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
