import assert from 'node:assert/strict';
import test from 'node:test';

import { ProviderTerminalHub, isRoutingLeaseCurrent } from '../../cli/server/webtty/providerTerminalHub.mjs';
import { RouterRequestTokenService } from '../../cli/server/security/tokens/RouterRequestTokenService.js';
import { RouterServiceTokenService } from '../../cli/server/security/tokens/RouterServiceTokenService.js';
import { terminalLaunchHash } from '../../cli/server/webtty/providerTerminalProtocol.mjs';
import { ProviderTerminalSessionWorker } from '../../cli/server/webtty/providerTerminalSession.mjs';
import {
    ManualClock, ScriptedTerminalTransport, OWNER, GENERATION, PTY, SECRET, fields, flush, nonceFor,
} from './helpers/providerTerminalTransport.mjs';

// The claims of a token the test just minted (no signature check is needed to
// read what the hub asked the minter to sign).
const decodeJwtPayloadUnsafe = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));

const PRINCIPAL = 'agent:fixture/provider';
const PATH = '/fixture-terminals';
const ROUTE = 'fixture-provider';

// A scripted worker: it answers each connection's control frames the way the
// real endpoint does, and records what the Router sent.
function harness(options = {}) {
    const clock = new ManualClock();
    const transports = [];
    const hellos = [];
    const reattaches = [];
    const launches = [];
    const lease = { id: 'generation-1', current: true, isCurrent() { return this.current; } };
    const state = { lease, openFailures: options.openFailures || 0, helloRefusals: options.helloRefusals || 0,
        inventory: options.inventory, plannable: true };
    let tokenCount = 0;
    const service = new RouterServiceTokenService({
        resolveAgentSecret: () => Buffer.alloc(32, 99),
        now: () => new Date(clock.time), randomId: () => `fixture-jti-${++tokenCount}`,
    });
    const captureLease = () => {
        state.lease = { id: 'generation-1', current: true, isCurrent() { return this.current; } };
        state.leases = [...(state.leases || []), state.lease];
        return state.lease;
    };
    const hub = new ProviderTerminalHub({
        relayManager: {},
        routerServiceTokenService: service,
        validateAdmin: options.validateAdmin || (async () => ({ ok: true, session: { user: { id: 'u1', roles: ['admin'] } } })),
        mintRouterRequest: options.mintRouterRequest || ((input) => ({ token: `evidence-${++tokenCount}`, input })),
        planEndpoint: () => (state.plannable ? {
            ok: true, relay: { targetAgentId: PRINCIPAL }, unmatchedSuffix: state.path || PATH, generationDigest: 'generation-1',
            lease: state.lease,
        } : { ok: false }),
        captureLease,
        openTransport: async () => {
            state.opens = (state.opens || 0) + 1;
            if (state.openFailures > 0) { state.openFailures -= 1; throw new Error('transport'); }
            const transport = new ScriptedTerminalTransport();
            transport.nonce = nonceFor(transports.length);
            transports.push(transport);
            const send = transport.send.bind(transport);
            transport.send = (data, opts, callback) => {
                send(data, opts, callback);
                if (opts.binary) return;
                const frame = JSON.parse(data);
                queueMicrotask(() => {
                    if (frame.type === 'hello') {
                        hellos.push(frame);
                        if (state.helloRefusals > 0) { state.helloRefusals -= 1; transport.emit('close'); return; }
                        transport.peer('hello-ok', { ownershipSessionId: OWNER, workerGeneration: GENERATION,
                            leaseExpiresAt: 12, secret: SECRET });
                    } else if (frame.type === 'reattach') {
                        reattaches.push(frame);
                        transport.peer('reattach-ok', { leaseExpiresAt: 12, ptys: state.inventory ?? [] });
                    } else if (frame.type === 'heartbeat') {
                        if (!options.silent) transport.peer('heartbeat-ok', { leaseExpiresAt: 12 });
                    } else if (frame.type === 'launch') {
                        launches.push(frame);
                        state.launchFrames = (state.launchFrames || 0) + 1;
                        if (state.launchFrames <= (options.silentLaunches || 0)) return;
                        if (options.refuseLaunch) {
                            transport.peer('launch-failed', { operationId: frame.operationId, code: options.refuseLaunch });
                            return;
                        }
                        transport.peer('launched', { operationId: frame.operationId, ptySessionId: PTY });
                    }
                });
            };
            (async () => { await flush(); transport.peer('challenge', { nonce: transport.nonce }); })();
            return transport;
        },
        limits: { handshakeMs: 200, sendMs: 50, operationMs: 100, heartbeatMs: 1000, leaseMs: 3000,
            operations: 8, ptys: 8, queueBytes: 4096, inputBytes: 4096 },
        timing: { backoffBaseMs: 100, backoffMaxMs: 400, routingCheckMs: 500, connectWaitMs: 5000, launchWindowMs: 450 },
        now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
        audit: () => {},
    });
    return { hub, clock, transports, hellos, reattaches, launches, state };
}

// Virtual time in small steps, so that every microtask chain a timer starts
// (connect, handshake, rotation) runs to its next wait before the next step.
async function run(h, ms, step = 10) {
    for (let elapsed = 0; elapsed < ms; elapsed += step) await h.clock.advance(Math.min(step, ms - elapsed));
}

async function ready(h) {
    const pending = h.hub.launch(ROUTE, fields(), { routing: h.state.lease, admin: { userId: 'u1' } });
    await flush();
    return pending;
}

test('initial connect backs off after each failure and one hello creates the ownership', async () => {
    const h = harness({ openFailures: 2 });
    const launching = ready(h);
    await run(h, 100);
    await run(h, 200);
    assert.equal(await launching, PTY);
    assert.equal(h.hellos.length, 1, 'one hello, after the transport failures');
    assert.equal(h.state.openFailures, 0);
    assert.deepEqual(h.hub.status(ROUTE), { state: 'connected', hasClient: true, failure: null });
    await h.hub.shutdown();
});

test('a refused first hello does not strand the provider: the same client sends hello again', async () => {
    const h = harness({ helloRefusals: 1 });
    const launching = ready(h);
    await run(h, 400);
    assert.equal(await launching, PTY);
    assert.equal(h.hellos.length, 2, 'the refused hello is retried as a new hello');
    assert.equal(h.reattaches.length, 0);
    await h.hub.shutdown();
});

test('a worker refusal reaches the caller as a final refusal with its reason, through a real session worker', async () => {
    const h = harness({ refuseLaunch: 'robot_not_ready' });
    const direct = h.hub.launch(ROUTE, fields(), { routing: h.state.lease, admin: { userId: 'u1' } })
        .then(() => null, (error) => error);
    await run(h, 400);
    const refused = await direct;
    assert.equal(refused.code, 'PROVIDER_TERMINAL_LAUNCH_FAILED');
    assert.equal(refused.refusal, 'robot_not_ready');
    assert.equal(h.hub.status(ROUTE).state, 'connected', 'a refusal leaves the connection and ownership alone');

    const worker = new ProviderTerminalSessionWorker({
        hub: h.hub, routeKey: ROUTE, target: { targetId: 'target_1', project: null }, adminLease: { userId: 'u1' },
    });
    const starting = worker.start({ cols: 80, rows: 24 }).then(() => null, (error) => error);
    await run(h, 400);
    const error = await starting;
    assert.equal(error.code, 'WEBTTY_PROVIDER_LAUNCH_REFUSED');
    assert.equal(error.reason, 'robot_not_ready');
    await h.hub.shutdown();
});

test('a channel close rotates under the same ownership: reattach with proof, never a second hello', async () => {
    const h = harness();
    await ready(h);
    const first = h.transports[0];
    first.emit('close');
    await run(h, 400);
    await flush();
    assert.equal(h.transports.length, 2, 'a new channel was opened');
    assert.equal(h.hellos.length, 1, 'ownership is kept, so no second hello');
    assert.equal(h.reattaches.length, 1);
    assert.equal(typeof h.reattaches[0].proof, 'string');
    assert.equal(h.reattaches[0].ownershipSessionId, OWNER);
    assert.equal(h.hub.status(ROUTE).state, 'connected');
    await h.hub.shutdown();
});

test('a failed rotation retries with backoff while the ownership deadline holds', async () => {
    const h = harness();
    await ready(h);
    h.state.openFailures = 2;
    h.transports[0].emit('close');
    await run(h, 400);
    assert.equal(h.hub.status(ROUTE).state, 'reconnecting');
    await run(h, 100);
    await run(h, 200);
    await flush();
    assert.equal(h.hellos.length, 1);
    assert.equal(h.reattaches.length, 1);
    assert.equal(h.hub.status(ROUTE).state, 'connected');
    await h.hub.shutdown();
});

test('a slow launch is retried with the same operation id within the ownership and joins the one in flight', async () => {
    const h = harness({ silentLaunches: 2 });
    const launching = h.hub.launch(ROUTE, fields(), { routing: h.state.lease, admin: { userId: 'u1' } });
    await run(h, 20);
    assert.equal(h.launches.length, 1);
    await run(h, 400);
    assert.equal(await launching, PTY);
    assert.equal(h.launches.length, 3, 'two silent attempts, then the answer');
    assert.deepEqual([...new Set(h.launches.map((frame) => frame.operationId))], [fields().operationId],
        'every retry names the same operation');
    assert.equal(new Set(h.launches.map((frame) => frame.launchEvidence)).size, 3,
        'each attempt carries freshly minted evidence');
    await h.hub.shutdown();
});

test('a launch that never answers is retried only within the launch window, then fails as uncertain', async () => {
    const h = harness({ silentLaunches: 1000 });
    const launching = h.hub.launch(ROUTE, fields(), { routing: h.state.lease, admin: { userId: 'u1' } })
        .then(() => null, (error) => error);
    await run(h, 1500);
    const error = await launching;
    assert.equal(error.code, 'PROVIDER_TERMINAL_LAUNCH_UNCERTAIN');
    assert.equal(h.launches.length >= 3 && h.launches.length <= 6, true, `${h.launches.length} launch frames`);
    const before = h.launches.length;
    await run(h, 1000);
    assert.equal(h.launches.length, before, 'no retry after the window');
    await h.hub.shutdown();
});

test('competing demand cannot make the hub connect faster than its backoff', async () => {
    const h = harness();
    h.state.openFailures = 1_000_000;
    const outcomes = [];
    // A new caller every 20 ms for two seconds, each wanting a connection.
    for (let at = 0; at < 2000; at += 20) {
        outcomes.push(h.hub.launch(ROUTE, fields({ operationId: `55555555-5555-4555-8555-${String(at).padStart(12, '0')}` }),
            { routing: h.state.lease, admin: { userId: 'u1' } }).catch((error) => error));
        await run(h, 20);
    }
    // Attempts at 0, 100, 300, 700, 1100, 1500, 1900 ms: backoff 100, 200, 400 (capped) between them.
    assert.equal(h.state.opens <= 8, true, `opened ${h.state.opens} times`);
    assert.equal(h.state.opens >= 5, true, `opened ${h.state.opens} times`);
    h.state.openFailures = 0;
    await run(h, 6000);
    const results = await Promise.all(outcomes);
    assert.equal(results.filter((result) => result === PTY).length > 0, true, 'demand is served once the provider is back');
    await h.hub.shutdown();
});

test('a flapping channel is rotated at the backoff pace until a connection has held for a while, then at once', async () => {
    const h = harness({ inventory: [{ ptySessionId: PTY, inputNext: '1', outputLast: '0' }] });
    await ready(h);
    for (let flap = 0; flap < 10; flap += 1) {
        h.transports.at(-1).emit('close');
        await run(h, 10);
    }
    await run(h, 20);
    assert.equal(h.reattaches.length <= 1, true, `${h.reattaches.length} reattaches within 120 ms`);
    // The paced rotations grow: a second flap waits longer than the first.
    await run(h, 2000);
    const before = h.reattaches.length;
    // Healthy for longer than stableMs: the next loss is rotated at once.
    await run(h, 31_000);
    h.transports.at(-1).emit('close');
    await run(h, 20);
    assert.equal(h.reattaches.length, before + 1, 'rotated at once after a stable connection');
    await h.hub.shutdown();
});

test('a stale routing lease of the connected client is rotated, before the next operation fails on it', async () => {
    const h = harness({ inventory: [{ ptySessionId: PTY, inputNext: '1', outputLast: '0' }] });
    await ready(h);
    const watched = [];
    h.hub.watch(ROUTE, PTY, { resumed: () => watched.push('resumed') });
    h.state.leases[0].current = false;
    await run(h, 800);
    await flush();
    assert.equal(h.reattaches.length, 1, 'rotated under a new lease');
    assert.equal(h.hellos.length, 1);
    assert.equal(h.state.leases.length, 2);
    assert.deepEqual(watched, ['resumed'], 'watchers are told to attach again');
    assert.equal(h.transports[0].closed >= 1, true, 'the old channel was closed after the new one took over');
    await h.hub.shutdown();
});

test('a lease that went stale between two operations is rotated lazily by the next operation', async () => {
    const h = harness();
    await ready(h);
    h.state.leases[0].current = false;
    const pending = h.hub.input(ROUTE, PTY, Buffer.from('x')).catch((error) => error);
    await flush();
    await run(h, 400);
    const result = await pending;
    assert.equal(h.reattaches.length, 1);
    assert.notEqual(result?.code, 'PROVIDER_TERMINAL_STALE_LEASE', 'the operation did not fail on the stale connect lease');
    await h.hub.shutdown();
});

test('only the client shutdown (here the lease expiring) replaces the client; sessions end with cause shutdown and a new hello follows', async () => {
    const h = harness({ silent: true });
    await ready(h);
    const ended = [];
    h.hub.watch(ROUTE, PTY, { ended: (frame) => ended.push(frame) });
    // No heartbeat is answered; every rotation is refused: the deadline passes.
    h.state.openFailures = 1000;
    h.transports[0].emit('close');
    await run(h, 3000);
    await flush();
    assert.deepEqual(ended.map((frame) => [frame.cause, frame.local]), [['shutdown', true]]);
    assert.equal(h.hub.status(ROUTE).hasClient, false, 'the closed client was dropped');
    assert.equal(h.hellos.length, 1);
    h.state.openFailures = 0;
    const second = h.hub.launch(ROUTE, fields({ operationId: '44444444-4444-4444-8444-444444444444' }),
        { routing: h.state.lease, admin: { userId: 'u1' } });
    await run(h, 1000);
    await flush();
    assert.equal(await second, PTY);
    assert.equal(h.hellos.length, 2, 'the replacement client says hello, not reattach');
    assert.equal(h.reattaches.length, 0);
    await h.hub.shutdown();
});

test('a provider that now declares another path or another agent is not reattached: its client is replaced', async () => {
    const h = harness({ inventory: [{ ptySessionId: PTY, inputNext: '1', outputLast: '0' }] });
    await ready(h);
    const ended = [];
    h.hub.watch(ROUTE, PTY, { ended: (frame) => ended.push(frame.cause) });
    h.state.path = '/moved-terminals';
    h.transports[0].emit('close');
    await run(h, 400);
    assert.deepEqual(ended, ['shutdown'], 'the ownership of the old worker identity ends');
    assert.equal(h.reattaches.length, 0, 'no reattach to a different identity');
    await h.hub.shutdown();
});

test('after a reattach the worker inventory is authoritative: a PTY it no longer lists ends with a local notice', async () => {
    const h = harness({ inventory: [] });
    await ready(h);
    const ended = [];
    h.hub.watch(ROUTE, PTY, { ended: (frame) => ended.push(frame) });
    h.transports[0].emit('close');
    await run(h, 400);
    await flush();
    assert.deepEqual(ended.map((frame) => [frame.cause, frame.local]), [['unavailable', true]]);
    await h.hub.shutdown();
});

test('an unavailable provider rejects within the bound instead of hanging', async () => {
    const h = harness();
    h.state.plannable = false;
    const pending = ready(h).catch((error) => error);
    await run(h, 5000);
    const error = await pending;
    assert.equal(error.code, 'PROVIDER_TERMINAL_PROVIDER_UNAVAILABLE');
    await h.hub.shutdown();
});

test('graceful hub shutdown ends every session and refuses further use', async () => {
    const h = harness();
    await ready(h);
    const ended = [];
    h.hub.watch(ROUTE, PTY, { ended: (frame) => ended.push(frame.cause) });
    await h.hub.shutdown();
    assert.deepEqual(ended, ['shutdown']);
    await assert.rejects(h.hub.input(ROUTE, PTY, Buffer.from('x')), /closed/);
    assert.equal(h.clock.timers.size, 0, 'no timer survives the shutdown');
});

test('the routing lease predicate reads the routing member of a composite lease and a plain lease alike', () => {
    assert.equal(isRoutingLeaseCurrent({ routing: { isCurrent: () => true }, admin: {} }), true);
    assert.equal(isRoutingLeaseCurrent({ routing: { isCurrent: () => false }, admin: { isCurrent: () => true } }), false);
    assert.equal(isRoutingLeaseCurrent({ isCurrent: () => true }), true);
    assert.equal(isRoutingLeaseCurrent({ routing: {} }), false);
    assert.equal(isRoutingLeaseCurrent(null), false);
});

// ---- launch evidence ----------------------------------------------------

function evidenceHub(user, extra = {}) {
    const minted = [];
    const service = new RouterRequestTokenService({ resolveAgentSecret: () => Buffer.alloc(32, 7) });
    const hub = new ProviderTerminalHub({
        relayManager: {},
        routerServiceTokenService: { mint: async () => 'unused' },
        validateAdmin: extra.validateAdmin || (async () => ({ ok: true, session: { user } })),
        mintRouterRequest: (input) => { minted.push(input); return service.mintWithPayloadSync(input); },
        planEndpoint: () => ({ ok: false }),
        captureLease: () => ({}),
    });
    return { hub, minted };
}

function launchRequest(extra = {}) {
    const launch = fields();
    return {
        targetAgentId: PRINCIPAL, tool: '__provider_terminal_launch__', method: 'LAUNCH', path: PATH,
        rch: terminalLaunchHash(launch), launch, lease: { routing: {}, admin: { userId: 'u1' } }, ...extra,
    };
}

test('launch evidence is a router-request minted from the revalidated administrator, bound to the launch', async () => {
    const { hub, minted } = evidenceHub({ id: 'u1', roles: [' Admin ', 'User', 'admin'] });
    const token = await hub.mintLaunchEvidence(launchRequest());
    const claims = decodeJwtPayloadUnsafe(token);
    assert.equal(claims.typ, 'router-request');
    assert.equal(claims.aud, PRINCIPAL);
    assert.equal(claims.sub, 'user:u1');
    // Lowercased the way the administrator check reads them: `admin` is present
    // because that very check passed, whatever the stored spelling.
    assert.deepEqual(claims.actor, { kind: 'user', id: 'user:u1', roles: ['admin', 'user'] });
    assert.equal(claims.tool, '__provider_terminal_launch__');
    assert.equal(claims.method, 'LAUNCH');
    assert.equal(claims.path, PATH);
    assert.equal(claims.rch, terminalLaunchHash(fields()));
    for (const forbidden of ['caller', 'usr', 'delegation', 'delegations', 'scope', 'originKey']) {
        assert.equal(Object.hasOwn(claims, forbidden), false, forbidden);
    }
    assert.equal(minted.length, 1);
});

test('a stored role spelled Admin signs as admin, and a guest or plain user signs nothing', async () => {
    const { hub } = evidenceHub({ id: 'u1', roles: ['Admin'] });
    assert.deepEqual(decodeJwtPayloadUnsafe(await hub.mintLaunchEvidence(launchRequest())).actor.roles, ['admin']);
    for (const roles of [['ADMIN', 'Guest'], ['administrator'], []]) {
        const refused = evidenceHub({ id: 'u1', roles });
        await assert.rejects(refused.hub.mintLaunchEvidence(launchRequest()), /Provider terminal/, roles.join());
        assert.equal(refused.minted.length, 0);
    }
});

test('no evidence is minted for a non-administrator, a failed revalidation, another user, or a request that does not match', async () => {
    const cases = [
        ['non-admin', evidenceHub({ id: 'u1', roles: ['user'] }), launchRequest()],
        ['guest admin', evidenceHub({ id: 'u1', roles: ['admin', 'guest'] }), launchRequest()],
        ['revalidation failed', evidenceHub({ id: 'u1', roles: ['admin'] }, {
            validateAdmin: async () => ({ ok: false, reason: 'administrator_revoked' }) }), launchRequest()],
        ['other user', evidenceHub({ id: 'u2', roles: ['admin'] }), launchRequest()],
        ['no admin lease', evidenceHub({ id: 'u1', roles: ['admin'] }), launchRequest({ lease: { routing: {} } })],
        ['wrong tool', evidenceHub({ id: 'u1', roles: ['admin'] }), launchRequest({ tool: '__provider_terminal_targets__' })],
        ['wrong method', evidenceHub({ id: 'u1', roles: ['admin'] }), launchRequest({ method: 'POST' })],
        ['rch of another launch', evidenceHub({ id: 'u1', roles: ['admin'] }), launchRequest({ rch: terminalLaunchHash(fields({ cols: 81 })) })],
    ];
    for (const [name, { hub, minted }, request] of cases) {
        await assert.rejects(hub.mintLaunchEvidence(request), /Provider terminal/, name);
        assert.equal(minted.length, 0, `${name}: nothing was minted`);
    }
});

test('a retry re-mints from a fresh revalidation: a demotion between two attempts stops the second', async () => {
    let admin = true;
    const { hub, minted } = evidenceHub({ id: 'u1', roles: ['admin'] }, {
        validateAdmin: async () => (admin
            ? { ok: true, session: { user: { id: 'u1', roles: ['admin'] } } }
            : { ok: false, reason: 'administrator_revoked' }),
    });
    await hub.mintLaunchEvidence(launchRequest());
    admin = false;
    await assert.rejects(hub.mintLaunchEvidence(launchRequest()), /Provider terminal/);
    assert.equal(minted.length, 1);
});
