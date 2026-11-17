import * as path from 'path';
import Mocha from 'mocha';
import { globSync } from 'glob';

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', color: true, timeout: 30000 });
  const testsRoot = __dirname;
  // The performance run (600 files, 6,000 notes) only when asked for, with
  // `./docker/test.sh perf`: it measures, and it takes a while. Then it runs
  // alone, so nothing else runs in what it leaves behind.
  const perf = process.env.LAXATIVE_PERF === '1';
  const files = globSync('**/*.test.js', { cwd: testsRoot })
    .filter((file) => file.includes('perf') === perf)
    .sort();
  for (const file of files) {
    mocha.addFile(path.resolve(testsRoot, file));
  }
  return new Promise((resolve, reject) => {
    mocha.run((failures) => (failures > 0 ? reject(new Error(`${failures} test(s) failed`)) : resolve()));
  });
}
