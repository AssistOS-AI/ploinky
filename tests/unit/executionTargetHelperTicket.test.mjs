import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
    TICKET_MAX_LIFETIME_SECONDS,
    createTargetHelperCallerAuthority,
    createTargetHelperTicketMinter,
} from '../../cli/server/security/tokens/targetHelperTicketMinter.mjs';
import { digestOrThrow } from '../../cli/server/executionTarget/contract.mjs';

// executionTarget helper-ticket contract (frozen T0 section 8 + A1.7). The reference verifier below re-states the worker
// validateHelperTicketClaims check order and codes from the contract text; it imports no Explorer code.

const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
const id = (byte) => Buffer.alloc(16, byte).toString('base64url');
const nonce = (byte) => Buffer.alloc(32, byte).toString('base64url');
const digest = (char) => char.repeat(64);

// Independent canonical JSON for plain JSON values (sorted keys, no whitespace).
function canon(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canon(value[key])}`).join(',')}}`;
}

const SECRET = crypto.createHash('sha256').update('synthetic-test-secret-not-real').digest();
const OTHER_SECRET = crypto.createHash('sha256').update('another-synthetic-secret').digest();
const KID = 'kid-helper-1';
const LIVE = { workspaceId: 'ws-1', boxIdentity: 'box-1', boxGeneration: 'gen-1' };
const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);

function scope(overrides = {}) {
    return {
        ...LIVE,
        workerPrincipal: 'agent:robo/worker', workerRuntimeInstanceId: 'winst-1', workerEnableGeneration: 'wgen-1', workerGeneration: id(1),
        agentPrincipal: 'agent:repoa/alpha', containerId: 'a'.repeat(64), runtimeInstanceId: 'inst-1', enableGeneration: 'egen-1',
        helperIncarnation: id(2), ...overrides,
    };
}

function binding(scopeOverrides = {}) {
    return { version: 1, scope: scope(scopeOverrides), limitsDigest: digest('9'), robotId: id(3), executionId: id(4), attemptId: id(5), configRevision: 1 };
}

function entryFor(sc) {
    return {
        workspaceId: sc.workspaceId, boxIdentity: sc.boxIdentity, boxGeneration: sc.boxGeneration, principal: sc.agentPrincipal,
        containerId: sc.containerId, runtimeInstanceId: sc.runtimeInstanceId, enableGeneration: sc.enableGeneration,
        helperIncarnation: sc.helperIncarnation, enabled: true, running: true, runtime: 'container', placement: 'global',
    };
}

const WORKER = { principal: 'agent:robo/worker', runtimeInstanceId: 'winst-1', enableGeneration: 'wgen-1', generation: id(1) };

function makeMinter({ now = () => NOW, readTarget = (sc) => entryFor(sc), secrets, capacity, worker = WORKER, authority = createTargetHelperCallerAuthority() } = {}) {
    const seen = [];
    const provider = secrets ?? {
        useSecret(target, fn) { seen.push(target); return fn(KID, Buffer.from(SECRET)); },
    };
    const raw = createTargetHelperTicketMinter({
        live: LIVE, readTarget, readWorker: () => worker, callerAuthority: authority, secrets: provider, now, issuedCapacity: capacity,
        randomBytes: (n) => crypto.randomBytes(n),
    });
    const defaultContext = authority.issue(WORKER);
    const minter = { mint: (req, context = defaultContext) => raw.mint(context, req) };
    return { minter, seen, authority, raw };
}

function request(overrides = {}) {
    return {
        binding: binding(), reservationId: id(6), operationId: id(7), requestDigest: digest('7'),
        helperNonce: nonce(8), channelEpoch: '1', previousChannelEpoch: null, permissions: ['commit', 'prepare'], ttlSeconds: 30,
        ...overrides,
    };
}

// ---- reference verifier (contract restatement) ----
function reference(token, options) {
    const fail = (code) => ({ ok: false, code });
    if (typeof token !== 'string' || token.length === 0 || token.length > 65536) return fail('ticket_format');
    const parts = token.split('.');
    if (parts.length !== 3) return fail('ticket_format');
    const seg = (s) => (/^[A-Za-z0-9_-]+$/.test(s) && Buffer.from(s, 'base64url').toString('base64url') === s ? Buffer.from(s, 'base64url') : null);
    const hb = seg(parts[0]);
    if (!hb) return fail('ticket_format');
    let header;
    try { header = JSON.parse(hb.toString('utf8')); } catch { return fail('ticket_format'); }
    if (canon(header) !== hb.toString('utf8')) return fail('noncanonical_encoding');
    if (header.alg !== 'HS256') return fail('ticket_algorithm');
    if (header.typ !== 'ploinky-target-helper+jwt') return fail('ticket_purpose');
    if (Object.keys(header).sort().join() !== 'alg,kid,typ') return fail('ticket_format');
    if (header.kid !== options.kid) return fail('ticket_signature');
    const sig = seg(parts[2]);
    const mac = crypto.createHmac('sha256', options.secret).update(`${parts[0]}.${parts[1]}`).digest();
    if (!sig || sig.length !== mac.length || !crypto.timingSafeEqual(sig, mac)) return fail('ticket_signature');
    const pb = seg(parts[1]);
    if (!pb) return fail('ticket_format');
    let claims;
    try { claims = JSON.parse(pb.toString('utf8')); } catch { return fail('ticket_format'); }
    if (canon(claims) !== pb.toString('utf8')) return fail('noncanonical_encoding');
    if (claims.version !== 1) return fail('unsupported_version');
    const keys = ['version', 'iss', 'sub', 'purpose', 'aud', 'binding', 'reservationId', 'operationId', 'requestDigest', 'helperNonce', 'jti',
        'iat', 'exp', 'channelEpoch', 'previousChannelEpoch', 'permissions', 'limitsDigest'];
    if (Object.keys(claims).length !== keys.length || !keys.every((key) => Object.hasOwn(claims, key))) return fail('ticket_format');
    if (claims.iss !== 'ploinky-router' || claims.purpose !== 'ploinky.target-helper.v1') return fail('ticket_purpose');
    if (!(claims.exp > claims.iat && claims.exp - claims.iat <= 30)) return fail('ticket_lifetime');
    if (claims.iat * 1000 > options.nowMs + 2000 || options.nowMs >= claims.exp * 1000) return fail('ticket_lifetime');
    const nonce32 = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v) && Buffer.from(v, 'base64url').length === 32;
    if (!nonce32(claims.jti) || !nonce32(claims.helperNonce)) return fail('ticket_format');
    const allowed = ['commit', 'connect', 'input', 'lookup', 'prepare', 'release', 'renew', 'stop'];
    if (!Array.isArray(claims.permissions) || claims.permissions.length === 0
        || !claims.permissions.every((p, i) => allowed.includes(p) && (i === 0 || claims.permissions[i - 1] < p))) return fail('ticket_format');
    const sc = options.binding.scope;
    const target = { workspaceId: sc.workspaceId, boxIdentity: sc.boxIdentity, boxGeneration: sc.boxGeneration, agentPrincipal: sc.agentPrincipal,
        containerId: sc.containerId, runtimeInstanceId: sc.runtimeInstanceId, enableGeneration: sc.enableGeneration, helperIncarnation: sc.helperIncarnation };
    if (claims.aud !== `ploinky:target-helper:${crypto.createHash('sha256').update(canon(target)).digest('hex')}`) return fail('ticket_binding');
    if (canon(claims.binding) !== canon(options.binding)) return fail('ticket_binding');
    if (claims.sub !== sc.workerPrincipal || claims.limitsDigest !== options.binding.limitsDigest) return fail('ticket_binding');
    const e = options.expected;
    if (claims.reservationId !== e.reservationId || claims.operationId !== e.operationId || claims.requestDigest !== e.requestDigest
        || claims.helperNonce !== e.helperNonce) return fail('ticket_binding');
    if (options.channel.leaseState !== 'active') return fail('lease_retired');
    if (options.channel.currentEpoch === null) {
        if (claims.channelEpoch !== '1' || claims.previousChannelEpoch !== null) return fail('channel_epoch_conflict');
    } else if (claims.previousChannelEpoch !== options.channel.currentEpoch
        || claims.channelEpoch !== String(BigInt(options.channel.currentEpoch) + 1n)) return fail('channel_epoch_conflict');
    for (const k of [`jti:${claims.jti}`, `challenge:${options.challenge.id}`]) {
        const until = options.replay.get(k);
        if (until !== undefined && until > options.nowMs) return fail('ticket_replayed');
    }
    for (const k of [`jti:${claims.jti}`, `challenge:${options.challenge.id}`]) options.replay.set(k, claims.exp * 1000 + 2000);
    return { ok: true, claims };
}

let challengeCounter = 0;
function verifyOptions(req, overrides = {}) {
    challengeCounter += 1;
    return {
        secret: SECRET, kid: KID, binding: req.binding,
        expected: { reservationId: req.reservationId, operationId: req.operationId, requestDigest: req.requestDigest, helperNonce: req.helperNonce },
        channel: { currentEpoch: null, leaseState: 'active' }, challenge: { id: `c-${challengeCounter}` }, nowMs: NOW + 1000,
        replay: new Map(), ...overrides,
    };
}

// Forge with the real key to isolate each verifier check from the minter's own refusals.
function forge(claimsOverride, { secret = SECRET, header = { alg: 'HS256', typ: 'ploinky-target-helper+jwt', kid: KID } } = {}) {
    const { minter } = makeMinter();
    const minted = minter.mint(request());
    const claims = JSON.parse(Buffer.from(minted.value.ticket.split('.')[1], 'base64url').toString('utf8'));
    Object.assign(claims, claimsOverride);
    const h = b64(Buffer.from(canon(header)));
    const p = b64(Buffer.from(canon(claims)));
    return `${h}.${p}.${b64(crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest())}`;
}

test('P4 a minted ticket passes the contract verifier with the frozen header, claims and lifetime', () => {
    const { minter, seen } = makeMinter();
    const req = request();
    const minted = minter.mint(req);
    assert.equal(minted.ok, true);
    const result = reference(minted.value.ticket, verifyOptions(req));
    assert.deepEqual(result.ok, true, result.code);
    const claims = result.claims;
    assert.equal(claims.iss, 'ploinky-router');
    assert.equal(claims.purpose, 'ploinky.target-helper.v1');
    assert.equal(claims.sub, 'agent:robo/worker');
    assert.equal(claims.exp - claims.iat, 30);
    assert.equal(claims.iat, Math.floor(NOW / 1000));
    assert.deepEqual(claims.permissions, ['commit', 'prepare']);
    assert.equal(claims.limitsDigest, req.binding.limitsDigest);
    assert.equal(Buffer.from(claims.jti, 'base64url').length, 32);
    const sc = req.binding.scope;
    assert.equal(claims.aud, `ploinky:target-helper:${digestOrThrow({
        workspaceId: sc.workspaceId, boxIdentity: sc.boxIdentity, boxGeneration: sc.boxGeneration, agentPrincipal: sc.agentPrincipal,
        containerId: sc.containerId, runtimeInstanceId: sc.runtimeInstanceId, enableGeneration: sc.enableGeneration, helperIncarnation: sc.helperIncarnation,
    })}`);
    const header = JSON.parse(Buffer.from(minted.value.ticket.split('.')[0], 'base64url').toString('utf8'));
    assert.deepEqual(header, { alg: 'HS256', typ: 'ploinky-target-helper+jwt', kid: KID });
    // The provider is asked for exactly the target identity (workspace/Box, container, helper incarnation).
    assert.equal(seen.length, 1);
    assert.equal(seen[0].helperIncarnation, sc.helperIncarnation);
    assert.equal(seen[0].containerId, sc.containerId);
    assert.equal(seen[0].workspaceId, 'ws-1');
});

test('P4 reattach ticket binds previous+1 epoch; stale CAS is a channel_epoch_conflict', () => {
    const { minter } = makeMinter();
    const req = request({ channelEpoch: '4', previousChannelEpoch: '3', helperNonce: nonce(9) });
    const minted = minter.mint(req);
    assert.equal(minted.ok, true);
    assert.equal(reference(minted.value.ticket, verifyOptions(req, { channel: { currentEpoch: '3', leaseState: 'active' } })).ok, true);
    const stale = minter.mint(request({ channelEpoch: '4', previousChannelEpoch: '3', helperNonce: nonce(10) }));
    assert.equal(reference(stale.value.ticket, verifyOptions(request({ channelEpoch: '4', previousChannelEpoch: '3', helperNonce: nonce(10) }),
        { channel: { currentEpoch: '4', leaseState: 'active' } })).code, 'channel_epoch_conflict');
    // A retired lease is never reopened by any ticket.
    const retired = minter.mint(request({ helperNonce: nonce(11) }));
    assert.equal(reference(retired.value.ticket, verifyOptions(request({ helperNonce: nonce(11) }), { channel: { currentEpoch: null, leaseState: 'retired' } })).code, 'lease_retired');
});

test('P4 minter refuses epoch shapes that cannot pass: first epoch must be 1 with null previous, reattach exactly previous+1', () => {
    const { minter } = makeMinter();
    for (const [epoch, prev] of [['2', null], ['1', '1'], ['5', '3'], ['0', null], ['03', '2'], [1, null], ['18446744073709551616', '18446744073709551615']]) {
        assert.equal(minter.mint(request({ channelEpoch: epoch, previousChannelEpoch: prev, helperNonce: nonce(20) })).error.code, 'channel_epoch_conflict', `${epoch}/${prev}`);
    }
});

test('P4 replay: a second validation of the same ticket or challenge refuses; the minter issues one ticket per helper nonce', () => {
    const { minter } = makeMinter();
    const req = request();
    const minted = minter.mint(req);
    const shared = verifyOptions(req);
    assert.equal(reference(minted.value.ticket, shared).ok, true);
    assert.equal(reference(minted.value.ticket, shared).code, 'ticket_replayed');
    // Same challenge, fresh ticket jti: also replayed.
    const again = minter.mint(request({ helperNonce: nonce(12) }));
    assert.equal(reference(again.value.ticket, { ...shared, expected: { ...shared.expected, helperNonce: nonce(12) } }).code, 'ticket_replayed');
    // Minter side: the nonce is consumed.
    assert.equal(minter.mint(req).error.code, 'ticket_replayed');
});

test('P4 helper-nonce memory expires with the ticket plus margin and is bounded without live eviction', () => {
    let nowMs = NOW;
    const { minter } = makeMinter({ now: () => nowMs, capacity: 2 });
    assert.equal(minter.mint(request({ helperNonce: nonce(30) })).ok, true);
    assert.equal(minter.mint(request({ helperNonce: nonce(31) })).ok, true);
    assert.equal(minter.mint(request({ helperNonce: nonce(32) })).error.code, 'capacity_exceeded');
    assert.equal(minter.mint(request({ helperNonce: nonce(30) })).error.code, 'ticket_replayed');
    nowMs += (TICKET_MAX_LIFETIME_SECONDS + 3) * 1000;
    assert.equal(minter.mint(request({ helperNonce: nonce(32) })).ok, true);
});

test('P4 lifetime: <=30 s is honored, expiry has no extension, 31 s is refused at mint and by the verifier', () => {
    const { minter } = makeMinter();
    for (const ttl of [0, 31, 1.5, -1, '30', null, undefined, 3600]) {
        assert.equal(minter.mint(request({ ttlSeconds: ttl, helperNonce: nonce(40) })).error.code, 'ticket_lifetime', String(ttl));
    }
    const short = request({ ttlSeconds: 5, helperNonce: nonce(41) });
    const minted = minter.mint(short);
    assert.equal(minted.value.exp - minted.value.iat, 5);
    assert.equal(reference(minted.value.ticket, verifyOptions(short, { nowMs: minted.value.exp * 1000 - 1 })).ok, true);
    assert.equal(reference(minted.value.ticket, verifyOptions(short, { nowMs: minted.value.exp * 1000 })).code, 'ticket_lifetime');
    // A widened lifetime signed with the real key still refuses at the verifier.
    const wide = forge({ exp: Math.floor(NOW / 1000) + 31 });
    assert.equal(reference(wide, verifyOptions(request())).code, 'ticket_lifetime');
    const future = forge({ iat: Math.floor(NOW / 1000) + 600, exp: Math.floor(NOW / 1000) + 620 });
    assert.equal(reference(future, verifyOptions(request())).code, 'ticket_lifetime');
});

test('P4 cross-workspace and cross-Box requests are refused at mint; a foreign-workspace ticket fails the verifier binding', () => {
    const { minter } = makeMinter();
    for (const field of ['workspaceId', 'boxIdentity', 'boxGeneration']) {
        const req = request({ binding: binding({ [field]: 'foreign' }), helperNonce: nonce(50) });
        assert.equal(minter.mint(req).error.code, 'target_scope_mismatch', field);
    }
    // A Router whose registry evidence names another workspace for the target also refuses.
    const { minter: m2 } = makeMinter({ readTarget: (sc) => ({ ...entryFor(sc), workspaceId: 'foreign' }) });
    assert.equal(m2.mint(request({ helperNonce: nonce(51) })).error.code, 'target_scope_mismatch');
    // Verifier: a ticket minted in workspace A presented where the helper holds workspace B's binding.
    const req = request({ helperNonce: nonce(52) });
    const minted = minter.mint(req);
    const foreign = { ...req.binding, scope: { ...req.binding.scope, workspaceId: 'ws-2' } };
    assert.equal(reference(minted.value.ticket, verifyOptions({ ...req, binding: foreign })).code, 'ticket_binding');
});

test('P4 wrong helper: stale or different incarnation, container, instance or generation refuses at mint and at the verifier', () => {
    // Live evidence is the real instance, independent of what the request claims.
    const { minter } = makeMinter({ readTarget: () => entryFor(scope()) });
    for (const [field, value] of [['helperIncarnation', id(99)], ['containerId', 'b'.repeat(64)], ['runtimeInstanceId', 'inst-2'], ['enableGeneration', 'egen-2'], ['agentPrincipal', 'agent:repoa/beta']]) {
        const req = request({ binding: binding({ [field]: value }), helperNonce: nonce(60) });
        assert.equal(minter.mint(req).error.code, 'target_mismatch', field);
    }
    const req = request({ helperNonce: nonce(61) });
    const minted = minter.mint(req);
    for (const [field, value] of [['helperIncarnation', id(98)], ['containerId', 'c'.repeat(64)]]) {
        const other = { ...req.binding, scope: { ...req.binding.scope, [field]: value } };
        assert.equal(reference(minted.value.ticket, verifyOptions({ ...req, binding: other })).code, 'ticket_binding', field);
    }
    for (const field of ['reservationId', 'operationId', 'requestDigest', 'helperNonce']) {
        const wrong = verifyOptions(req);
        wrong.expected = { ...wrong.expected, [field]: field === 'requestDigest' ? digest('0') : field === 'helperNonce' ? nonce(77) : id(77) };
        assert.equal(reference(minted.value.ticket, wrong).code, 'ticket_binding', field);
    }
    // Missing live evidence, or evidence of an ineligible instance, never signs.
    assert.equal(makeMinter({ readTarget: () => null }).minter.mint(request({ helperNonce: nonce(62) })).error.code, 'target_mismatch');
    assert.equal(makeMinter({ readTarget: () => { throw new Error('x'); } }).minter.mint(request({ helperNonce: nonce(63) })).error.code, 'target_mismatch');
    assert.equal(makeMinter({ readTarget: (sc) => ({ ...entryFor(sc), running: false }) }).minter.mint(request({ helperNonce: nonce(64) })).error.code, 'target_not_eligible');
    assert.equal(makeMinter({ readTarget: (sc) => ({ ...entryFor(sc), placement: 'isolated' }) }).minter.mint(request({ helperNonce: nonce(65) })).error.code, 'target_not_eligible');
});

test('P4 caller is a separate verified context equal to the current worker and to the binding worker half', () => {
    const { minter, authority, raw } = makeMinter();
    const issue = (over) => authority.issue({ ...WORKER, ...over });
    // Superseded worker instance or generation with the same principal (the binding claims the stale identity too).
    for (const over of [{ runtimeInstanceId: 'winst-0' }, { enableGeneration: 'wgen-0' }, { generation: id(50) }, { principal: 'agent:robo/other' }]) {
        const stale = binding({
            workerPrincipal: over.principal ?? WORKER.principal, workerRuntimeInstanceId: over.runtimeInstanceId ?? WORKER.runtimeInstanceId,
            workerEnableGeneration: over.enableGeneration ?? WORKER.enableGeneration, workerGeneration: over.generation ?? WORKER.generation,
        });
        assert.equal(minter.mint(request({ binding: stale, helperNonce: nonce(70) }), issue(over)).error.code, 'caller_mismatch', JSON.stringify(over));
    }
    // Current-worker context but a binding that names a different worker half.
    for (const field of ['workerRuntimeInstanceId', 'workerEnableGeneration', 'workerGeneration', 'workerPrincipal']) {
        const value = field === 'workerGeneration' ? id(51) : field === 'workerPrincipal' ? 'agent:robo/other' : 'x-other';
        assert.equal(minter.mint(request({ binding: binding({ [field]: value }), helperNonce: nonce(71) })).error.code, 'caller_mismatch', field);
    }
    // Plain-object, JSON-copied, foreign-authority and missing contexts are unverified.
    const real = authority.issue(WORKER);
    const copies = [{ ...WORKER }, JSON.parse(JSON.stringify(WORKER)), Object.create(null), makeMinter().authority.issue(WORKER), null, undefined, 'ctx', 7];
    for (const context of copies) assert.equal(raw.mint(context, request({ helperNonce: nonce(72) })).error.code, 'caller_unverified');
    assert.throws(() => JSON.stringify(real), TypeError);
    assert.equal(Object.isFrozen(real), true);
    assert.throws(() => authority.issue({ principal: 'x' }), TypeError);
    // A context cannot be smuggled in the request.
    assert.equal(minter.mint({ ...request({ helperNonce: nonce(73) }), callerPrincipal: 'agent:robo/worker' }).error.code, 'invalid_request');
    // The worker may be replaced after a context was issued: the old context is then superseded.
    const next = { ...WORKER, generation: id(52) };
    const m2 = makeMinter({ worker: next });
    assert.equal(m2.minter.mint(request({ helperNonce: nonce(74) })).error.code, 'caller_mismatch');
    assert.equal(m2.raw.mint(m2.authority.issue(next), request({ binding: binding({ workerGeneration: id(52) }), helperNonce: nonce(75) })).ok, true);
    // A throwing or malformed worker reader never signs.
    const bad = makeMinter({ worker: null });
    assert.equal(bad.minter.mint(request({ helperNonce: nonce(76) })).error.code, 'caller_mismatch');
});

test('P4 widened tickets: unknown or unsorted permissions refuse at mint; tampered or foreign-key tickets fail the verifier', () => {
    const { minter } = makeMinter();
    for (const permissions of [['prepare', 'admin'], ['prepare', 'commit'], ['prepare', 'prepare'], [], 'prepare', ['*']]) {
        assert.equal(minter.mint(request({ permissions, helperNonce: nonce(80) })).error.code, 'ticket_permissions', JSON.stringify(permissions));
    }
    const req = request({ helperNonce: nonce(81) });
    const minted = minter.mint(req);
    // Tamper: widen the permissions in the payload without the key.
    const [h, p, s] = minted.value.ticket.split('.');
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    claims.permissions = [...claims.permissions, 'stop'].sort();
    const tampered = `${h}.${b64(Buffer.from(canon(claims)))}.${s}`;
    assert.equal(reference(tampered, verifyOptions(req)).code, 'ticket_signature');
    // Signed with another key.
    assert.equal(reference(forge({}, { secret: OTHER_SECRET }), verifyOptions(request())).code, 'ticket_signature');
    // Properly signed but widened claims: unsorted/unknown permissions, extra key, binding substitution, other purpose.
    assert.equal(reference(forge({ permissions: ['stop', 'commit'] }), verifyOptions(request())).code, 'ticket_format');
    assert.equal(reference(forge({ permissions: ['commit', 'shell'] }), verifyOptions(request())).code, 'ticket_format');
    assert.equal(reference(forge({ extra: 1 }), verifyOptions(request())).code, 'ticket_format');
    assert.equal(reference(forge({ limitsDigest: digest('8') }), verifyOptions(request())).code, 'ticket_binding');
    assert.equal(reference(forge({ purpose: 'ploinky.coordinator.v1' }), verifyOptions(request())).code, 'ticket_purpose');
    assert.equal(reference(forge({ iss: 'someone-else' }), verifyOptions(request())).code, 'ticket_purpose');
});

test('P4 TKT-01 a token of another domain is never a helper ticket', () => {
    const header = b64(Buffer.from(canon({ alg: 'HS256', typ: 'router-service', kid: KID })));
    const payload = b64(Buffer.from(canon({ typ: 'router-service', iss: 'ploinky-router', aud: 'agent', purpose: 'x' })));
    const mac = b64(crypto.createHmac('sha256', SECRET).update(`${header}.${payload}`).digest());
    assert.equal(reference(`${header}.${payload}.${mac}`, verifyOptions(request())).code, 'ticket_purpose');
    const alg = b64(Buffer.from(canon({ alg: 'none', typ: 'ploinky-target-helper+jwt', kid: KID })));
    assert.equal(reference(`${alg}.${payload}.`, verifyOptions(request())).code, 'ticket_algorithm');
});

test('P4 the per-helper-incarnation secret is only reached through the provider callback and is never exposed', () => {
    const leaks = [];
    const secrets = { useSecret(_target, fn) { const copy = Buffer.from(SECRET); leaks.push(copy); return fn(KID, copy); } };
    const { minter } = makeMinter({ secrets });
    const req = request({ helperNonce: nonce(90) });
    const minted = minter.mint(req);
    const hex = SECRET.toString('hex');
    const b64secret = SECRET.toString('base64');
    const b64url = SECRET.toString('base64url');
    const surface = JSON.stringify(minted) + JSON.stringify(Object.getOwnPropertyNames(minter)) + String(minter.mint);
    for (const needle of [hex, b64secret, b64url]) assert.equal(surface.includes(needle), false);
    assert.equal(minted.value.ticket.includes(b64url), false);
    // Failure paths: a provider that returns nothing, a short key, a throwing provider, a bad kid.
    const refuse = (useSecret) => makeMinter({ secrets: { useSecret } }).minter.mint(request({ helperNonce: nonce(91) }));
    for (const useSecret of [() => null, (_t, fn) => fn(KID, Buffer.alloc(16, 1)), () => { throw new Error(`boom ${hex}`); },
        (_t, fn) => fn('bad kid', Buffer.from(SECRET)), (_t, fn) => fn(KID, SECRET.toString('hex'))]) {
        const result = refuse(useSecret);
        assert.deepEqual(result, { ok: false, error: { code: 'secret_unavailable' } });
        assert.equal(JSON.stringify(result).includes(hex), false);
    }
    // A refused signing does not burn the helper nonce.
    const { minter: ok } = makeMinter();
    assert.equal(ok.mint(request({ helperNonce: nonce(91) })).ok, true);
});

test('P4 malformed requests refuse with invalid_request and never throw', () => {
    const { minter } = makeMinter();
    const good = request({ helperNonce: nonce(100) });
    const cases = [
        null, 'x', [], { ...good, extra: 1 }, { ...good, helperNonce: 'short' }, { ...good, requestDigest: 'abc' },
        { ...good, reservationId: 'bad' }, { ...good, binding: null }, { ...good, binding: { ...good.binding, extra: 1, scope: { ...good.binding.scope, extra: 1 } } },
        { ...good, binding: { ...good.binding, scope: { ...good.binding.scope, containerId: 'zz' } } },
        { ...good, binding: { ...good.binding, limitsDigest: 'nope' } }, { ...good, binding: { ...good.binding, version: 2 } },
    ];
    for (const value of cases) assert.equal(minter.mint(value).error.code, 'invalid_request');
    assert.throws(() => createTargetHelperTicketMinter({}), TypeError);
    assert.throws(() => createTargetHelperTicketMinter({ live: LIVE, readTarget: () => null, secrets: {} }), TypeError);
    assert.throws(() => createTargetHelperTicketMinter({ live: LIVE, readTarget: () => null, readWorker: () => WORKER, secrets: { useSecret() {} } }), TypeError);
    // Oversized binding fails closed before signing.
    const huge = request({ binding: { ...binding(), pad: 'x'.repeat(40000) }, helperNonce: nonce(101) });
    assert.equal(minter.mint(huge).ok, false);
});

test('P4 the minter module registers no route and reads no ambient state', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../../cli/server/security/tokens/targetHelperTicketMinter.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /process\.env|console\.|writeFile|appendFile/);
    assert.doesNotMatch(source, /from ['"]node:(fs|child_process|net|http|https|dgram)['"]/);
});
