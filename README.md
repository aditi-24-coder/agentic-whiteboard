# Agentic Whiteboard

Agentic Whiteboard is a VS Code extension for repository-based planning and
AI-assisted diagrams. Boards are stored as readable `.whiteboard` files that
can be reviewed, committed, and shared with a team.

## Features

- AI-controlled diagrams through the Model Context Protocol (MCP)
- Nodes, steps, notes, frames, shapes, arrows, and freehand drawing
- Blocked groups that move together
- Code-linked architecture diagrams
- Drift detection for files, dependencies, and planned changes
- Step verification with test output and Git evidence
- PNG and SVG export
- Undo, redo, save, and VS Code custom editor support

## Quick start

1. Install Agentic Whiteboard.
2. Create or open a `.whiteboard` file in VS Code.
3. Open the Command Palette and run **Agentic Whiteboard: Set Up AI Integration (MCP)**.
4. Ask your AI assistant to draw or update the board.

GitHub Copilot is registered automatically by the extension. Other MCP clients
can use the setup command or run:

```bash
AGENTIC_WHITEBOARD_ROOT=/path/to/repository npx -y agentic-whiteboard-mcp
```

## Board actions

| Action                | Description                                                                |
| --------------------- | -------------------------------------------------------------------------- |
| Select and move       | Click an element, use Shift-click for multiple elements, or drag a marquee |
| Block a group         | Open Properties after selecting elements, then choose Block or Unblock     |
| Connect elements      | Use the Arrow tool                                                         |
| Add notes             | Use **Add note** or the Sticky tool                                        |
| Generate architecture | Run **Agentic Whiteboard: Generate Architecture from Code**                |
| Check drift           | Open the Code panel or use the `check_drift` MCP tool                      |
| Verify a step         | Use **Verify step** to run tests and attach evidence                       |

## Code sync

Code sync is configured per board:

- **Auto** checks boards when elements link to files or packages.
- **On** always checks the board against the repository.
- **Off** keeps the board as a plain whiteboard.

Architecture generation reads supported TypeScript, JavaScript, Python, Go, and
Prisma files. It creates high-level boxes, identifies external systems, and
routes relationships around the diagram.

## MCP tools

The bundled MCP server provides tools for:

- Reading and editing whiteboards
- Creating and listing boards
- Generating architecture diagrams
- Updating and removing elements
- Arranging diagrams
- Checking drift
- Verifying implementation steps

## Safety and privacy

- Boards remain in the workspace.
- Writes use atomic updates, locking, and merge protection.
- Invalid board files are not overwritten.
- Verification commands are disabled in untrusted folders.
- The extension does not collect telemetry or make network requests.

## Development

```bash
npm install
npm run lint
npm run typecheck
npm test
npm run test:extension
```

Build and package the extension with:

```bash
npm run build -w agentic-whiteboard
npm run package -w agentic-whiteboard
```

## License

See [LICENSE](./LICENSE).
