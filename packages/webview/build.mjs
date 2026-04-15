import { mkdirSync, writeFileSync } from 'node:fs';
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const options = {
  entryPoints: { webview: 'src/main.tsx' },
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome120'],
  outdir: '../extension/media',
  jsx: 'automatic',
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production') },
  logLevel: 'info',
  metafile: true,
};

if (watch) await (await esbuild.context(options)).watch();
else {
  const result = await esbuild.build(options);
  mkdirSync('dist', { recursive: true });
  writeFileSync('dist/meta.json', JSON.stringify(result.metafile));
}
