# 🚀 Fenkit MCP - La Infraestructura del "Done"

### **Cero fricción. Máximo control. Sincronización absoluta entre tu Agente AI y tu flujo de trabajo.**

[![MCP](https://img.shields.io/badge/Model_Context_Protocol-SDK-orange?style=for-the-badge)](https://modelcontextprotocol.io)
[![Node.js](https://img.shields.io/badge/Node.js-v18+-green?style=for-the-badge)](https://nodejs.org)
[![Version](https://img.shields.io/badge/version-1.2.0-blue?style=for-the-badge)](https://www.npmjs.com/package/fenkit-mcp)
[![License](https://img.shields.io/badge/license-MIT-purple?style=for-the-badge)](LICENSE)

Fenkit MCP conecta tus agentes AI con **Fenkit**, tu centro de comando. Transforma SDD en progreso real y documentación estructurada sin mover un solo dedo.

---

## 🌪️ El Loop del Éxito: Auto-Invoke

Olvida el copiar y pegar. Fenkit MCP implementa un ciclo de vida autónomo donde el agente no solo "hace", sino que **reporta y documenta**.

```mermaid
sequenceDiagram
    participant U as Usuario
    participant A as Agente AI
    participant M as Fenkit MCP
    participant B as Fenkit Backend

    U->>A: "Trabaja en la tarea #42"
    A->>M: list_tasks()
    M->>A: Contexto completo de la tarea
    Note over A: El agente piensa y ejecuta (Con tu aprobación)
    A->>M: update_task_walkthrough()
    A->>M: set_task_status("In Review")
    M->>B: Sync en tiempo real
    B->>U: Notificación: Tarea Finalizada ✅
```

---

## ⚡ Activación en 30 Segundos

Despliega el poder de Fenkit en tu cliente favorito con un solo comando:

```bash
npx -y fenkit-mcp setup <client>
```

| Cliente | Comando de Setup |
| :--- | :--- |
| **OpenCode** | `npx -y fenkit-mcp setup opencode` |
| **Claude Code** | `npx -y fenkit-mcp setup claudecode` |
| **Claude Desktop** | `npx -y fenkit-mcp setup claude` |
| **GPT Codex** | `npx -y fenkit-mcp setup codex` |
| **Cursor** | `npx -y fenkit-mcp setup cursor` |
| **Windsurf** | `npx -y fenkit-mcp setup windsurf` |
| **Antigravity** | `npx -y fenkit-mcp setup antigravity` |

---

## ⚖️ ¿Por qué Fenkit MCP?

| Característica | Prompting Manual | Con Fenkit MCP |
| :--- | :--- | :--- |
| **Contexto** | Fragmentado | Siempre sincrónico |
| **Documentación** | "Luego lo escribo" (Nunca pasa) | Automática: Plan + Walkthrough |
| **Visibilidad** | Caja negra | Métricas y progreso en vivo |
| **Esfuerzo** | Alto (Copy-Paste infinito) | **Cero** (Auto-invoke) |

---

## 📦 El Valor del "Dev-in-the-loop"

Fenkit permite que el desarrollador se enfoque en lo que realmente aporta valor: el **Spec Driven Development (SDD), Testing, Seguridad, etc**. Deja que el agente construya mientras Fenkit gestiona la burocracia técnica.

Al eliminar el caos administrativo, Fenkit genera de forma autónoma:

- **📈 Métricas de ejecución:** Seguimiento en tiempo real de versiones y tiempos de ejecución.
- **🛡️ Evidencia:** Documentación centralizada y lista para auditorías o revisiones de equipo.
- **🔁 Sincronización Total:** Tu código y tu panel de control siempre en la misma página, sin copy-paste.

---

## 🧰 Herramientas

Nuestras herramientas están diseñadas para que el agente tenga autonomía total:

- 🔐 **Auth:** `login`, `get_status` - Seguridad robusta en cada interacción.
- 📂 **Proyectos:** `list_projects`, `select_project` - Navegación inteligente.
- 📝 **Tareas:** `list_tasks`, `get_task_context_compact` - Foco en lo que importa.
- 🚀 **Escritura:** `update_task_plan`, `update_task_walkthrough`, `set_task_status`, `set_task_priority` - Documentación y lifecycle determinista.

---

## 🔥 Empieza Ahora

No dejes que tu agente trabaje en el vacío. Haz que cada línea de código cuente.

```bash
npx -y fenkit-mcp setup cursor
```

**Haz que tu agente construya. Deja que Fenkit lo demuestre.**
