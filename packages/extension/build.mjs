import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const tests = process.argv.includes('--tests');

mkdirSync('dist', { recursive: true });

// The MCP server is built by packages/mcp-server; ship its CommonJS bundle.
const server = '../mcp-server/dist/index.cjs';
if (!existsSync(server)) {
  console.error('Build the MCP server first: npm run build -w agentic-whiteboard-mcp');
  process.exit(1);
}
copyFileSync(server, 'dist/mcp-server.js');

// Marketplace page and license come from the repo root.
for (const f of ['README.md', 'LICENSE', 'CHANGELOG.md'])
  if (existsSync(`../../${f}`)) copyFileSync(`../../${f}`, f);

const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  // jsonc-parser's UMD entry loads its modules with a dynamic require that cannot be bundled.
  mainFields: ['module', 'main'],
  sourcemap: !process.env.CI && watch,
  minify: !watch,
  legalComments: 'none',
  logLevel: 'info',
  metafile: !watch,
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  const result = await esbuild.build(options);
  writeFileSync('dist/meta.json', JSON.stringify(result.metafile));
  const metas = [
    'dist/meta.json',
    '../mcp-server/dist/meta.json',
    '../webview/dist/meta.json',
  ].filter((m) => existsSync(m));
  execFileSync(process.execPath, ['../../scripts/notices.mjs', 'ThirdPartyNotices.txt', ...metas], {
    stdio: 'inherit',
  });
}

if (tests) {
  await esbuild.build({
    entryPoints: ['test/runTests.ts', 'test/suite/index.ts', 'test/suite/board.test.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outdir: 'out/test',
    outbase: 'test',
    external: ['vscode', 'mocha', '@vscode/test-electron'],
    logLevel: 'warning',
  });
}
