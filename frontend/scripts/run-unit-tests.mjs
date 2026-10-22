import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

const directory = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(directory).filter(name => /^test-.*\.mjs$/.test(name))
  .map(name => join(directory, name)).filter(file => readFileSync(file, 'utf8').includes('node:test')).sort();
if (!files.length) throw new Error('No unit test files were found.');
const result = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...files], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
