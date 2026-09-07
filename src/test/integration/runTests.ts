import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { runTests } from '@vscode/test-electron';

/** Builds a throwaway workspace so tests never touch a real project. */
function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'laxative-ws-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(
    path.join(dir, 'src', 'app.ts'),
    [
      'export function alpha() {',
      '  const value = compute();',
      '  return value;',
      '}',
      '',
      'export function beta() {',
      '  return 42;',
      '}',
      ''
    ].join('\n')
  );
  return dir;
}

async function main(): Promise<void> {
  const root = path.resolve(__dirname, '../../..');
  const workspace = makeWorkspace();
  try {
    await runTests({
      // Cached in a docker volume so repeat runs don't re-download VS Code.
      cachePath: process.env.VSCODE_TEST_CACHE || path.join(root, '.vscode-test'),
      extensionDevelopmentPath: root,
      extensionTestsPath: path.resolve(__dirname, './index'),
      launchArgs: [
        workspace,
        '--disable-extensions',
        '--disable-gpu',
        '--no-sandbox',
        '--disable-workspace-trust',
        `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'laxative-ud-'))}`
      ]
    });
  } catch (err) {
    console.error('Integration tests failed:', err);
    process.exit(1);
  }
}

void main();
