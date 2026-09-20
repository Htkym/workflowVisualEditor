import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await mkdir('artifacts', { recursive: true });
await Promise.all([
  build({ entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'], sourcemap: false }),
  build({ entryPoints: ['webview/main.ts'], outfile: 'dist/webview.js', bundle: true, platform: 'browser', target: 'es2022', sourcemap: false }),
  copyFile('webview/main.css', 'dist/webview.css')
]);
