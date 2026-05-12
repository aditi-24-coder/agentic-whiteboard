// Wraps vsce/ovsx for packages/extension.
//   node ../../scripts/vsce.mjs package          -> agentic-whiteboard-<version>.vsix
//   node ../../scripts/vsce.mjs publish:vscode   -> VS Code Marketplace (needs VSCE_PAT)
//   node ../../scripts/vsce.mjs publish:openvsx  -> Open VSX (needs OVSX_PAT)
// Publishing checks that agentic-whiteboard-mcp at the same version is on npm (--skip-npm-check skips it).
// While package.json still has the YOUR_PUBLISHER_ID placeholder, packaging uses a temporary
// local publisher id (so the .vsix can be tested) and publishing refuses to run.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const PLACEHOLDER = 'YOUR_PUBLISHER_ID';
const cmd = process.argv[2];
const manifestText = readFileSync('package.json', 'utf8');
const manifest = JSON.parse(manifestText);
const vsix = `agentic-whiteboard-${manifest.version}.vsix`;
const run = (bin, args) =>
  execFileSync(process.platform === 'win32' ? `${bin}.cmd` : bin, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

if (cmd === 'package') {
  const placeholder = manifest.publisher === PLACEHOLDER;
  if (placeholder) {
    console.warn(
      `publisher is still "${PLACEHOLDER}"; packaging with the local id "agentic-whiteboard-dev" for testing.`,
    );
    writeFileSync(
      'package.json',
      JSON.stringify({ ...manifest, publisher: 'agentic-whiteboard-dev' }, null, 2) + '\n',
    );
  }
  try {
    run('npx', ['vsce', 'package', '--no-dependencies', '--out', vsix]);
  } finally {
    if (placeholder) writeFileSync('package.json', manifestText);
  }
} else if (cmd === 'publish:vscode' || cmd === 'publish:openvsx') {
  if (manifest.publisher === PLACEHOLDER) {
    console.error(
      `Set "publisher" in packages/extension/package.json to your Marketplace publisher id first.`,
    );
    process.exit(1);
  }
  // The extension's "npx agentic-whiteboard-mcp" setup option needs the server on npm, at this version.
  const mcpVersion = JSON.parse(readFileSync('../mcp-server/package.json', 'utf8')).version;
  if (!process.argv.includes('--skip-npm-check')) {
    let published = '';
    try {
      published = execFileSync(
        process.platform === 'win32' ? 'npm.cmd' : 'npm',
        ['view', `agentic-whiteboard-mcp@${mcpVersion}`, 'version'],
        { encoding: 'utf8', shell: process.platform === 'win32' },
      ).trim();
    } catch {
      // Not published, or npm unreachable: both mean the check failed.
    }
    if (published !== mcpVersion) {
      console.error(
        `agentic-whiteboard-mcp ${mcpVersion} is not on npm, so the extension's "npx agentic-whiteboard-mcp" setup would not work.\n` +
          'Publish it first with `npm run publish:mcp` (or `npm run publish:all`), or pass --skip-npm-check.',
      );
      process.exit(1);
    }
  }
  run('npx', ['vsce', 'package', '--no-dependencies', '--out', vsix]);
  if (cmd === 'publish:vscode')
    run('npx', ['vsce', 'publish', '--no-dependencies', '--packagePath', vsix]);
  else run('npx', ['ovsx', 'publish', vsix]);
} else {
  console.error('usage: vsce.mjs package | publish:vscode | publish:openvsx');
  process.exit(1);
}
