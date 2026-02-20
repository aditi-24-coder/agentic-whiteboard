# Contributing to Agentic Whiteboard

Contributions are welcome. Bug reports, focused fixes, and targeted features are encouraged.

## Setup

Requirements: Node.js 22+, VS Code 1.101+.

```bash
npm install
npm run build
```

Press **F5** (the "Run Extension" launch config) to open an Extension Development Host on `../agentic-whiteboard-playground`, a test project outside this repo that `npm run playground` creates with Claude Code already connected to your local build. Create a `.whiteboard` file there and ask the AI in that window to draw. The `watch` task rebuilds the extension on change. For webview changes, run `npm run build -w @agentic-whiteboard/webview`, then reload the board with **Developer: Reload Webviews**.

## Layout

| Package               | What                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| `packages/shared`     | Plan schema (zod), atomic IO and locking, merge, change summaries, ELK layout, webview protocol |
| `packages/mcp-server` | `agentic-whiteboard-mcp`, the stdio MCP server (published to npm)                               |
| `packages/webview`    | Board UI: React + SVG canvas behind `CanvasAdapter` (`src/canvas/types.ts`)                     |
| `packages/extension`  | VS Code extension: custom editor, sync, commands, agent setup                                   |

## Checks

```bash
npm run lint             # eslint + prettier --check
npm test                 # vitest
npm run test:extension   # integration tests in a downloaded VS Code
```

Please add tests with your change. Pure logic belongs in `shared` or `webview/src/canvas/ops.ts`, where it is easy to unit test.

## Principles

- The plan file is the only contract between agents and the board. Keep it readable and backwards compatible (bump `version` for breaking changes).
- Never lose content silently: concurrent writes merge element by element, and only an explicit remove or clear deletes anything.
- No telemetry and no remote resources in the webview.
- Tool descriptions are written for agents: say what to call next.

## Releasing

Set `publisher` in `packages/extension/package.json` and the repository URLs first. Then either push a tag like `v0.1.0` (the Release workflow publishes `agentic-whiteboard-mcp` to npm, then the extension to the Marketplace and Open VSX), or publish by hand:

```bash
npm run publish:all   # agentic-whiteboard-mcp to npm, then the Marketplace, then Open VSX
```

`npm run publish:vscode` on its own refuses to run until `agentic-whiteboard-mcp` at the same version is on npm, because the extension's **npx agentic-whiteboard-mcp** setup option depends on it.

## Recording the demo GIF

1. Open a small repo with Agentic Whiteboard installed and Claude Code connected. Use a 1280×800 window and a light theme.
2. Create `architecture.whiteboard` in the Explorer. The blank board opens.
3. In Claude Code, type: _"Draw the architecture of this repo on the whiteboard."_ Boxes and arrows appear.
4. Drag one box somewhere else, then type: _"Make the database red and add a sticky note next to it saying 'needs backups'."_
5. Show the board updating. End the recording.

Record with ScreenToGif (Windows) or Kap (macOS) at 12-15 fps and save it as `docs/demo.gif`. Then add it below the title in `README.md`: `![Agentic Whiteboard demo](docs/demo.gif)`.
