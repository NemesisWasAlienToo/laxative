import * as path from 'path';
import Mocha from 'mocha';
import { globSync } from 'glob';

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', color: true, timeout: 30000 });
  const testsRoot = __dirname;
  for (const file of globSync('**/*.test.js', { cwd: testsRoot })) {
    mocha.addFile(path.resolve(testsRoot, file));
  }
  return new Promise((resolve, reject) => {
    mocha.run((failures) => (failures > 0 ? reject(new Error(`${failures} test(s) failed`)) : resolve()));
  });
}
