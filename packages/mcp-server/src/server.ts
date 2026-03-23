import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import {
  RootsListChangedNotificationSchema,
  type CallToolResult,
  type ServerNotification,
  type ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { PlanParseError } from '@agentic-whiteboard/shared/node';
import * as tools from './tools.js';
import { ToolError, type Workspace } from './workspace.js';

declare const __AGENTIC_WHITEBOARD_VERSION__: string;
const VERSION =
  typeof __AGENTIC_WHITEBOARD_VERSION__ === 'string' ? __AGENTIC_WHITEBOARD_VERSION__ : '0.0.0-dev';

export interface ServerOptions {
  /** Fixed root (tests). Otherwise AGENTIC_WHITEBOARD_ROOT, CLAUDE_PROJECT_DIR, MCP roots, then cwd. */
  root?: string;
  plansFolder?: string;
}

export function createServer(opts: ServerOptions = {}): McpServer {
  const server = new McpServer(
    { name: 'agentic-whiteboard', version: VERSION },
    {
      instructions:
        'Agentic Whiteboard is a whiteboard the user sees live in VS Code (*.whiteboard files). ' +
        'When the user asks you to draw, sketch, diagram, or change anything on the whiteboard, use these tools; every change appears on the board immediately. ' +
        'Call read_whiteboard first when the request refers to existing elements. Prefer draw_diagram for boxes-and-arrows diagrams and add_shapes for everything else. ' +
        'Boxes can be linked to real code (path, symbol, package). generate_architecture draws or re-syncs the architecture from the repository; check_drift lists where the diagram and the code disagree; verify_step runs tests and attaches the diff and result to a step. ' +
        'When asked to update a diagram to match the code, call check_drift first and explain what changed before editing. ' +
        'Each board has a code sync mode (shown by read_whiteboard): on boards with code sync off, draw freely and do not link boxes to files. ' +
        'Keep architecture diagrams high-level: boxes for the major services, apps and layers (folders, not files) plus external systems (databases, caches, third-party APIs; not libraries). ' +
        'Put at most 20 boxes on one board. For a bigger system, merge related parts into one box (e.g. one "Payments" box for several payment folders), or keep one overview board and draw each large area on its own board (create_whiteboard, generate_architecture with folder). ' +
        'Keep diagrams clean: never position diagram boxes by hand (no x/y for boxes), add only the arrows that matter (one per relationship, no duplicates, no arrows into shared helpers), and keep labels to one or two words. ' +
        'The user cannot edit the board while you change it. When you have finished changing a diagram, always call tidy_layout once: it arranges the boxes and routes every arrow around them so no line crosses a box, and unlocks the board.',
    },
  );

  let cachedRoot: string | undefined;
  const ws: Workspace = {
    plansFolder:
      opts.plansFolder ?? process.env.AGENTIC_WHITEBOARD_PLANS_FOLDER ?? '.agentic-whiteboard',
    async root() {
      if (opts.root) return opts.root;
      const fromEnv = process.env.AGENTIC_WHITEBOARD_ROOT || process.env.CLAUDE_PROJECT_DIR;
      if (fromEnv) return fromEnv;
      if (cachedRoot) return cachedRoot;
      if (server.server.getClientCapabilities()?.roots) {
        try {
          const { roots } = await server.server.listRoots(undefined, { timeout: 3000 });
          const first = roots.find((r) => r.uri.startsWith('file://'));
          if (first) return (cachedRoot = fileURLToPath(first.uri));
        } catch {
          // Client advertised roots but did not answer; fall back to cwd.
        }
      }
      return process.cwd();
    },
  };
  server.server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
    cachedRoot = undefined;
  });

  const wrap =
    <A>(fn: (args: A, extra: Extra) => Promise<tools.ToolOutput>) =>
    async (args: A, extra: Extra): Promise<CallToolResult> => {
      try {
        const out = await fn(args, extra);
        return { content: [{ type: 'text', text: out.text }] };
      } catch (err) {
        const message =
          err instanceof ToolError
            ? err.message
            : err instanceof PlanParseError
              ? `${err.message}\nThe whiteboard file is invalid, probably from a manual edit. Ask the user to fix it.`
              : `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
        return { isError: true, content: [{ type: 'text', text: message }] };
      }
    };

  server.registerTool(
    'read_whiteboard',
    {
      title: 'Read whiteboard',
      description:
        'See everything on a whiteboard: boxes, arrows, shapes, sticky notes, with their ids and positions. ' +
        'Call this first whenever the user refers to something already on the board ("make the API box red", "connect login to the database").',
      inputSchema: tools.boardOnlyShape,
      annotations: { readOnlyHint: true },
    },
    wrap((args) => tools.readWhiteboard(ws, args)),
  );

  server.registerTool(
    'draw_diagram',
    {
      title: 'Draw diagram',
      description:
        'Draw boxes connected by arrows (architecture, flowcharts, mind maps, org charts) and let Agentic Whiteboard lay them out automatically. ' +
        'Best choice whenever the user asks for a diagram: you do not need coordinates. Edges may connect to boxes already on the board.',
      inputSchema: tools.drawDiagramShape,
    },
    wrap((args) => tools.drawDiagram(ws, args as Parameters<typeof tools.drawDiagram>[1])),
  );

  server.registerTool(
    'add_shapes',
    {
      title: 'Add shapes',
      description:
        'Draw free-form elements: rectangles, ellipses, diamonds, text, frames, sticky notes, arrows and lines, with colors. ' +
        'Omit x/y to place shapes in free space. Arrows attach to elements by id (from/to) and follow them when moved.',
      inputSchema: tools.addShapesShape,
    },
    wrap((args) => tools.addShapes(ws, args as Parameters<typeof tools.addShapes>[1])),
  );

  server.registerTool(
    'update_elements',
    {
      title: 'Update elements',
      description:
        'Change existing elements by id (text, position, size, color, fill), rename the board, or set its background color (e.g. "white", "black"). Use read_whiteboard to find ids.',
      inputSchema: tools.updateElementsShape,
    },
    wrap((args) => tools.updateElements(ws, args as Parameters<typeof tools.updateElements>[1])),
  );

  server.registerTool(
    'remove_elements',
    {
      title: 'Remove elements',
      description: 'Delete elements by id. Arrows attached to deleted boxes are deleted too.',
      inputSchema: tools.removeElementsShape,
      annotations: { destructiveHint: true },
    },
    wrap((args) => tools.removeElements(ws, args)),
  );

  server.registerTool(
    'tidy_layout',
    {
      title: 'Tidy layout',
      description:
        'Arrange every diagram box cleanly (left to right) and route every arrow around the boxes, so lines do not cross boxes or tangle. ' +
        'Call it once as the last step whenever you added, removed, moved or reconnected boxes; it also tells the user you are done, which unlocks the board for them. ' +
        'It replaces box positions, so skip it only when the user asked to keep their arrangement. Free-form shapes are not moved.',
      inputSchema: tools.boardOnlyShape,
    },
    wrap((args) => tools.tidyLayout(ws, args)),
  );

  server.registerTool(
    'clear_whiteboard',
    {
      title: 'Clear whiteboard',
      description:
        'Remove everything from a whiteboard. Only when the user asks to clear or start over.',
      inputSchema: tools.boardOnlyShape,
      annotations: { destructiveHint: true },
    },
    wrap((args) => tools.clearWhiteboard(ws, args)),
  );

  server.registerTool(
    'create_whiteboard',
    {
      title: 'Create whiteboard',
      description:
        'Create a new .whiteboard file; it opens in VS Code. Only needed for a separate board. The other tools use the open board by default.',
      inputSchema: tools.createWhiteboardShape,
    },
    wrap((args) => tools.createWhiteboard(ws, args)),
  );

  server.registerTool(
    'generate_architecture',
    {
      title: 'Generate architecture from code',
      description:
        'Scan the repository and draw a high-level architecture: about a dozen boxes for its parts (packages or top-level folders), its external systems (databases, caches, queues, payment and other APIs; not libraries), and one arrow per relationship. Every box links to its code. ' +
        'On a board that already shows the architecture, the drawing is kept: its boxes are linked to the code and only missing external systems are added. Re-running refreshes everything and removes generated boxes that no longer match.',
      inputSchema: tools.generateArchitectureShape,
    },
    wrap((args) => tools.generateArchitecture(ws, args)),
  );

  server.registerTool(
    'check_drift',
    {
      title: 'Check drift',
      description:
        'Compare a whiteboard with the code: linked files deleted or renamed, dependencies that changed (e.g. the diagram says Stripe but the code imports Adyen), arrows with no import behind them, imports with no arrow, planned boxes not implemented yet, and changes outside the approved plan.',
      inputSchema: tools.boardOnlyShape,
      annotations: { readOnlyHint: true },
    },
    wrap((args) => tools.checkDrift(ws, args)),
  );

  server.registerTool(
    'verify_step',
    {
      title: 'Verify step',
      description:
        'Verify an implementation step (list card): run the test command, attach the git diff of the step’s files and the result to the step, and mark it verified, failed or drifted. ' +
        'Call it after implementing each step of an approved plan. It runs the command in a shell in the workspace, so only pass commands the user would run.',
      inputSchema: tools.verifyStepShape,
      annotations: { openWorldHint: true },
    },
    wrap((args, extra) => {
      const token = extra._meta?.progressToken;
      return tools.verifyStep(ws, args, {
        signal: extra.signal,
        ...(token !== undefined
          ? {
              // Progress keeps clients that reset their timeout on progress waiting for long
              // test suites.
              heartbeat: (ms) =>
                void extra
                  .sendNotification({
                    method: 'notifications/progress',
                    params: {
                      progressToken: token,
                      progress: Math.round(ms / 1000),
                      message: `Running tests… ${Math.round(ms / 1000)}s`,
                    },
                  })
                  .catch(() => undefined),
            }
          : {}),
      });
    }),
  );

  server.registerTool(
    'list_whiteboards',
    {
      title: 'List whiteboards',
      description: 'List the whiteboard files in this workspace, newest first.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    wrap(() => tools.listWhiteboards(ws)),
  );

  return server;
}

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;
