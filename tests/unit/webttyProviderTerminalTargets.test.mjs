import assert from 'node:assert/strict';
import test from 'node:test';

import { computeRchHttp, sha256RawBodyHash } from '../../Agent/lib/requestHash.mjs';
import { RouterRequestTokenService } from '../../cli/server/security/tokens/RouterRequestTokenService.js';
import {
    ProviderTerminalTargets,
    declaredTerminalProviders,
    providerProjectFor,
    validateTargetsResponse,
} from '../../cli/server/webtty/providerTerminalTargets.mjs';
import { fakeRelayManager, httpAnswer, providerPlan, PRINCIPAL } from './helpers/providerTerminalRelay.mjs';

const lease = { id: 'generation-1', isCurrent: () => true };
const ADMIN = Object.freeze({ id: 'u1', roles: ['admin'] });
const directory = (relativePath = '') => ({ relativePath });

function routePlanWith(manifests) {
    const routes = Object.fromEntries(Object.keys(manifests).map((key) => [key, { repo: 'fixture', agent: key }]));
    return { snapshot: { routing: { routes }, manifests }, lease };
}

const terminalsManifest = (path = '/fixture/terminal-control') => ({
    executionProvider: { version: 1, port: 7300, terminals: { path } },
});

function decode(token) { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); }

function discoverer(respond, options = {}) {
    const requests = [];
    const relay = fakeRelayManager((request) => { requests.push(request); return respond(request); });
    const service = new RouterRequestTokenService({ resolveAgentSecret: () => Buffer.alloc(32, 3) });
    const targets = new ProviderTerminalTargets({
        relayManager: relay,
        planEndpoint: options.planEndpoint || (({ routeKey, subpath, method, transport }) => providerPlan({
            routeKey, suffix: subpath, lease,
        })),
        signRouterRequest: (input) => service.mintWithPayloadSync(input),
        limits: { deadlineMs: 50, ...options.limits },
    });
    return { targets, relay, requests };
}

const answer = (targets) => httpAnswer(200, { version: 1, targets });

test('only enabled, valid terminals declarations are providers; an invalid declaration is reported, not skipped', () => {
    const snapshot = {
        routing: { routes: {
            b: { repo: 'r', agent: 'b' }, a: { repo: 'r', agent: 'a' }, off: { repo: 'r', agent: 'off', disabled: true },
            drain: { repo: 'r', agent: 'drain', draining: true }, refs: { repo: 'r', agent: 'refs' },
            bad: { repo: 'r', agent: 'bad' }, none: { repo: 'r', agent: 'none' },
        } },
        manifests: {
            a: terminalsManifest('/a/t'), b: terminalsManifest('/b/t'), off: terminalsManifest('/o/t'),
            drain: terminalsManifest('/d/t'),
            refs: { executionProvider: { version: 1, port: 7300, taskReferences: { path: '/refs/tr' } } },
            bad: { executionProvider: { version: 2, port: 7300, terminals: { path: '/bad/t' } } },
            none: {},
        },
    };
    assert.deepEqual(declaredTerminalProviders(snapshot), [
        { routeKey: 'a', valid: true }, { routeKey: 'b', valid: true }, { routeKey: 'bad', valid: false },
    ]);
});

test('the browser directory becomes a syntactic project: none for the root, an opaque selection otherwise', () => {
    assert.equal(providerProjectFor(directory('')), null);
    assert.equal(providerProjectFor({}), null);
    assert.deepEqual(providerProjectFor(directory('Projects/demo')), { selection: 'Projects/demo', relativePath: '' });
    assert.throws(() => providerProjectFor(directory('x'.repeat(1025))), { category: 'project_unsupported' });
    assert.throws(() => providerProjectFor(directory('a\nb')), { category: 'project_unsupported' });
});

test('the provider answer is exactly {version:1, targets:[{targetId,label}]} within its bounds', () => {
    const good = { version: 1, targets: [{ targetId: 'robot_1', label: 'Robot 1' }] };
    const parse = (value, status = 200) => validateTargetsResponse(status, Buffer.from(JSON.stringify(value)));
    assert.deepEqual(parse(good), [{ targetId: 'robot_1', label: 'Robot 1' }]);
    assert.deepEqual(parse({ version: 1, targets: [] }), []);
    for (const bad of [
        { version: 2, targets: [] }, { version: 1 }, { version: 1, targets: [], extra: 1 },
        { version: 1, targets: [{ targetId: 'a', label: 'x', extra: 1 }] },
        { version: 1, targets: [{ targetId: 'a b', label: 'x' }] },
        { version: 1, targets: [{ targetId: '', label: 'x' }] },
        { version: 1, targets: [{ targetId: 'a', label: '' }] },
        { version: 1, targets: [{ targetId: 'a', label: 'bad\u0007' }] },
        { version: 1, targets: [{ targetId: 'a', label: 'x'.repeat(129) }] },
        { version: 1, targets: [{ targetId: 'a', label: 'x' }, { targetId: 'a', label: 'y' }] },
        { version: 1, targets: Array.from({ length: 257 }, (_, i) => ({ targetId: `t${i}`, label: 'x' })) },
        [], null, 'text',
    ]) assert.equal(parse(bad), null, JSON.stringify(bad).slice(0, 80));
    assert.equal(parse(good, 500), null);
    assert.equal(validateTargetsResponse(200, Buffer.from('not json')), null);
});

test('discovery signs one POST per provider as the admitted administrator and lists its robots as provider rows', async () => {
    const { targets, requests, relay } = discoverer(() => answer([{ targetId: 'r2', label: 'Two' }, { targetId: 'r1', label: 'One' }]));
    const found = await targets.discover({
        routePlan: routePlanWith({ 'fixture-provider': terminalsManifest() }), directory: directory('Projects/demo'), user: ADMIN,
    });
    assert.equal(requests.length, 1);
    const [request] = requests;
    assert.equal(request.method, 'POST');
    assert.equal(request.path, '/fixture/terminal-control/targets');
    assert.deepEqual(JSON.parse(request.body), { project: { selection: 'Projects/demo', relativePath: '' } });
    const info = JSON.parse(request.headers['x-ploinky-auth-info']);
    const claims = decode(info.invocationToken);
    assert.equal(claims.typ, 'router-request');
    assert.equal(claims.aud, PRINCIPAL);
    assert.equal(claims.sub, 'user:u1');
    assert.deepEqual(claims.actor, { kind: 'user', id: 'user:u1', roles: ['admin'] });
    assert.equal(claims.tool, '__provider_terminal_targets__');
    assert.equal(claims.method, 'POST');
    assert.equal(claims.path, '/fixture/terminal-control/targets');
    const bodyHash = sha256RawBodyHash(request.body);
    assert.equal(claims.rch, computeRchHttp({ method: 'POST', path: '/fixture/terminal-control/targets', query: '', bodyHash }));
    for (const forbidden of ['caller', 'usr', 'delegation', 'scope', 'originKey']) assert.equal(Object.hasOwn(claims, forbidden), false);
    assert.equal(info.invocationBody.bodyHash, bodyHash);
    assert.equal(relay.checkouts[0].closed >= 1, true);

    assert.deepEqual(found.providers, []);
    assert.deepEqual(found.targets.map((row) => [row.kind, row.provider, row.targetId, row.label, row.detail, row.access, row.cwdDisplay]), [
        ['provider', 'fixture-provider', 'r1', 'One', 'fixture-provider', 'rw', 'Projects/demo'],
        ['provider', 'fixture-provider', 'r2', 'Two', 'fixture-provider', 'rw', 'Projects/demo'],
    ]);
    assert.deepEqual(found.targets[0].project, { selection: 'Projects/demo', relativePath: '' });
    assert.equal(found.targets[0].providerPrincipal, PRINCIPAL);
});

test('the workspace root sends project null and shows Home', async () => {
    const { targets, requests } = discoverer(() => answer([{ targetId: 'r1', label: 'One' }]));
    const found = await targets.discover({
        routePlan: routePlanWith({ 'fixture-provider': terminalsManifest() }), directory: directory(''), user: ADMIN,
    });
    assert.deepEqual(JSON.parse(requests[0].body), { project: null });
    assert.equal(found.targets[0].cwdDisplay, 'Home');
    assert.equal(found.targets[0].project, null);
});

test('a provider that fails is a notice with a reason code and never a row, and the others still answer', async () => {
    const answers = {
        ok: () => answer([{ targetId: 'r1', label: 'One' }]),
        denied: () => httpAnswer(403, { error: 'forbidden' }),
        big: () => httpAnswer(503, { error: 'target_inventory_too_large' }),
        broken: () => httpAnswer(200, 'not json'),
        down: () => httpAnswer(502, ''),
        silent: () => null,
    };
    const manifests = Object.fromEntries(Object.keys(answers).map((key) => [key, terminalsManifest(`/${key}/t`)]));
    manifests.unplannable = terminalsManifest('/unplannable/t');
    manifests.invalid = { executionProvider: { version: 9 } };
    // Each route answers on its own path: /<route>/t/targets.
    const { targets } = discoverer((request) => answers[request.path.split('/')[1]](), {
        planEndpoint: ({ routeKey, subpath }) => (routeKey === 'unplannable'
            ? { ok: false } : providerPlan({ routeKey, suffix: subpath, lease, path: `/${routeKey}/t` })),
        limits: { deadlineMs: 30 },
    });
    const found = await targets.discover({ routePlan: routePlanWith(manifests), directory: directory(''), user: ADMIN });
    assert.deepEqual(found.targets.map((row) => row.provider), ['ok']);
    assert.deepEqual(found.providers, [
        { name: 'big', available: false, reason: 'inventory_too_large' },
        { name: 'broken', available: false, reason: 'response_invalid' },
        { name: 'denied', available: false, reason: 'forbidden' },
        { name: 'down', available: false, reason: 'provider_unavailable' },
        { name: 'invalid', available: false, reason: 'declaration_invalid' },
        { name: 'silent', available: false, reason: 'timeout' },
        { name: 'unplannable', available: false, reason: 'provider_unavailable' },
    ]);
    assert.doesNotMatch(JSON.stringify(found.providers), /token|secret|Error/);
});

test('without a declared provider nothing is asked; a plan from another generation is stale, not a notice', async () => {
    const { targets, requests } = discoverer(() => answer([]));
    const none = await targets.discover({ routePlan: routePlanWith({ other: {} }), directory: directory(''), user: ADMIN });
    assert.deepEqual([none.targets.length, none.providers.length, requests.length], [0, 0, 0]);
    const stalePlan = { ...routePlanWith({ 'fixture-provider': terminalsManifest() }), lease: { ...lease, id: 'generation-0' } };
    await assert.rejects(targets.discover({ routePlan: stalePlan, directory: directory(''), user: ADMIN }),
        { code: 'WEBTTY_TARGET_GENERATION_STALE' });
    assert.equal(requests.length, 0);
});

test('the signed actor carries admin exactly when the administrator check passes, spelled the way that check reads it', async () => {
    const { targets, requests } = discoverer(() => answer([]));
    const routePlan = routePlanWith({ 'fixture-provider': terminalsManifest() });
    await targets.discover({ routePlan, directory: directory(''), user: { id: 'u1', roles: [' Admin ', 'User'] } });
    const claims = decode(JSON.parse(requests[0].headers['x-ploinky-auth-info']).invocationToken);
    assert.deepEqual(claims.actor.roles, ['admin', 'user']);
    for (const roles of [['user'], ['administrator'], ['admin', 'GUEST'], []]) {
        const found = await targets.discover({ routePlan, directory: directory(''), user: { id: 'u1', roles } });
        assert.deepEqual(found.providers, [{ name: 'fixture-provider', available: false, reason: 'forbidden' }], roles.join());
    }
    assert.equal(requests.length, 1, 'no request is signed for anyone who is not an administrator');
});

test('a provider over its share is a notice and keeps the others; the total never exceeds what the dialog can hold', async () => {
    const many = (count) => Array.from({ length: count }, (_, index) => ({ targetId: `t${index}`, label: `T${index}` }));
    const sizes = { a: 128, b: 129, c: 128, d: 1, e: 5 };
    const manifests = Object.fromEntries(Object.keys(sizes).map((key) => [key, terminalsManifest(`/${key}/t`)]));
    const { targets } = discoverer((request) => answer(many(sizes[request.path.split('/')[1]])), {
        planEndpoint: ({ routeKey, subpath }) => providerPlan({ routeKey, suffix: subpath, lease, path: `/${routeKey}/t` }),
    });
    const found = await targets.discover({ routePlan: routePlanWith(manifests), directory: directory(''), user: ADMIN });
    // a: 128 (fits), b: 129 (over its own bound), c: 128 (fits, total now 256), d: 1 (over what is left), e: 5 (same).
    assert.deepEqual([...new Set(found.targets.map((row) => row.provider))], ['a', 'c']);
    assert.equal(found.targets.length, 256);
    assert.deepEqual(found.providers, ['b', 'd', 'e'].map((name) => ({ name, available: false, reason: 'inventory_too_large' })));
});

test('an unnamed or guest caller gets no request signed', async () => {
    const { targets, requests } = discoverer(() => answer([]));
    for (const user of [null, { id: 'guest:1', roles: ['guest'] }, { id: '', roles: ['admin'] }]) {
        const found = await targets.discover({
            routePlan: routePlanWith({ 'fixture-provider': terminalsManifest() }), directory: directory(''), user,
        });
        assert.deepEqual(found.providers, [{ name: 'fixture-provider', available: false, reason: 'forbidden' }]);
    }
    assert.equal(requests.length, 0);
});

test('revalidation needs the same enabled instance, generation, principal and path; anything else is stale', async () => {
    const { targets } = discoverer(() => answer([{ targetId: 'r1', label: 'One' }]));
    const [row] = (await targets.discover({
        routePlan: routePlanWith({ 'fixture-provider': terminalsManifest() }), directory: directory(''), user: ADMIN,
    })).targets;
    const routePlan = routePlanWith({ 'fixture-provider': terminalsManifest() });
    assert.equal(targets.revalidate({ routePlan, target: row }), row);
    const changed = (overrides) => discoverer(() => answer([]), {
        planEndpoint: ({ routeKey, subpath }) => providerPlan({ routeKey, suffix: subpath, lease, ...overrides }),
    }).targets;
    for (const overrides of [{ instance: 'instance-2' }, { generation: 'enable-2' }, { principal: 'agent:fixture/other' }]) {
        assert.throws(() => changed(overrides).revalidate({ routePlan, target: row }), { code: 'WEBTTY_TARGET_STALE' });
    }
    const gone = discoverer(() => answer([]), { planEndpoint: () => ({ ok: false }) }).targets;
    assert.throws(() => gone.revalidate({ routePlan, target: row }), { code: 'WEBTTY_TARGET_STALE' });
});
