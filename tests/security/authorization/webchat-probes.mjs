/**
 * Bounded live U6 WebChat controls (plan rev4 "WebChat", r2_decisions_codex.md Q3).
 *
 * userA and userB open the per-user DPU WebChat with identical launch query and
 * tab values. Each user's own stream and marker are the positive controls; B
 * may legitimately reach B's own runtime with A's copied identifiers, but no
 * marker, input or control may cross to A. A 409 is recorded but never counts
 * as isolation evidence. Markers are slash commands, so no model, provider or
 * costly tool runs. Process identities and credential confinement are compared
 * privately and reported as booleans only.
 *
 * Collaborators are injectable so the decision logic is unit-tested offline:
 *   openStream(ctx, actor, path) -> { status, contentType, events(), waitFor(pred, ms), close() }
 *   inspectProcesses(launchValue) -> [{ pid, args, environ }]   (raw values stay private)
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { assertDenied } from './core.mjs';

export const webchatProbe = Object.freeze({
    agent: 'dpuAgent',
    launchKey: 'authz-probe',
    cap: 3,
    waitMs: 15000,
    maxEventBytes: 256 * 1024,
});

const source = 'tests/security/authorization/webchat-probes.mjs runWebchatProbes';
const def = (id, positiveControlAnyOf = null) => ({ id, kind: 'live', boundary: 'U6', source, positiveControlAnyOf });

export function webchatCheckDefinitions() {
    const own = ['userA', 'userB'].map(a => `u6:webchat-own-stream:${a}`);
    const marker = ['userA', 'userB'].map(a => `u6:webchat-own-marker:${a}`);
    return [
        ...own.map(id => def(id)),
        def('u6:webchat-distinct-processes', own),
        ...marker.map(id => def(id, own)),
        def('u6:webchat-marker-isolation:userA-to-userB', marker),
        def('u6:webchat-marker-isolation:userB-to-userA', marker),
        def('u6:webchat-copied-ids-input:userB', marker),
        def('u6:webchat-copied-ids-control:userB', marker),
        def('u6:webchat-copied-ids-interaction:userB', marker),
        def('u6:webchat-own-control:userA', own),
        def('u6:webchat-own-control:userB', own),
        def('u6:webchat-reconnect-same-process:userA', own),
        def('u6:webchat-reserved-keys:userA', own),
        def('u6:webchat-credential-confinement:userA', own),
        ...['anonymous', 'selfRegistered'].flatMap(actor => ['stream', 'input'].map(op => def(`u6:webchat-deny:${actor}:${op}`, ['u6:webchat-own-stream:userA']))),
        def('u6:webchat-cap:userA', own),
        def('u6:webchat-idle-replacement:userA', ['u6:webchat-cap:userA']),
        def('u6:webchat-runtimes-removed', own),
    ];
}

/** Default stream opener: raw SSE over the selected loopback Router with the actor's cookies. */
export async function openEventStream(ctx, actor, requestPath, { maxBytes = webchatProbe.maxEventBytes } = {}) {
    await ctx.guard(); // GET /stream creates runtime state.
    const client = ctx.clients[actor];
    assert.ok(client, `Unknown principal ${actor}`);
    const cookie = client.cookies.map(c => `${c.name}=${c.value}`).join('; ');
    return await new Promise((resolve, reject) => {
        let buffer = '';
        const events = [];
        const waiters = new Set();
        const req = http.request({ hostname: '127.0.0.1', port: 8080, path: requestPath, method: 'GET', headers: { accept: 'text/event-stream', ...(cookie ? { cookie } : {}) } }, res => {
            ctx.report.requests.push({ actor, method: 'GET', path: requestPath.split('?')[0], status: res.statusCode, stream: true });
            const handle = {
                status: res.statusCode,
                contentType: String(res.headers['content-type'] || ''),
                events: () => [...events],
                waitFor(predicate, ms = webchatProbe.waitMs) {
                    const found = events.find(predicate);
                    if (found) return Promise.resolve(found);
                    return new Promise(done => {
                        const waiter = { predicate, done, timer: setTimeout(() => { waiters.delete(waiter); done(null); }, ms) };
                        waiters.add(waiter);
                    });
                },
                close() { res.destroy(); req.destroy(); },
            };
            res.setEncoding('utf8');
            res.on('data', chunk => {
                buffer += chunk;
                if (buffer.length > maxBytes) { handle.close(); return; }
                let index;
                while ((index = buffer.indexOf('\n\n')) >= 0) {
                    const block = buffer.slice(0, index);
                    buffer = buffer.slice(index + 2);
                    const event = { event: 'message', data: '' };
                    for (const line of block.split('\n')) {
                        if (line.startsWith('event:')) event.event = line.slice(6).trim();
                        else if (line.startsWith('data:')) event.data += line.slice(5).trimStart();
                    }
                    if (!event.data && event.event === 'message') continue;
                    events.push(event);
                    for (const waiter of [...waiters]) if (waiter.predicate(event)) { clearTimeout(waiter.timer); waiters.delete(waiter); waiter.done(event); }
                }
            });
            res.on('error', () => {});
            resolve(handle);
        });
        req.setTimeout(webchatProbe.waitMs, () => req.destroy(new Error('Bounded WebChat stream connect timeout')));
        req.on('error', reject);
        req.end();
    });
}

const containsMarker = marker => event => String(event.data).includes(marker);

/**
 * In-Box process inspector: pids whose argv carries the launch value, with
 * argv and environment read privately. An unreadable environment is an error,
 * never an empty (trivially clean) result.
 */
export function boxProcessInspector(boxId, { run = (args) => execFileSync('podman', args, { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }) } = {}) {
    assert.match(String(boxId), /^[a-f0-9]{64}$/);
    return async (value) => {
        const listing = run(['exec', boxId, 'ps', '-eo', 'pid=,args=']);
        const matches = listing.split('\n').map(line => /^\s*(\d+)\s+(.*)$/.exec(line)).filter(Boolean)
            .filter(([, , args]) => args.includes(`${webchatProbe.launchKey}=${value}`) || args.includes(`${webchatProbe.launchKey}=${encodeURIComponent(value)}`))
            .filter(([, , args]) => !/\bps -eo\b/.test(args));
        return matches.map(([, pid, args]) => {
            const environ = run(['exec', boxId, 'cat', `/proc/${pid}/environ`]);
            assert.ok(environ.length > 0, 'Process environment must be readable for confinement checks');
            return { pid: Number(pid), args, environ };
        });
    };
}

export async function runWebchatProbes(ctx, { openStream = openEventStream, inspectProcesses = null, nonce = ctx.prefix, timing = {} } = {}) {
    const { agent, launchKey, cap } = webchatProbe;
    const { waitMs = webchatProbe.waitMs, settleMs = 1000, removalMs = 120000, pollMs = 2000 } = timing;
    const shared = `${nonce}-shared`;
    const tabId = `${nonce}-tab`;
    const query = (value = shared, extra = '') => `agent=${agent}&${launchKey}=${encodeURIComponent(value)}&tabId=${encodeURIComponent(tabId)}${extra}`;
    const streams = [];
    const opened = new Set();
    // Armed before any runtime exists: close every stream this probe opened.
    ctx.cleanup(async () => { for (const s of streams) s.close(); });
    // Every GET /stream creates runtime state, so each one passes the ownership guard first.
    const open = async (actor, value, extra) => {
        await ctx.guard();
        const handle = await openStream(ctx, actor, `/webchat/stream?${query(value, extra)}`);
        streams.push(handle);
        return handle;
    };
    const post = (actor, route, body, value = shared, extra = '') => ctx.request(actor, { method: 'POST', path: `/webchat/${route}?${query(value, extra)}`, body, headers: { 'content-type': 'application/json' } });
    const observe = (entry) => { (ctx.report.webchatObservations ||= []).push(entry); };
    const processes = async (value) => {
        if (!inspectProcesses) throw new Error('Process inspection is unavailable; identity and confinement cannot be asserted');
        return await inspectProcesses(value);
    };

    const own = {};
    for (const actor of ['userA', 'userB']) await ctx.check(`u6:webchat-own-stream:${actor}`, async () => {
        const handle = await open(actor, shared);
        assert.equal(handle.status, 200, 'Own WebChat stream must open');
        assert.ok(handle.contentType.includes('text/event-stream'), 'Own WebChat stream must be an event stream');
        own[actor] = handle;
        opened.add(actor);
    });
    const ownReady = opened.has('userA') && opened.has('userB');
    const gapAll = (ids, reason) => { for (const id of ids) ctx.recordGap(id, reason, { kind: 'positive-unavailable' }); };
    if (!ownReady) {
        gapAll(webchatCheckDefinitions().map(d => d.id).filter(id => !id.startsWith('u6:webchat-own-stream:')), 'Own WebChat streams did not open; isolation cannot be credited.');
        return;
    }

    await ctx.check('u6:webchat-distinct-processes', async () => {
        const list = await processes(shared);
        assert.equal(list.length, 2, 'Identical launch values must yield exactly one private runtime per principal');
        assert.notEqual(list[0].pid, list[1].pid, 'Principals must not share a runtime process');
    });

    const markers = { userA: `/authz-A-${nonce}`, userB: `/authz-B-${nonce}` };
    const markerOk = new Set();
    for (const actor of ['userA', 'userB']) await ctx.check(`u6:webchat-own-marker:${actor}`, async () => {
        const response = await post(actor, 'input', { text: markers[actor] });
        assert.equal(response.status, 204, 'Own input must be accepted');
        const routerEvent = await own[actor].waitFor(e => e.event === 'user-message' && containsMarker(markers[actor])(e), waitMs);
        assert.ok(routerEvent, 'Router user-message event for the own marker is required');
        const reply = await own[actor].waitFor(e => e.event !== 'user-message' && containsMarker(markers[actor].slice(1))(e), waitMs);
        assert.ok(reply, 'DPU unsupported-command reply for the own marker is required (a bare 204 is not enough)');
        markerOk.add(actor);
    });
    const markersReady = markerOk.size === 2;
    if (!markersReady) {
        gapAll(['u6:webchat-marker-isolation:userA-to-userB', 'u6:webchat-marker-isolation:userB-to-userA', 'u6:webchat-copied-ids-input:userB', 'u6:webchat-copied-ids-control:userB', 'u6:webchat-copied-ids-interaction:userB'], 'Own marker positive controls failed; isolation cannot be credited.');
    } else {
        await ctx.check('u6:webchat-marker-isolation:userA-to-userB', async () => {
            assert.equal(own.userB.events().filter(containsMarker(markers.userA)).length, 0, "A's marker reached B's stream");
        });
        await ctx.check('u6:webchat-marker-isolation:userB-to-userA', async () => {
            assert.equal(own.userA.events().filter(containsMarker(markers.userB)).length, 0, "B's marker reached A's stream");
        });
        const copied = `/authz-B-copied-${nonce}`;
        await ctx.check('u6:webchat-copied-ids-input:userB', async () => {
            const before = await processes(shared);
            const response = await post('userB', 'input', { text: copied });
            observe({ step: 'copied-input', status: response.status, conflictOnly: response.status === 409 });
            if (response.status === 204) assert.ok(await own.userB.waitFor(containsMarker(copied), waitMs), "B's copied-ID input must land on B's own stream");
            await new Promise(r => setTimeout(r, settleMs));
            assert.equal(own.userA.events().filter(containsMarker(copied)).length, 0, "B's copied-ID input reached A's stream");
            const after = await processes(shared);
            assert.deepEqual(after.map(p => p.pid).sort(), before.map(p => p.pid).sort(), "A's process identity or liveness changed");
        });
        await ctx.check('u6:webchat-copied-ids-control:userB', async () => {
            const before = await processes(shared);
            const response = await ctx.request('userB', { method: 'POST', path: `/webchat/control?${query()}`, body: '\x1b', headers: { 'content-type': 'text/plain' } });
            observe({ step: 'copied-control', status: response.status, conflictOnly: response.status === 409 });
            const after = await processes(shared);
            assert.deepEqual(after.map(p => p.pid).sort(), before.map(p => p.pid).sort(), "B's control altered A's process");
            const probe = `/authz-A-alive-${nonce}`;
            assert.equal((await post('userA', 'input', { text: probe })).status, 204, 'A must remain responsive after B control');
            assert.ok(await own.userA.waitFor(containsMarker(probe), waitMs), 'A must still receive its own events after B control');
        });
        await ctx.check('u6:webchat-copied-ids-interaction:userB', async () => {
            const response = await ctx.request('userB', { method: 'POST', path: `/webchat/interaction?${query()}`, body: { id: `${nonce}-interaction`, optionId: 'x' } });
            observe({ step: 'copied-interaction', status: response.status, conflictOnly: response.status === 409 });
            assert.ok(response.status !== 200 && response.status !== 204, 'A copied interaction must not resolve anything');
            assert.equal(own.userA.events().filter(e => e.event === 'interaction-resolved').length, 0, "B's interaction resolved something on A's stream");
        });
    }

    for (const actor of ['userA', 'userB']) await ctx.check(`u6:webchat-own-control:${actor}`, async () => {
        const marker = `/authz-control-${actor}-${nonce}`;
        const response = await ctx.request(actor, { method: 'POST', path: `/webchat/control?${query()}`, body: `${marker}\n`, headers: { 'content-type': 'text/plain' } });
        assert.equal(response.status, 204);
        assert.ok(await own[actor].waitFor(containsMarker(marker.slice(1)), waitMs), 'A harmless control line must produce a process response; a bare 204 is not enough');
        const other = actor === 'userA' ? 'userB' : 'userA';
        assert.equal(own[other].events().filter(containsMarker(marker.slice(1))).length, 0, 'Control output crossed principals');
    });

    await ctx.check('u6:webchat-reconnect-same-process:userA', async () => {
        const before = await processes(shared);
        own.userA.close();
        const again = await open('userA', shared);
        assert.equal(again.status, 200);
        own.userA = again;
        const after = await processes(shared);
        assert.deepEqual(after.map(p => p.pid).sort(), before.map(p => p.pid).sort(), 'Same-user reconnect must attach to the same process');
    });

    await ctx.check('u6:webchat-reserved-keys:userA', async () => {
        const forged = `${nonce}-forged`;
        const extra = `&webchat-runtime-scope=${encodeURIComponent(ctx.principals.userB.id)}&sso-user=${encodeURIComponent(ctx.principals.userB.id)}`;
        const handle = await open('userA', forged, extra);
        assert.ok([200, 400, 403].includes(handle.status), 'Reserved keys must be rejected or ignored');
        if (handle.status === 200) {
            const list = await processes(forged);
            assert.equal(list.length, 1, 'One runtime for the forged-key request');
            const leaked = list.some(p => String(p.args).includes(ctx.principals.userB.id) || String(p.environ).includes(ctx.principals.userB.id) || /webchat-runtime-scope|--sso-/.test(String(p.args)));
            observe({ step: 'reserved-keys', forgedScopePresent: leaked });
            assert.equal(leaked, false, 'Reserved runtime-scope or user keys reached the agent process');
        }
        handle.close();
    });

    await ctx.check('u6:webchat-credential-confinement:userA', async () => {
        const list = await processes(shared);
        const secrets = [...ctx.secrets].filter(s => typeof s === 'string' && s.length >= 12);
        const present = list.some(p => secrets.some(s => String(p.args).includes(s) || String(p.environ).includes(s)));
        observe({ step: 'credential-confinement', browserCredentialPresent: present });
        assert.equal(present, false, 'A browser credential reached a WebChat process');
    });

    for (const actor of ['anonymous', 'selfRegistered']) {
        await ctx.check(`u6:webchat-deny:${actor}:stream`, async () => {
            await ctx.guard();
            const response = await ctx.request(actor, { path: `/webchat/stream?${query()}`, headers: { accept: 'application/json' }, stream: true });
            assert.notEqual(response.status, 409, 'A 409 is not isolation evidence');
            assertDenied(response);
        });
        await ctx.check(`u6:webchat-deny:${actor}:input`, async () => {
            const response = await post(actor, 'input', { text: `/authz-deny-${nonce}` });
            assert.notEqual(response.status, 409, 'A 409 is not isolation evidence');
            assertDenied(response);
            assert.equal(own.userA.events().filter(containsMarker(`authz-deny-${nonce}`)).length, 0);
        });
    }

    const slots = [];
    let capped = false;
    await ctx.check('u6:webchat-cap:userA', async () => {
        // The shared runtime is one of A's three; two more connected runtimes reach the bound.
        for (let i = 1; i < cap; i++) {
            const handle = await open('userA', `${nonce}-slot-${i}`);
            assert.equal(handle.status, 200, `Owned runtime ${i + 1} must open`);
            slots.push(handle);
        }
        const fourth = await open('userA', `${nonce}-slot-${cap}`);
        assert.equal(fourth.status, 429, 'The fourth connected runtime must be refused with 429');
        fourth.close();
        capped = true;
    });
    await ctx.check('u6:webchat-idle-replacement:userA', async () => {
        assert.ok(capped, 'Cap control is required');
        const bBefore = await processes(shared);
        slots[0].close();
        await new Promise(r => setTimeout(r, settleMs));
        const replacement = await open('userA', `${nonce}-slot-replacement`);
        assert.equal(replacement.status, 200, 'An idle runtime must be replaced');
        slots.push(replacement);
        const bAfter = await processes(shared);
        assert.ok(bAfter.length >= 1 && bBefore.every(p => bAfter.some(q => q.pid === p.pid)), "The idle replacement must not touch B's runtime");
        const probe = `/authz-B-after-cap-${nonce}`;
        assert.equal((await post('userB', 'input', { text: probe })).status, 204);
        assert.ok(await own.userB.waitFor(containsMarker(probe), waitMs), 'B must remain intact');
    });

    await ctx.check('u6:webchat-runtimes-removed', async () => {
        for (const s of streams) s.close();
        const deadline = Date.now() + removalMs;
        let remaining;
        do {
            remaining = (await processes(nonce)).length;
            if (!remaining) break;
            await new Promise(r => setTimeout(r, pollMs));
        } while (Date.now() < deadline);
        assert.equal(remaining, 0, 'Every test-owned WebChat runtime must be removed');
    });
}
