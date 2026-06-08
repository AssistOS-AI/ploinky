import test from 'node:test';
import assert from 'node:assert/strict';

const moduleSuffix = `?t=${Date.now()}`;
const { hasInternalAgentSegment } = await import(`../../cli/server/internalAgentPath.js${moduleSuffix}`);
// The REAL http-service upstream-path synthesizer, to replicate the bypass probe.
const { buildServiceAgentPath } = await import(`../../cli/server/httpServiceRoutes.js${moduleSuffix}`);

test('hasInternalAgentSegment flags raw __agent segments anywhere', () => {
    assert.equal(hasInternalAgentSegment('/__agent/public-route-share/authorize'), true);
    assert.equal(hasInternalAgentSegment('/explorer/__agent/x'), true);
    assert.equal(hasInternalAgentSegment('/svc/sub/__agent/x'), true);
    assert.equal(hasInternalAgentSegment('/__agent'), true);
});

test('hasInternalAgentSegment decodes percent-encoded __agent segments', () => {
    // %5F = '_', so %5F%5Fagent decodes to __agent.
    assert.equal(hasInternalAgentSegment('/explorer/%5F%5Fagent/x'), true);
    assert.equal(hasInternalAgentSegment('/explorer/%5f%5fagent/authorize'), true);
    // Double-encoded (%255F -> %5F -> _) is also caught.
    assert.equal(hasInternalAgentSegment('/explorer/%255F%255Fagent/x'), true);
});

test('hasInternalAgentSegment ignores the query string and __agent-like names', () => {
    assert.equal(hasInternalAgentSegment('/explorer/app?next=/__agent/x'), false);
    assert.equal(hasInternalAgentSegment('/explorer/__agentlike/x'), false);
    assert.equal(hasInternalAgentSegment('/explorer/index.html'), false);
    assert.equal(hasInternalAgentSegment('/explorer/v1/chat/completions'), false);
});

test('an httpServices internalPrefix that rewrites to __agent is caught (bypass probe)', () => {
    // Replicates the verified bypass: an innocent external path whose service
    // route rewrites it to the agent control plane via internalPrefix.
    const upstream = buildServiceAgentPath(
        '/public-services/control/authorize',
        '?x=1',
        '/public-services/control/',
        '/__agent/',
    );
    // The synthesized upstream targets the agent control plane...
    assert.match(upstream, /^\/__agent\//);
    // ...and the router's guard refuses it.
    assert.equal(hasInternalAgentSegment(upstream), true);
});

test('a normal httpServices internalPrefix is not flagged', () => {
    const upstream = buildServiceAgentPath(
        '/public-services/control/status',
        '',
        '/public-services/control/',
        '/api/',
    );
    assert.equal(hasInternalAgentSegment(upstream), false);
});
