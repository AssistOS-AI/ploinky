import test from 'node:test';
import assert from 'node:assert/strict';

import { bootstrapAgentCredentialContext } from '../../Agent/lib/agentCredentialBootstrap.mjs';

const trustedContext = Object.freeze({ trusted: true });

test('credential bootstrap selects the exact bwrap descriptor path without container fallback', () => {
    const calls = [];
    const result = bootstrapAgentCredentialContext({ PLOINKY_RUNTIME: 'bwrap' }, {
        createBwrapContext() {
            calls.push('bwrap');
            return trustedContext;
        },
        createContainerContext() {
            calls.push('container');
            throw new Error('container fallback must not run');
        },
        assertContext(value) {
            assert.equal(value, trustedContext);
            return value;
        },
    });
    assert.equal(result, trustedContext);
    assert.deepEqual(calls, ['bwrap']);

    assert.throws(() => bootstrapAgentCredentialContext({ PLOINKY_RUNTIME: 'bwrap' }, {
        createBwrapContext() {
            throw Object.assign(new Error('descriptor invalid'), { code: 'DESCRIPTOR_INVALID' });
        },
        createContainerContext() {
            calls.push('forbidden-fallback');
            return trustedContext;
        },
        assertContext: value => value,
    }), error => error?.code === 'DESCRIPTOR_INVALID');
    assert.equal(calls.includes('forbidden-fallback'), false);
});

test('credential bootstrap selects the exact container context without bwrap fallback', () => {
    const env = Object.freeze({
        PLOINKY_RUNTIME: 'container',
        PLOINKY_ROUTER_DESCRIPTOR_FILE: '/run/ploinky/router-descriptor.json',
    });
    const calls = [];
    const result = bootstrapAgentCredentialContext(env, {
        createBwrapContext() {
            calls.push('bwrap');
            throw new Error('bwrap fallback must not run');
        },
        createContainerContext(observedEnv) {
            calls.push('container');
            assert.equal(observedEnv, env);
            return trustedContext;
        },
        assertContext: value => value,
    });
    assert.equal(result, trustedContext);
    assert.deepEqual(calls, ['container']);
});

test('credential bootstrap rejects missing, tolerant, or mixed runtime provenance', () => {
    const dependencies = {
        createBwrapContext: () => trustedContext,
        createContainerContext: () => trustedContext,
        assertContext: value => value,
    };
    for (const env of [
        {},
        { PLOINKY_RUNTIME: ' bwrap ' },
        { PLOINKY_RUNTIME: 'podman' },
        { PLOINKY_RUNTIME: 'seatbelt' },
        {
            PLOINKY_RUNTIME: 'container',
            PLOINKY_AGENT_CREDENTIAL_FILE: '/run/ploinky-agent/credential.json',
        },
        {
            PLOINKY_RUNTIME: 'bwrap',
            PLOINKY_ROUTER_DESCRIPTOR_FILE: '/run/ploinky/router-descriptor.json',
        },
    ]) {
        assert.throws(
            () => bootstrapAgentCredentialContext(env, dependencies),
            error => error?.code === 'PLOINKY_AGENT_CREDENTIAL_RUNTIME_INVALID',
        );
    }
});
