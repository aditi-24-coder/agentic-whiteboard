import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

// Runs the mocha suite inside a real VS Code with the extension loaded from
// `AGENTIC_WHITEBOARD_EXTENSION_PATH` (an unpacked .vsix) or from this package.
async function main() {
  // Set when this runs from a terminal inside VS Code; it would make Code start as plain Node.
  delete process.env.ELECTRON_RUN_AS_NODE;
  const extensionDevelopmentPath =
    process.env.AGENTIC_WHITEBOARD_EXTENSION_PATH ?? path.resolve(__dirname, '../..');
  const extensionTestsPath = path.resolve(__dirname, './suite/index');
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'agentic-whiteboard-ws-'));
  const userData = mkdtempSync(path.join(os.tmpdir(), 'agentic-whiteboard-ud-'));
  mkdirSync(path.join(workspace, '.agentic-whiteboard'));
  cpSync(
    path.resolve(__dirname, '../../../shared/test/fixtures/stripe-payments.plan.json'),
    path.join(workspace, '.agentic-whiteboard', 'stripe-payments.plan.json'),
  );
  try {
    await runTests({
      version: process.env.VSCODE_TEST_VERSION ?? 'stable',
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        workspace,
        '--disable-extensions',
        '--disable-workspace-trust',
        `--user-data-dir=${userData}`,
      ],
      extensionTestsEnv: { AGENTIC_WHITEBOARD_TEST_WORKSPACE: workspace },
    });
  } catch (err) {
    console.error('Extension tests failed', err);
    process.exitCode = 1;
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
  }
}

void main();
