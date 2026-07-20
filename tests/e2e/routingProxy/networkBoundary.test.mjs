import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('runtime relay is stdio-only and generic proxy code contains no target TCP listener', () => {
    const relay = fs.readFileSync(new URL('../../../Agent/server/RuntimeHttpRelay.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(relay, /\.listen\s*\(/);
    assert.doesNotMatch(relay, /createServer\s*\(/);
    assert.match(relay, /host:\s*['"]127\.0\.0\.1['"]/);
});

test('container launcher and compiled route plan expose no host TCP target', () => {
    const launcher = fs.readFileSync(new URL('../../../cli/sandbox/docker/agentServiceManager.js', import.meta.url), 'utf8');
    const routePlan = fs.readFileSync(new URL('../../../cli/server/proxy/RoutePlan.js', import.meta.url), 'utf8');
    assert.doesNotMatch(launcher, /args\.(?:push|splice)\([^\n]*['"]-p['"]/);
    assert.match(routePlan, /must not contain a host TCP target/);
});
