import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

const PROBE_PATH = path.resolve(
    import.meta.dirname,
    '../helpers/ploinkyBoxPrivateRoutingProbe.mjs',
);

test('private-routing probe links only current listener modules before validating input', () => {
    const result = spawnSync(process.execPath, [PROBE_PATH, 'not-an-immutable-id', '[]'], {
        encoding: 'utf8',
        timeout: 5_000,
        killSignal: 'SIGKILL',
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /private-routing probe requires one immutable nested container ID/);
    assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND/);
    assert.equal(result.stdout, '');
});
