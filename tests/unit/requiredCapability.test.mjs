import test from 'node:test';
import assert from 'node:assert/strict';

import {
    evaluateRequiredCapabilities,
    evaluateRequiredCapability,
    normalizeRequiredCapability,
} from '../../cli/server/authHandlers/requiredCapability.js';

test('required capability admits only an exact capability from the authenticated identity', () => {
    const manifest = { routerAccess: { requiredCapability: 'explorer.access' } };
    assert.deepEqual(
        evaluateRequiredCapability(manifest, { capabilities: ['explorer.access'] }),
        { ok: true, requiredCapability: 'explorer.access' },
    );
    assert.deepEqual(
        evaluateRequiredCapability(manifest, { roles: ['admin'], capabilities: [] }),
        { ok: false, error: 'required_capability_missing', requiredCapability: 'explorer.access' },
    );
    assert.equal(evaluateRequiredCapability({}, null).ok, true);
});

test('required capability identifiers are bounded and reject ambiguous input', () => {
    assert.equal(normalizeRequiredCapability(' explorer.access '), 'explorer.access');
    assert.equal(normalizeRequiredCapability(''), null);
    assert.equal(normalizeRequiredCapability('contains whitespace'), null);
    assert.equal(normalizeRequiredCapability('x'.repeat(129)), null);
    assert.equal(normalizeRequiredCapability({ capability: 'explorer.access' }), null);
});

test('an inherited service route cannot bypass the authentication owner capability', () => {
    const owner = { routerAccess: { requiredCapability: 'explorer.access' } };
    const dependency = { routerAccess: { httpRoutes: [] } };

    assert.deepEqual(
        evaluateRequiredCapabilities([owner, dependency], { capabilities: [] }),
        { ok: false, error: 'required_capability_missing', requiredCapability: 'explorer.access' },
    );
    assert.deepEqual(
        evaluateRequiredCapabilities([owner, dependency], { capabilities: ['explorer.access'] }),
        { ok: true, requiredCapabilities: ['explorer.access'] },
    );
});

test('local role names never substitute for required capabilities', () => {
    const manifest = { routerAccess: { requiredCapability: 'app.access', localAuthRoles: ['admin', 'user'] } };
    const identity = { id: 'retained-user', roles: ['user'], capabilities: [] };
    for (const authMode of ['local', 'sso', 'guest', 'none', undefined]) {
        assert.equal(evaluateRequiredCapability(manifest, identity, { authMode }).ok, false);
    }
    assert.equal(evaluateRequiredCapability(manifest, { ...identity, authMode: 'local' }).ok, false,
        'a provider identity cannot select local policy');
    assert.equal(evaluateRequiredCapability(manifest, { roles: ['guest'] }, { authMode: 'local' }).ok, false);
    assert.equal(evaluateRequiredCapabilities([manifest, {
        routerAccess: { requiredCapability: 'other.access' },
    }], identity, { authMode: 'local' }).ok, false, 'one mapping cannot grant another manifest capability');
});
