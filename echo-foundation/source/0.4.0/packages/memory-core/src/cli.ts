import { validateAshleyArchive } from './index.js';
const path = process.argv[2];
if (!path) throw new Error('Usage: validate:archive <path>');
console.log(JSON.stringify(await validateAshleyArchive(path), null, 2));
