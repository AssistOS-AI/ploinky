import test from 'node:test';
import assert from 'node:assert/strict';
import { accessSync, constants, readFileSync } from 'node:fs';
import path from 'node:path';

import { DIRECT_CLI_PATH } from '../../cli/utils/directCli.js';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');

test('Router control handlers dispatch through the direct execution-plane CLI', () => {
    assert.equal(DIRECT_CLI_PATH, path.join(repositoryRoot, 'bin', 'ploinky-local'));
    accessSync(DIRECT_CLI_PATH, constants.X_OK);

    for (const relativePath of [
        'cli/server/handlers/dashboard.js',
        'cli/server/handlers/status.js',
    ]) {
        const source = readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
        assert.match(source, /spawn\(DIRECT_CLI_PATH,/);
        assert.doesNotMatch(source, /spawn\(['"]ploinky['"],/);
    }
});
