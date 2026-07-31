import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = fs.readFileSync(path.join(repoRoot, 'cli', 'commands', 'settingsMenu.js'), 'utf8');

test('the public Soul model catalog never consumes the generated local-agent key', () => {
    assert.doesNotMatch(source, /PLOINKY_AGENT_API_KEY/);
    assert.match(source, /getSecret\('SOUL_GATEWAY_API_KEY'\)/);
    assert.match(source, /https:\/\/soul\.axiologic\.dev\/v1\/models/);
});
