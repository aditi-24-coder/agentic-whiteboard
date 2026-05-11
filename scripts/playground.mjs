// Prepares the folder that F5 opens in the Extension Development Host: a plain project outside
// this repo, with Claude Code wired to the locally built MCP server. Create *.whiteboard files in
// it and ask the AI in that window to draw. Existing files there are never overwritten.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.resolve(repo, '..', 'agentic-whiteboard-playground');
const server = path.join(repo, 'packages', 'extension', 'dist', 'mcp-server.js');

mkdirSync(dir, { recursive: true });

const write = (name, content) => {
  const file = path.join(dir, name);
  if (existsSync(file)) return;
  writeFileSync(file, content, 'utf8');
  console.log(`Wrote ${file}`);
};

// Claude Code reads project MCP servers from .mcp.json (and passes the folder as CLAUDE_PROJECT_DIR).
// Copilot needs nothing: the extension registers the server with VS Code itself.
write(
  '.mcp.json',
  JSON.stringify(
    {
      mcpServers: {
        'agentic-whiteboard': { command: 'node', args: [server.split(path.sep).join('/')] },
      },
    },
    null,
    2,
  ) + '\n',
);

console.log(`Playground: ${dir}`);
