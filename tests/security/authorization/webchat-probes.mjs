/**
 * Bounded live U6 WebChat controls (plan rev4 "WebChat", r2_decisions_codex.md
 * Q3, r2b_review_codex.md).
 *
 * userA and userB open the per-user DPU WebChat with identical launch query and
 * tab values. Each user's own stream, unique Router user-message marker and a
 * fresh real DPU acknowledgement are the positive controls. The pinned DPU
 * answers every visible unsupported slash command with the generic line
 * DPU_UNSUPPORTED_REPLY (AchillesIDE dpuAgent/src/index.mjs:250-263) and never
 * echoes the marker, so an acknowledgement is attributed by stream and by
 * freshness (a new reply on the acting stream after the request, none on the
 * other stream). B may reach B's own runtime with A's copied identifiers, but
 * then B's operation must be acknowledged on B's stream and nothing may change
 * on A. Unavailable (503), conflict (409), malformed (400) and missing-resource
 * outcomes never supply isolation evidence. No pending interaction can be
 * created without inference in the pinned DPU flow, so live interaction
 * isolation is recorded as an explicit limitation and proven by the
 * actual-module offline fixture (webchat-interaction-isolation.test.mjs).
 * Process identity is the DPU node process inside the pinned DPU container,
 * attributed to a principal by its router-issued --sso-user-id and identified
 * by pid plus kernel start time; raw argv/environment stay private.
 *
 * Collaborators are injectable so the decision logic is unit-tested offline:
 *   openStream(ctx, actor, path) -> { status, contentType, events(), close() }
 *   inspectProcesses(launchValue, { prefix }) -> [{ pid, start, ssoUserId, args, environ }]
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
    dpuEntry: Object.freeze(['node', '/code/src/index.mjs']), // AchillesIDE dpuAgent/manifest.json:25 "cli"
});
export const DPU_UNSUPPORTED_REPLY = 'This command is not supported by DPU Research.\n';
export const LIVE_INTERACTION_LIMITATION = Object.freeze({
    id: 'u6:webchat-interaction',
    reason: 'The pinned DPU WebChat creates pending interactions only during planning/tool approval, which requires inference; no harmless live pending interaction exists. Owner-positive and cross-user interaction isolation are mandatory offline evidence instead.',
    offlineEvidence: 'tests/security/authorization/webchat-interaction-isolation.test.mjs',
});

const source = 'tests/security/authorization/webchat-probes.mjs runWebchatProbes';
const def = (id, positiveControlAnyOf = null) => ({ id, kind: 'live', boundary: 'U6', source, positiveControlAnyOf });

export function webchatCheckDefinitions() {
    const own = ['userA', 'userB'].map(a => `u6:webchat-own-stream:${a}`);
    const marker = ['userA', 'userB'].map(a => `u6:webchat-own-marker:${a}`);
    const control = ['userA', 'userB'].map(a => `u6:webchat-own-control:${a}`);
    return [
        ...own.map(id => def(id)),
        def('u6:webchat-distinct-processes', own),
        ...marker.map(id => def(id, own)),
        def('u6:webchat-marker-isolation:userA-to-userB', marker),
        def('u6:webchat-marker-isolation:userB-to-userA', marker),
        ...control.map(id => def(id, own)),
        def('u6:webchat-copied-ids-input:userB', ['u6:webchat-own-marker:userB']),
        def('u6:webchat-copied-ids-control:userB', ['u6:webchat-own-control:userB']),
        def('u6:webchat-reconnect-same-process:userA', own),
        def('u6:webchat-reserved-keys:userA', own),
        def('u6:webchat-credential-confinement', own),
        ...['anonymous', 'selfRegistered'].flatMap(actor => ['stream', 'input'].map(op => def(`u6:webchat-deny:${actor}:${op}`, ['u6:webchat-own-marker:userA']))),
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

const parseData = (data) => { try { return JSON.parse(data); } catch { return undefined; } };
export const isDpuAck = event => event.event === 'message' && parseData(event.data) === DPU_UNSUPPORTED_REPLY;
export const isUserMessage = marker => event => event.event === 'user-message' && parseData(event.data)?.message?.text === marker;
const count = (handle, predicate) => handle.events().filter(predicate).length;
/**
 * Acknowledgements on one stream: occurrences of the exact DPU reply in the
 * in-order concatenation of that stream's plain output events, so a reply split
 * across SSE frames still counts once. Freshness compares counts before and
 * after a request; other streams are counted independently.
 */
export function ackCount(handle) {
    const text = handle.events().filter(e => e.event === 'message').map(e => parseData(e.data)).filter(v => typeof v === 'string').join('');
    let n = 0;
    for (let i = text.indexOf(DPU_UNSUPPORTED_REPLY); i >= 0; i = text.indexOf(DPU_UNSUPPORTED_REPLY, i + DPU_UNSUPPORTED_REPLY.length)) n++;
    return n;
}

async function waitForCount(handle, predicate, minimum, ms) {
    const measure = typeof predicate === 'function' && predicate.length === 0 ? predicate : () => count(handle, predicate);
    const deadline = Date.now() + ms;
    while (measure() < minimum) {
        if (Date.now() >= deadline) return false;
        await new Promise(r => setTimeout(r, Math.min(50, ms)));
    }
    return true;
}

/** Split a NUL-free argv dump (unit-separator joined) into tokens. */
function argvOf(dump) { return String(dump).split('\x1f').filter(Boolean); }

/**
 * In-Box inspector for the pinned DPU runtime: lists processes inside the DPU
 * agent container only, selects exactly the DPU entry (argv[0] node,
 * argv[1] /code/src/index.mjs) so shell and podman-exec wrappers never count,
 * matches the launch value on the --authz-probe flag exactly (or by prefix for
 * removal), and returns pid, kernel start time (/proc/<pid>/stat field 22) and
 * the router-issued --sso-user-id. An unreadable environment is an error.
 */
export function dpuProcessInspector({ boxId, container, run = (args) => execFileSync('podman', args, { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }) }) {
    assert.match(String(boxId), /^[a-f0-9]{64}$/, 'Pinned Box id required');
    assert.match(String(container), /^ploinky_AchillesIDE_dpuAgent_[A-Za-z0-9_.-]+$/, 'Captured DPU container name required');
    const inContainer = (...cmd) => run(['exec', boxId, 'podman', 'exec', container, ...cmd]);
    const listing = 'for d in /proc/[0-9]*; do [ -r "$d/cmdline" ] || continue; printf "%s\\t%s\\t" "${d#/proc/}" "$(cut -d" " -f22 "$d/stat" 2>/dev/null)"; tr "\\000" "\\037" < "$d/cmdline"; printf "\\n"; done';
    return async (value, { prefix = false } = {}) => {
        const rows = inContainer('sh', '-c', listing).split('\n').map(line => line.split('\t')).filter(parts => parts.length === 3);
        const flag = `--${webchatProbe.launchKey}=`;
        return rows.map(([pid, start, dump]) => ({ pid: Number(pid), start: String(start).trim(), argv: argvOf(dump) }))
            .filter(p => Number.isInteger(p.pid) && p.start && p.argv[0]?.split('/').pop() === webchatProbe.dpuEntry[0] && p.argv[1] === webchatProbe.dpuEntry[1])
            .filter(p => p.argv.some(a => a.startsWith(flag) && (prefix ? a.slice(flag.length).startsWith(value) : a.slice(flag.length) === value)))
            .map(p => {
                const environ = inContainer('cat', `/proc/${p.pid}/environ`);
                assert.ok(environ.length > 0, 'Process environment must be readable for confinement checks');
                const ids = p.argv.filter(a => a.startsWith('--sso-user-id=')).map(a => a.slice('--sso-user-id='.length));
                return { pid: p.pid, start: p.start, ssoUserId: ids.length === 1 ? ids[0] : null, args: p.argv.join(' '), environ };
            });
    };
}

const identity = p => `${p.pid}@${p.start}`;

export async function runWebchatProbes(ctx, { openStream = openEventStream, inspectProcesses = null, nonce = ctx.prefix, timing = {} } = {}) {
    const { agent, launchKey, cap } = webchatProbe;
    const { waitMs = webchatProbe.waitMs, settleMs = 1000, removalMs = 120000, pollMs = 2000 } = timing;
    const shared = `${nonce}-shared`;
    const tabId = `${nonce}-tab`;
    const query = (value = shared, extra = '') => `agent=${agent}&${launchKey}=${encodeURIComponent(value)}&tabId=${encodeURIComponent(tabId)}${extra}`;
    const streams = [];
    const observe = (entry) => { (ctx.report.webchatObservations ||= []).push(entry); };
    (ctx.report.liveLimitations ||= []).push({ ...LIVE_INTERACTION_LIMITATION });
    const processes = async (value, options) => {
        if (!inspectProcesses) throw new Error('Process inspection is unavailable; identity and confinement cannot be asserted');
        return await inspectProcesses(value, options);
    };
    const principalOf = p => Object.entries(ctx.principals).find(([, principal]) => principal?.id && principal.id === p.ssoUserId)?.[0] || null;
    const owned = async (value = shared) => {
        const list = await processes(value);
        const byPrincipal = {};
        for (const p of list) {
            const who = principalOf(p);
            assert.ok(who === 'userA' || who === 'userB', 'A matching DPU process is not attributed to a test principal');
            assert.ok(!byPrincipal[who], `More than one DPU process for ${who}`);
            byPrincipal[who] = p;
        }
        return byPrincipal;
    };
    const waitRemoved = async () => {
        const deadline = Date.now() + removalMs;
        let remaining;
        do {
            remaining = (await processes(nonce, { prefix: true })).length;
            if (!remaining) return 0;
            await new Promise(r => setTimeout(r, pollMs));
        } while (Date.now() < deadline);
        return remaining;
    };
    // Armed before any runtime exists, so failure paths are verified too:
    // close every owned stream, then require every test-owned runtime gone.
    ctx.cleanup(async () => {
        for (const s of streams) s.close();
        assert.equal(await waitRemoved(), 0, 'Test-owned WebChat runtimes remained after cleanup');
    });
    // Every GET /stream creates runtime state, so each one passes the ownership guard first.
    const open = async (actor, value, extra) => {
        await ctx.guard();
        const handle = await openStream(ctx, actor, `/webchat/stream?${query(value, extra)}`);
        streams.push(handle);
        return handle;
    };
    const envelope = text => ({ text, presentation: { visible: true } });
    const post = (actor, route, body, value = shared) => ctx.request(actor, { method: 'POST', path: `/webchat/${route}?${query(value)}`, body, headers: { 'content-type': 'application/json' } });

    const own = {};
    for (const actor of ['userA', 'userB']) await ctx.check(`u6:webchat-own-stream:${actor}`, async () => {
        const handle = await open(actor, shared);
        assert.equal(handle.status, 200, 'Own WebChat stream must open');
        assert.ok(handle.contentType.includes('text/event-stream'), 'Own WebChat stream must be an event stream');
        own[actor] = handle;
    });
    if (!own.userA || !own.userB) {
        for (const id of webchatCheckDefinitions().map(d => d.id).filter(id => !id.startsWith('u6:webchat-own-stream:'))) ctx.recordGap(id, 'Own WebChat streams did not open; isolation cannot be credited.', { kind: 'positive-unavailable' });
        return;
    }
    const other = actor => actor === 'userA' ? 'userB' : 'userA';

    let identities = {};
    await ctx.check('u6:webchat-distinct-processes', async () => {
        const byPrincipal = await owned();
        assert.ok(byPrincipal.userA && byPrincipal.userB, 'Each principal needs its own attributed DPU process');
        assert.notEqual(identity(byPrincipal.userA), identity(byPrincipal.userB));
        identities = { userA: identity(byPrincipal.userA), userB: identity(byPrincipal.userB) };
    });

    /** Run one operation and require a fresh DPU acknowledgement on `actor` only. */
    const acknowledged = async (actor, send, { marker = null } = {}) => {
        const before = { userA: ackCount(own.userA), userB: ackCount(own.userB) };
        const response = await send();
        assert.equal(response.status, 204, `Operation must be accepted (HTTP ${response.status} is not evidence)`);
        if (marker) assert.ok(await waitForCount(own[actor], isUserMessage(marker), 1, waitMs), 'Router user-message event for the unique marker is required on the acting stream');
        assert.ok(await waitForCount(own[actor], () => ackCount(own[actor]), before[actor] + 1, waitMs), 'A fresh DPU acknowledgement is required on the acting stream (a bare 204 is not enough)');
        await new Promise(r => setTimeout(r, settleMs));
        assert.equal(ackCount(own[other(actor)]), before[other(actor)], 'An acknowledgement appeared on the other principal\'s stream');
    };

    const markers = { userA: `/authz-A-${nonce}`, userB: `/authz-B-${nonce}` };
    const markerOk = new Set();
    for (const actor of ['userA', 'userB']) await ctx.check(`u6:webchat-own-marker:${actor}`, async () => {
        await acknowledged(actor, () => post(actor, 'input', envelope(markers[actor])), { marker: markers[actor] });
        markerOk.add(actor);
    });
    for (const [from, to] of [['userA', 'userB'], ['userB', 'userA']]) await ctx.check(`u6:webchat-marker-isolation:${from}-to-${to}`, async () => {
        assert.ok(markerOk.has(from) && markerOk.has(to), 'Both own-marker positives are required');
        assert.equal(count(own[to], isUserMessage(markers[from])), 0, `${from}'s marker reached ${to}'s stream`);
        assert.ok(!own[to].events().some(e => String(e.data).includes(markers[from])), `${from}'s marker text reached ${to}'s stream`);
    });

    const controlOk = new Set();
    for (const actor of ['userA', 'userB']) await ctx.check(`u6:webchat-own-control:${actor}`, async () => {
        const line = `${JSON.stringify(envelope(`/authz-control-${actor}-${nonce}`))}\n`;
        await acknowledged(actor, () => ctx.request(actor, { method: 'POST', path: `/webchat/control?${query()}`, body: line, headers: { 'content-type': 'text/plain' } }));
        controlOk.add(actor);
    });

    // B replays A's copied launch query and tab id. These resolve B's own
    // principal runtime; the operation must be acknowledged on B and leave A untouched.
    const unchangedA = async () => {
        const now = await owned();
        assert.ok(now.userA, "A's process disappeared");
        assert.equal(identity(now.userA), identities.userA, "A's process identity changed");
    };
    await ctx.check('u6:webchat-copied-ids-input:userB', async () => {
        assert.ok(markerOk.has('userB') && identities.userA, 'B own-marker positive and A identity are required');
        const copied = `/authz-B-copied-${nonce}`;
        await acknowledged('userB', () => post('userB', 'input', envelope(copied)), { marker: copied });
        assert.equal(count(own.userA, isUserMessage(copied)), 0, "B's copied-ID input reached A's stream");
        await unchangedA();
    });
    await ctx.check('u6:webchat-copied-ids-control:userB', async () => {
        assert.ok(controlOk.has('userB') && identities.userA, 'B own-control positive and A identity are required');
        const line = `${JSON.stringify(envelope(`/authz-B-copied-control-${nonce}`))}\n`;
        await acknowledged('userB', () => ctx.request('userB', { method: 'POST', path: `/webchat/control?${query()}`, body: line, headers: { 'content-type': 'text/plain' } }));
        await unchangedA();
        await acknowledged('userA', () => post('userA', 'input', envelope(`/authz-A-alive-${nonce}`)), { marker: `/authz-A-alive-${nonce}` });
    });

    await ctx.check('u6:webchat-reconnect-same-process:userA', async () => {
        assert.ok(identities.userA, 'A identity is required');
        own.userA.close();
        const again = await open('userA', shared);
        assert.equal(again.status, 200);
        own.userA = again;
        await unchangedA();
    });

    await ctx.check('u6:webchat-reserved-keys:userA', async () => {
        const forged = `${nonce}-forged`;
        const bId = ctx.principals.userB.id;
        const extra = `&webchat-runtime-scope=${encodeURIComponent(bId)}&sso-user-id=${encodeURIComponent(bId)}&sso-user=${encodeURIComponent(bId)}`;
        const handle = await open('userA', forged, extra);
        try {
            if (handle.status !== 200) { observe({ step: 'reserved-keys', rejected: true, status: handle.status }); assert.fail(`Reserved keys must be ignored by the pinned Router (HTTP ${handle.status})`); }
            const list = await processes(forged);
            assert.equal(list.length, 1, 'Exactly one DPU process for the forged-key request');
            const [p] = list;
            const legitimate = p.ssoUserId === ctx.principals.userA.id;
            const forgedPresent = String(p.args).includes(bId) || String(p.environ).includes(bId) || /(^| )--webchat-runtime-scope(=| |$)/.test(String(p.args));
            observe({ step: 'reserved-keys', legitimateIdentity: legitimate, forgedValuePresent: forgedPresent });
            assert.equal(legitimate, true, "The process must carry A's router-issued identity");
            assert.equal(forgedPresent, false, "B's identity or a query-selected runtime scope reached A's process");
        } finally { handle.close(); }
    });

    await ctx.check('u6:webchat-credential-confinement', async () => {
        const byPrincipal = await owned();
        const list = [byPrincipal.userA, byPrincipal.userB];
        assert.ok(list.every(Boolean), 'Both attributed DPU processes are required; an empty list proves nothing');
        const secrets = [...ctx.secrets].filter(s => typeof s === 'string' && s.length >= 12);
        const present = list.some(p => secrets.some(s => String(p.args).includes(s) || String(p.environ).includes(s)));
        const crossed = String(byPrincipal.userA.args + byPrincipal.userA.environ).includes(ctx.principals.userB.id)
            || String(byPrincipal.userB.args + byPrincipal.userB.environ).includes(ctx.principals.userA.id);
        observe({ step: 'credential-confinement', processes: list.length, browserCredentialPresent: present, crossPrincipalIdentityPresent: crossed });
        assert.equal(present, false, 'A browser credential reached a WebChat process');
        assert.equal(crossed, false, "One principal's identity reached the other principal's process");
    });

    for (const actor of ['anonymous', 'selfRegistered']) {
        await ctx.check(`u6:webchat-deny:${actor}:stream`, async () => {
            await ctx.guard();
            const response = await ctx.request(actor, { path: `/webchat/stream?${query()}`, headers: { accept: 'application/json' }, stream: true });
            assertDenied(response);
        });
        await ctx.check(`u6:webchat-deny:${actor}:input`, async () => {
            const response = await post(actor, 'input', envelope(`/authz-deny-${nonce}`));
            assertDenied(response);
            assert.ok(!own.userA.events().some(e => String(e.data).includes(`authz-deny-${nonce}`)));
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
        assert.ok(capped && identities.userB, 'Cap control and B identity are required');
        slots[0].close();
        await new Promise(r => setTimeout(r, settleMs));
        const replacement = await open('userA', `${nonce}-slot-replacement`);
        assert.equal(replacement.status, 200, 'An idle runtime must be replaced');
        slots.push(replacement);
        const now = await owned();
        assert.equal(now.userB && identity(now.userB), identities.userB, "The idle replacement touched B's runtime");
        await acknowledged('userB', () => post('userB', 'input', envelope(`/authz-B-after-cap-${nonce}`)), { marker: `/authz-B-after-cap-${nonce}` });
    });

    await ctx.check('u6:webchat-runtimes-removed', async () => {
        for (const s of streams) s.close();
        assert.equal(await waitRemoved(), 0, 'Every test-owned WebChat runtime must be removed');
    });
}
