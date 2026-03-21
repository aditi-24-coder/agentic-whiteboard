import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import * as esbuild from 'esbuild';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

const common = {
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  sourcemap: false,
  minify: true,
  legalComments: 'none',
  define: { __AGENTIC_WHITEBOARD_VERSION__: JSON.stringify(pkg.version) },
  logLevel: 'warning',
};

// ESM build for npm (`npx agentic-whiteboard-mcp`). elkjs is CommonJS, so give the bundle a `require`.
await esbuild.build({
  ...common,
  format: 'esm',
  outfile: 'dist/index.js',
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __pcCreateRequire } from 'node:module';\nconst require = __pcCreateRequire(import.meta.url);",
  },
});

// CommonJS build that the VS Code extension ships as dist/mcp-server.js.
const cjs = await esbuild.build({
  ...common,
  format: 'cjs',
  outfile: 'dist/index.cjs',
  metafile: true,
});
writeFileSync('dist/meta.json', JSON.stringify(cjs.metafile));
execFileSync(
  process.execPath,
  ['../../scripts/notices.mjs', 'ThirdPartyNotices.txt', 'dist/meta.json'],
  { stdio: 'inherit' },
);

console.log(`agentic-whiteboard-mcp ${pkg.version} built`);
