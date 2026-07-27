import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { getCommandRegistry, isKnownCommand } from '../../cli/commands/commandRegistry.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cliEntry = path.join(repoRoot, 'cli', 'index.js');

function runCli(args) {
    return spawnSync(process.execPath, [cliEntry, ...args], {
        cwd: repoRoot,
        encoding: 'utf8',
    });
}

test('edge mutation is not exposed as a public CLI command', () => {
    const commands = getCommandRegistry();
    assert.equal(isKnownCommand('edge'), false);
    assert.equal(commands.edge, undefined);
});

test('core help does not advertise edge mutation', () => {
    const result = runCli(['help']);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.doesNotMatch(result.stdout, /\bedge(?:\s+apply)?\b/i);

    const topic = runCli(['help', 'edge']);
    assert.equal(topic.status, 0, `${topic.stdout}\n${topic.stderr}`);
    assert.match(topic.stdout, /Unknown command: edge/);
});
