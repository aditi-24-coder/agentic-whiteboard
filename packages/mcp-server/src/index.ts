import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

async function main() {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  // stdout carries the protocol; diagnostics go to stderr.
  console.error('agentic-whiteboard-mcp failed to start:', err);
  process.exit(1);
});
