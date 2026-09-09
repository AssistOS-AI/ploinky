import test from 'node:test';
import assert from 'node:assert/strict';

import { getDefaultBootRepos, getPredefinedRepos, resolveRepoUrl } from '../../cli/utils/repos.js';

test('default boot repos include only AchillesIDE, AchillesCLI, and copilot-agents', () => {
    const names = getDefaultBootRepos().map(repo => repo.name);

    assert.deepEqual(names, ['AchillesIDE', 'AchillesCLI', 'copilot-agents']);
});

test('basic remains available for explicit installation by name', () => {
    assert.equal(resolveRepoUrl('basic'), 'https://github.com/AssistOS-AI/Basic.git');
    assert.equal(getPredefinedRepos().basic.kind, 'agents');
});
