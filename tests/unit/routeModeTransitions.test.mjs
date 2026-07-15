import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { mergeRuntimeRoute } from '../../cli/services/routingFile.js';

const oldRouted = {
    container: 'old-container',
    hostPort: 30101,
    additionalServerPort: 30102,
};

test('no-wait default-to-none route transition deletes stale ports', () => {
    assert.deepEqual(
        mergeRuntimeRoute(oldRouted, { container: 'none-container' }, {
            hostPort: null,
            additionalServerPort: null,
        }),
        { container: 'none-container' },
    );
    const source = fs.readFileSync(new URL('../../cli/services/noWaitWorker.js', import.meta.url), 'utf8');
    assert.match(source, /profileResolution\.network\.mode === 'none'/);
    assert.match(source, /hostPort: routedHostPort/);
    assert.match(source, /mergeRuntimeRoute/);
});

test('monitor default-to-none route transition deletes stale ports', () => {
    assert.deepEqual(
        mergeRuntimeRoute(oldRouted, { container: 'restarted-none-container' }, {
            hostPort: 0,
            additionalServerPort: null,
        }),
        { container: 'restarted-none-container' },
    );
    const source = fs.readFileSync(new URL('../../cli/server/containerMonitor.js', import.meta.url), 'utf8');
    assert.match(source, /hostPort: networkMode === 'none' \? null : result\.hostPort \|\| null/);
    assert.match(source, /profileResolution\.network\.mode/);
    assert.match(source, /mergeRuntimeRoute/);
});

test('routable route updates replace both runtime ports', () => {
    assert.deepEqual(
        mergeRuntimeRoute(oldRouted, { container: 'new-container' }, {
            hostPort: 40101,
            additionalServerPort: 40102,
        }),
        {
            container: 'new-container',
            hostPort: 40101,
            additionalServerPort: 40102,
        },
    );
});
