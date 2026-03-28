# Agentic Whiteboard MCP Server

This package provides the MCP server for [Agentic Whiteboard](https://github.com/YOUR_GITHUB_USER/agentic-whiteboard).
It allows MCP-compatible AI clients to create and edit diagrams, shapes, arrows, and notes in a
whiteboard displayed in VS Code.

```bash
AGENTIC_WHITEBOARD_ROOT=/path/to/repo npx -y agentic-whiteboard-mcp
```

Boards are readable JSON files, `*.whiteboard`, anywhere in the project. Open them with the Agentic Whiteboard VS Code extension to see and edit them as a whiteboard. When a tool call names no board, the server uses the board the user has focused in VS Code, then the most recently changed one.

## Configure your agent

This package requires [Node.js](https://nodejs.org) 20 or later. On Windows, use
`"command": "cmd", "args": ["/c", "npx", "-y", "agentic-whiteboard-mcp"]` in the JSON
configurations below. For Codex, use `command = "cmd"` and
`args = ["/c", "npx", "-y", "agentic-whiteboard-mcp"]`. The Agentic Whiteboard extension can
generate these configurations automatically.

**Claude Code** (`.mcp.json` in your project):

```json
{
  "mcpServers": {
    "agentic-whiteboard": { "command": "npx", "args": ["-y", "agentic-whiteboard-mcp"] }
  }
}
```

**VS Code / Copilot** (`.vscode/mcp.json`):

```json
{
  "servers": {
    "agentic-whiteboard": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "agentic-whiteboard-mcp"],
      "env": { "AGENTIC_WHITEBOARD_ROOT": "${workspaceFolder}" }
    }
  }
}
```

**Cursor** (`.cursor/mcp.json`): use the Claude Code shape and add `"env": { "AGENTIC_WHITEBOARD_ROOT": "${workspaceFolder}" }`.

**OpenAI Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers."agentic-whiteboard"]
command = "npx"
args = ["-y", "agentic-whiteboard-mcp"]
env = { AGENTIC_WHITEBOARD_ROOT = "/path/to/repo" }
```

**Cline**: add the same entry under `mcpServers` in Cline's MCP settings, with an absolute `AGENTIC_WHITEBOARD_ROOT`.

## Tools

| Tool                    | Purpose                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `read_whiteboard`       | Every element with its id, text, position and color.                                                                      |
| `draw_diagram`          | Boxes and arrows, laid out automatically.                                                                                 |
| `add_shapes`            | Rectangles, ellipses, diamonds, text, frames, sticky notes, arrows, lines.                                                |
| `update_elements`       | Change text, position, size, color or fill by id.                                                                         |
| `remove_elements`       | Delete elements by id (and the arrows attached to them).                                                                  |
| `clear_whiteboard`      | Empty a board.                                                                                                            |
| `tidy_layout`           | Arrange the diagram and route every arrow around the boxes; call it when done (it unlocks the board in VS Code).          |
| `create_whiteboard`     | Create a new `.whiteboard` file.                                                                                          |
| `list_whiteboards`      | The boards in the workspace, newest first.                                                                                |
| `generate_architecture` | Scan the repo (imports, routes, models, tests) and draw or re-sync its architecture, each box linked to its code.         |
| `check_drift`           | Where the diagram and the code disagree: missing files, changed dependencies, arrows with no import, unimplemented boxes. |
| `verify_step`           | Run the tests, attach the git diff and result to a step, and mark it verified, failed or drifted.                         |

## Environment

- `AGENTIC_WHITEBOARD_ROOT`: the repo root. If unset, the server uses `CLAUDE_PROJECT_DIR`, then the client's MCP roots, then the working directory.
- `AGENTIC_WHITEBOARD_PLANS_FOLDER`: folder of older `.plan.json` boards outside the root (optional).
- `AGENTIC_WHITEBOARD_VERIFY_COMMAND`: default command for `verify_step`, e.g. `npm test` (optional; otherwise detected from the project).

MIT licensed. No telemetry. No network access.
