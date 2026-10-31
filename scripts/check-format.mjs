import { globSync, readFileSync } from 'node:fs';
import { ESLint } from 'eslint';
import * as prettier from 'prettier';

const eslint = new ESLint({ fix: true });
const files = [...globSync(['src/**/*.ts', 'webview/**/*.ts'])];
if (files.length === 0)
  throw new Error('No TypeScript sources found. Run from the repository root.');
let failed = false;
for (const file of files) {
  const source = readFileSync(file, 'utf8');
  const formatted = await prettier.format(source, {
    ...(await prettier.resolveConfig(file)),
    filepath: file
  });
  const [result] = await eslint.lintText(formatted, { filePath: file });
  if (result.errorCount || (result.output ?? formatted) !== source) {
    console.error(`${file}: run npm run format`);
    failed = true;
  }
}
process.exitCode = failed ? 1 : 0;
