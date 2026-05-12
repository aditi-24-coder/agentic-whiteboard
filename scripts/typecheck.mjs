// Typechecks each workspace package with its own tsconfig (they differ in lib, jsx and types).
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
const packages = ['shared', 'mcp-server', 'webview', 'extension'];
let failed = false;
for (const pkg of packages) {
  const res = spawnSync(
    process.execPath,
    [tsc, '-p', `packages/${pkg}/tsconfig.json`, '--noEmit'],
    {
      stdio: 'inherit',
    },
  );
  if (res.status !== 0) {
    console.error(`typecheck failed: packages/${pkg}`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
