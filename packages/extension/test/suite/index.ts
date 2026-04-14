import * as path from 'node:path';
import Mocha from 'mocha';

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', timeout: 30_000, color: true });
  mocha.addFile(path.resolve(__dirname, 'board.test.js'));
  return new Promise((resolve, reject) => {
    mocha.run((failures) =>
      failures ? reject(new Error(`${failures} test(s) failed`)) : resolve(),
    );
  });
}
