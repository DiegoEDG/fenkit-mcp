# Fenkit Task Protocol

The Fenkit Task Protocol is a set of standard interaction patterns that allow AI agents to manage tasks autonomously on the Fenkit platform. By following these rules, agents can ensure that project state, implementation plans, and completion walkthroughs are always synchronized.

## 🧠 Core Principles

1.  **AI-Native First**: Tasks are designed to be read and written by LLMs.
2.  **Continuous Synchronization**: Agents update progress (plans and walkthroughs) without explicit user intervention.
3.  **Traceable Context**: Every file change or design decision is linked back to a task in the Fenkit platform.

---

## 🛠 Interaction Flow

### 1. Orientation (Startup)
At the start of every session (or after a context reset), the agent must:
- Call `get_status` to verify authentication and identify the active project.
- If no project is active, call `list_projects` and `select_project`.

### 2. Task Discovery & Context
- Use `list_tasks` or `search_tasks` to find assigned work.
- **Mandatory**: Call `get_full_task(taskId)` before starting any implementation. This provides the existing plan, walkthrough, and status.

### 3. Implementation Lifecycle

#### A. Planning
Before writing any code, the agent should formulate a technical approach and call:
```bash
update_task_plan(taskId, plan, model, agent)
```
*Note: The plan must follow the structured schema (summary, steps, filesAffected).*

#### B. Execution
Once the plan is saved, transition the task to `in_progress`:
```bash
update_task_metadata(taskId, { status: "in_progress" }, model, agent)
```

#### C. Completion
After completing the work and verifying it:
1.  Submit a structured walkthrough:
    ```bash
    update_task_walkthrough(taskId, walkthrough, model, agent)
    ```
2.  Mark the task as `done`:
    ```bash
    update_task_metadata(taskId, { status: "done" }, model, agent)
    ```

---

## ⚙️ Automated Integration

This protocol is automatically injected into AI clients during setup:
- **Cursor**: Added as `.cursor/rules/fenkit.mdc`.
- **Windsurf**: Added to `~/.windsurfrules`.
- **Claude Desktop**: Provided via system instructions in the config.
- **MCP Prompt**: Available via the `task-protocol` prompt.
