import { prepareAshleyImport } from './index.js';
const path = process.argv[2];
if (!path) throw new Error('Usage: prepare:archive <path>');
const prepared = await prepareAshleyImport(path);
console.log(JSON.stringify(prepared.preview, null, 2));
