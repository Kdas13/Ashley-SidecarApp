import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';

const roots = [resolve('apps/mobile/app'), resolve('apps/mobile/src')];
const files = [];
for (const root of roots) {
  for (const name of await readdir(root)) {
    if (/\.(ts|tsx)$/.test(name)) files.push(resolve(root, name));
  }
}

let failed = false;
for (const file of files.sort()) {
  const source = await readFile(file, 'utf8');
  const result = ts.transpileModule(source, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.ReactJSX,
      strict: true
    }
  });
  const errors = (result.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) {
    failed = true;
    for (const diagnostic of errors) {
      console.error(`${file}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`);
    }
  }
}
if (failed) process.exitCode = 1;
else console.log(`Mobile syntax check passed for ${files.length} TypeScript/TSX files.`);
