import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchWithBrowserMutationProof } from '../../cli/server/webchat/network.js';

const LOCATION = Object.freeze({
    href: 'https://explorer.example/webchat?agent=achilles-cli',
    origin: 'https://explorer.example',
});

function response(status, payload) {
    return new Response(
        payload === undefined ? null : JSON.stringify(payload),
        {
            status,
            headers: payload === undefined
                ? {}
                : { 'content-type': 'application/json' },
        },
    );
}

function proof(token) {
    return response(200, {
        ok: true,
        browserMutation: {
            origin: LOCATION.origin,
            routeKey: 'achilles-cli',
            csrfToken: token,
        },
    });
}

test('webchat mutation uses a route-bound browser proof', async () => {
    const calls = [];
    const fetchImpl = async (endpoint, options) => {
        calls.push({ endpoint: String(endpoint), options });
        if (calls.length === 1) return proof('proof-one');
        return response(204);
    };

    const result = await fetchWithBrowserMutationProof(
        'achilles-cli',
        '/webchat/input?tabId=tab-1',
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{"text":"/help"}\n',
        },
        {
            fetchImpl,
            locationRef: LOCATION,
            retryDelays: [],
        },
    );

    assert.equal(result.status, 204);
    assert.equal(calls.length, 2);
    assert.equal(
        calls[0].endpoint,
        'https://explorer.example/auth/token?mutationRoute=achilles-cli',
    );
    assert.equal(calls[1].endpoint, '/webchat/input?tabId=tab-1');
    assert.equal(
        calls[1].options.headers.get('x-ploinky-browser-csrf-token'),
        'proof-one',
    );
    assert.equal(calls[1].options.credentials, 'include');
});

test('webchat mutation rotates proof after an exact generation rejection', async () => {
    const calls = [];
    const waits = [];
    const fetchImpl = async (endpoint, options) => {
        calls.push({ endpoint: String(endpoint), options });
        if (calls.length === 1) return proof('stale-proof');
        if (calls.length === 2) return response(503, { error: 'edge_generation_changed' });
        if (calls.length === 3) return proof('fresh-proof');
        return response(204);
    };

    const result = await fetchWithBrowserMutationProof(
        'achilles-cli',
        '/webchat/input?tabId=tab-1',
        {
            method: 'POST',
            body: 'same-input',
        },
        {
            fetchImpl,
            locationRef: LOCATION,
            retryDelays: [250],
            wait: async (delay) => waits.push(delay),
        },
    );

    assert.equal(result.status, 204);
    assert.deepEqual(waits, [250]);
    assert.equal(calls.length, 4);
    assert.equal(calls[1].options.body, 'same-input');
    assert.equal(calls[3].options.body, 'same-input');
    assert.equal(
        calls[3].options.headers.get('x-ploinky-browser-csrf-token'),
        'fresh-proof',
    );
});

test('webchat mutation retries an exact invalid proof and fails closed otherwise', async () => {
    const retryCalls = [];
    const retryFetch = async (endpoint) => {
        retryCalls.push(String(endpoint));
        if (retryCalls.length === 1) return proof('old-proof');
        if (retryCalls.length === 2) return response(403, { error: 'browser_csrf_invalid' });
        if (retryCalls.length === 3) return proof('new-proof');
        return response(204);
    };
    const retried = await fetchWithBrowserMutationProof(
        'achilles-cli',
        '/webchat/input',
        { method: 'POST' },
        {
            fetchImpl: retryFetch,
            locationRef: LOCATION,
            retryDelays: [0],
            wait: async () => {},
        },
    );
    assert.equal(retried.status, 204);
    assert.equal(retryCalls.length, 4);

    const deniedCalls = [];
    const deniedFetch = async (endpoint) => {
        deniedCalls.push(String(endpoint));
        return deniedCalls.length === 1
            ? proof('valid-proof')
            : response(503, { error: 'agent_runtime_inactive' });
    };
    const denied = await fetchWithBrowserMutationProof(
        'achilles-cli',
        '/webchat/input',
        { method: 'POST' },
        {
            fetchImpl: deniedFetch,
            locationRef: LOCATION,
            retryDelays: [0, 0],
            wait: async () => {},
        },
    );
    assert.equal(denied.status, 503);
    assert.equal(deniedCalls.length, 2);
});

test('webchat mutation rejects a proof bound to a different route', async () => {
    const mismatched = response(200, {
        ok: true,
        browserMutation: {
            origin: LOCATION.origin,
            routeKey: 'other-agent',
            csrfToken: 'wrong-route',
        },
    });
    await assert.rejects(
        fetchWithBrowserMutationProof(
            'achilles-cli',
            '/webchat/input',
            { method: 'POST' },
            {
                fetchImpl: async () => mismatched,
                locationRef: LOCATION,
                retryDelays: [],
            },
        ),
        /browser mutation proof unavailable/,
    );
});
