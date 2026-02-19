# Changelog

## 0.1.0 (2026-11-02)

First release.

### Whiteboard

- `*.whiteboard` files open as a board in a custom editor over the file, so Undo/Redo, Save and dirty state work as in any other editor. An empty `.whiteboard` file opens as a blank board. Older `*.plan.json` boards still open.
- Canvas written from scratch in React and SVG: pan and zoom, select, move and resize, marquee, pen, rectangle, ellipse, diamond, text, frames, lines and arrows that stay attached to what they connect, sticky notes, text size, bold and alignment, colors and fills, board backgrounds, and a hand-drawn style in light and dark themes.
- Diagram boxes, file cards, external systems, step cards with live status, and Rule rule notes. **Re-layout** arranges the diagram and routes arrows around boxes.
- **Export ▾** saves the board, or just the selection, as PNG or SVG.
- **New Whiteboard** (Explorer context menu and Command Palette), **Open Latest Whiteboard**, **Open Whiteboard as JSON**, and a status bar item for the active board.

### Your AI draws on the board

- Bundled MCP server (also on npm as `agentic-whiteboard-mcp`) with twelve tools: `read_whiteboard`, `draw_diagram`, `add_shapes`, `update_elements`, `remove_elements`, `clear_whiteboard`, `tidy_layout`, `create_whiteboard`, `list_whiteboards`, `generate_architecture`, `check_drift` and `verify_step`. Changes appear on the board as the AI makes them.
- With no board named, the AI draws on the board you last focused in VS Code. Boards an AI creates open beside your editor.
- **Clean diagrams.** `tidy_layout` arranges the diagram and routes every arrow around the boxes. Agents are told to keep diagrams high-level, never hand-place boxes, and finish with `tidy_layout`.
- **The board locks while your AI works on it.** Editing, Re-layout and code actions wait until the agent finishes (or has been quiet for 20 seconds). A banner and the status bar show it, and **Take over** unlocks the board early.
- **Set Up AI Integration (MCP)** for Claude Code, VS Code / Copilot, OpenAI Codex, Cursor and Cline. Copilot needs no setup: the server is registered with VS Code automatically. The bundled server runs with VS Code's own runtime when Node.js is not installed, and on Windows the `npx` option is written as `cmd /c npx` so agents can start it. Setup can also add a short note to `CLAUDE.md` / `AGENTS.md`.

### Live code sync

- Boxes link to real code (`path`, `symbol`, `package`). **Generate Architecture from Code** reads imports, exports, routes, database models and tests (TypeScript, JavaScript, Python, Go, Prisma) and draws a high-level architecture: about a dozen boxes for packages or top-level folders, real external systems instead of libraries (e.g. pg + Prisma -> PostgreSQL), and one routed arrow per relationship. Running it again re-syncs without losing your names, positions or hand-drawn boxes. On a board that already shows the architecture, it links the drawing to the code instead of redrawing it.
- Understands `tsconfig`/`jsconfig` path aliases and `baseUrl` (with `extends`), monorepo workspaces, and Python relative imports. Skips git-ignored files, `node_modules`, build output, minified bundles and tool configs.
- **Code sync mode per board** (Auto / On / Off), saved in the board. Off makes a plain whiteboard that is never checked against the code.
- **Drift detection** while a code-linked board is open: missing or moved files, changed dependencies, unused external packages, arrows with no import, imports with no arrow, code no box covers, planned boxes not built yet, and changes outside the approved plan. Drift shows on the canvas, on the **Code** button and in the status bar.
- **Baselines:** syncing a board or verifying a step records what its code looks like, so hand-drawn plans get the same checks as generated boards.
- **Code facts in Properties:** open a box's file, folder or symbol, and see its owners, recent commits, tests, routes, models and dependencies.
- **Plans and verified steps:** the AI can plan a change as boxes and steps; boxes not built yet are marked new. **Verify step** runs your test command, attaches the git diff and result to the step, and marks it verified, failed or drifted. Plan status (drafting, awaiting approval, approved, in progress, done, rejected) is set in **Code ▸ Plan status** or by the AI.
- **Ask AI** hands your agent a ready-made request: update the diagram from the code, explain and fix drift, or implement the plan or a selected flow.

### Safety

- You and agents can write the same board at once: atomic writes, a shared lock and a three-way merge mean neither side's changes are lost, and a board edit made just before closing the board is still saved. An invalid file is never overwritten.
- MCP tools only read and write whiteboards inside the workspace.
- In untrusted folders Agentic Whiteboard runs no git or test commands, and `agentic-whiteboard.verifyCommand` is ignored until the folder is trusted. Git never runs a repository's fsmonitor hook, external diff tool or textconv filter.
- Cancelling or timing out a verification stops the whole test process tree and attaches nothing to the step.
- No telemetry and no network calls; the board loads nothing remote.
