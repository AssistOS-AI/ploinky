import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--native')) throw new Error('Usage: node run.mjs [--native]');
const here = path.dirname(fileURLToPath(import.meta.url));
const files = args.includes('--native') ? ['native-propagation.test.mjs'] : ['propagation.test.mjs', 'rollback-scope.test.mjs'];
for (const name of ['ACHILLES', 'ALA', 'PLOINKY', 'EXPLORER']) {
    const value = process.env[`SKILLS_TEST_${name}`];
    if (!value || !path.isAbsolute(value)) throw new Error(`Set SKILLS_TEST_${name} to the candidate source directory. See README.md.`);
    await fs.access(path.join(value, name === 'ACHILLES' ? 'roboTeamAgent/package.json' : name === 'EXPLORER' ? 'explorer/package.json' : 'package.json'));
}
const child = spawn(process.execPath, ['--test', '--test-reporter=tap', ...files.map((file) => path.join(here, file))],
    { stdio: 'inherit', env: process.env });
child.on('error', (error) => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
child.on('close', (code) => { process.exitCode = code ?? 1; });
