// Prints the paths of a real VS Code build, downloading it into the shared
// cache if needed: the GUI executable, then the CLI wrapper. They are not the
// same binary -- `--install-extension` only works through the CLI wrapper.
import {
  downloadAndUnzipVSCode,
  resolveCliPathFromVSCodeExecutablePath
} from '@vscode/test-electron';

const exe = await downloadAndUnzipVSCode({
  cachePath: process.env.VSCODE_TEST_CACHE || '/cache'
});
console.log(exe);
console.log(resolveCliPathFromVSCodeExecutablePath(exe));
