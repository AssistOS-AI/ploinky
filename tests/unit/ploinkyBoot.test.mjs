import test from 'node:test';
import assert from 'node:assert/strict';

import { getDefaultBootRepos } from '../../cli/utils/repos.js';

test('default boot repos include basic, AchillesIDE, AchillesCLI, and copilot-agents', () => {
    const names = getDefaultBootRepos().map(repo => repo.name);

    assert.deepEqual(names, ['basic', 'AchillesIDE', 'AchillesCLI', 'copilot-agents']);
});
