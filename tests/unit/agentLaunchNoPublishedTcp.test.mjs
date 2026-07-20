import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const LAUNCHERS = [
    new URL('../../cli/sandbox/docker/agentServiceManager.js', import.meta.url),
    new URL('../../cli/sandbox/docker/common.js', import.meta.url),
    new URL('../../cli/sandbox/bwrap/bwrapServiceManager.js', import.meta.url),
    new URL('../../cli/sandbox/seatbelt/seatbeltServiceManager.js', import.meta.url),
];

test('agent launchers contain no TCP publication or removed port-profile readers', () => {
    const removedKeys = [
        ['open', 'Ports'].join(''),
        ['parse', 'Manifest', 'Ports'].join(''),
        ['additional', 'Server', 'Port'].join(''),
    ];
    for (const file of LAUNCHERS) {
        const source = fs.readFileSync(file, 'utf8');
        for (const key of removedKeys) assert.equal(source.includes(key), false, `${file.pathname} contains ${key}`);
        assert.doesNotMatch(source, /args\.(?:push|splice)\([^\n]*['"]-p['"]/);
        assert.doesNotMatch(source, /(?:publish|expose)[^\n]*tcp/i);
    }
});
