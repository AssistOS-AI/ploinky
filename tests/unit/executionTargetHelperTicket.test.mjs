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
        binding: binding(), leaseId: id(5), reservationId: id(6), operationId: id(7), requestDigest: digest('7'),
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
    const keys = ['version', 'iss', 'sub', 'purpose', 'aud', 'binding', 'leaseId', 'reservationId', 'operationId', 'requestDigest', 'helperNonce', 'jti',
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
    if (claims.leaseId !== e.leaseId || claims.reservationId !== e.reservationId || claims.operationId !== e.operationId || claims.requestDigest !== e.requestDigest
        || claims.helperNonce !== e.helperNonce) return fail('ticket_binding');
    if (options.channel.leaseState !== 'active') return fail('lease_retired');
    if (options.channel.currentEpoch === null) {
        if (BigInt(claims.channelEpoch) < 1n) return fail('channel_epoch_conflict');
    } else if (BigInt(claims.channelEpoch) <= BigInt(options.channel.currentEpoch)) return fail('channel_epoch_conflict');
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
        expected: { leaseId: req.leaseId, reservationId: req.reservationId, operationId: req.operationId, requestDigest: req.requestDigest, helperNonce: req.helperNonce },
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

test('A11.2 a reattach ticket carries a strictly greater epoch; an epoch not above the helper current epoch is a channel_epoch_conflict', () => {
    const { minter } = makeMinter();
    const req = request({ channelEpoch: '4', previousChannelEpoch: '3', helperNonce: nonce(9) });
    const minted = minter.mint(req);
    assert.equal(minted.ok, true);
    assert.equal(reference(minted.value.ticket, verifyOptions(req, { channel: { currentEpoch: '3', leaseState: 'active' } })).ok, true);
    // Gaps are allowed (a lost accepted or worker crash costs an epoch number).
    const gap = request({ channelEpoch: '9', previousChannelEpoch: null, helperNonce: nonce(13) });
    const gapMinted = minter.mint(gap);
    assert.equal(gapMinted.ok, true);
    assert.equal(reference(gapMinted.value.ticket, verifyOptions(gap, { channel: { currentEpoch: '3', leaseState: 'active' } })).ok, true);
    // A ticket whose epoch is not above the helper's current epoch is refused by the verifier.
    assert.equal(reference(minted.value.ticket, verifyOptions(req, { channel: { currentEpoch: '4', leaseState: 'active' } })).code, 'channel_epoch_conflict');
    // A retired lease is never reopened by any ticket.
    const retired = minter.mint(request({ channelEpoch: '10', helperNonce: nonce(11) }));
    assert.equal(reference(retired.value.ticket, verifyOptions(request({ helperNonce: nonce(11) }), { channel: { currentEpoch: null, leaseState: 'retired' } })).code, 'lease_retired');
});

test('A11.2 the minter refuses an epoch that is not strictly greater than the last minted epoch for that lease; epochs are tracked per lease', () => {
    const { minter } = makeMinter();
    assert.equal(minter.mint(request({ channelEpoch: '5', helperNonce: nonce(30) })).ok, true);
    for (const epoch of ['5', '4', '1']) {
        assert.equal(minter.mint(request({ channelEpoch: epoch, helperNonce: nonce(31) })).error.code, 'channel_epoch_conflict', epoch);
    }
    // A refused request does not consume the helper nonce or advance the record.
    assert.equal(minter.mint(request({ channelEpoch: '6', helperNonce: nonce(31) })).ok, true);
    // Another lease starts fresh: any epoch >= 1.
    assert.equal(minter.mint(request({ leaseId: id(55), channelEpoch: '1', helperNonce: nonce(32) })).ok, true);
    assert.equal(minter.mint(request({ leaseId: id(55), channelEpoch: '1', helperNonce: nonce(33) })).error.code, 'channel_epoch_conflict');
});

test('A11.1 the ticket carries the requested leaseId as a claim and a ticket for lease A does not verify for lease B', () => {
    const { minter } = makeMinter();
    const req = request({ leaseId: id(40), helperNonce: nonce(34) });
    const minted = minter.mint(req);
    const claims = JSON.parse(Buffer.from(minted.value.ticket.split('.')[1], 'base64url').toString('utf8'));
    assert.equal(claims.leaseId, id(40));
    assert.equal(reference(minted.value.ticket, verifyOptions(req)).ok, true);
    assert.equal(reference(minted.value.ticket, verifyOptions({ ...req, leaseId: id(41) })).code, 'ticket_binding');
    assert.equal(minter.mint(request({ leaseId: 'not-an-id', helperNonce: nonce(35) })).error.code, 'invalid_request');
    const { leaseId, ...missing } = request({ helperNonce: nonce(36) });
    assert.equal(minter.mint(missing).error.code, 'invalid_request');
});

test('P4 minter refuses malformed epoch shapes: zero, leading zero, non-text, overflow, previous not below the requested epoch', () => {
    const { minter } = makeMinter();
    for (const [epoch, prev] of [['1', '1'], ['0', null], ['03', '2'], [1, null], ['2', '3'], ['18446744073709551616', '18446744073709551615']]) {
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
    const again = minter.mint(request({ channelEpoch: '2', helperNonce: nonce(12) }));
    assert.equal(reference(again.value.ticket, { ...shared, expected: { ...shared.expected, helperNonce: nonce(12) } }).code, 'ticket_replayed');
    // Minter side: the nonce is consumed.
    assert.equal(minter.mint(request({ leaseId: id(56), helperNonce: req.helperNonce })).error.code, 'ticket_replayed');
});

test('P4 helper-nonce memory expires with the ticket plus margin and is bounded without live eviction', () => {
    let nowMs = NOW;
    const { minter } = makeMinter({ now: () => nowMs, capacity: 2 });
    assert.equal(minter.mint(request({ channelEpoch: '1', helperNonce: nonce(30) })).ok, true);
    assert.equal(minter.mint(request({ channelEpoch: '2', helperNonce: nonce(31) })).ok, true);
    assert.equal(minter.mint(request({ channelEpoch: '3', helperNonce: nonce(32) })).error.code, 'capacity_exceeded');
    assert.equal(minter.mint(request({ channelEpoch: '3', helperNonce: nonce(30) })).error.code, 'ticket_replayed');
    nowMs += (TICKET_MAX_LIFETIME_SECONDS + 3) * 1000;
    assert.equal(minter.mint(request({ channelEpoch: '3', helperNonce: nonce(32) })).ok, true);
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
    for (const field of ['leaseId', 'reservationId', 'operationId', 'requestDigest', 'helperNonce']) {
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

test('A11.2 the per-lease epoch record is bounded: a full map refuses a new lease, and leases idle past one execution lifetime are forgotten', () => {
    let clock = NOW;
    const { minter } = makeMinter({ now: () => clock, capacity: 10000 });
    const leaseN = (n) => { const b = Buffer.alloc(16); b.writeUInt32BE(n + 1, 12); return b.toString('base64url'); };
    const nonceN = (n) => { const b = Buffer.alloc(32, 0xaa); b.writeUInt32BE(n + 1, 28); return b.toString('base64url'); };
    for (let i = 0; i < 4096; i += 1) {
        assert.equal(minter.mint(request({ leaseId: leaseN(i), helperNonce: nonceN(i) })).ok, true, `lease ${i}`);
    }
    assert.equal(minter.mint(request({ leaseId: leaseN(4096), helperNonce: nonceN(4096) })).error.code, 'capacity_exceeded');
    // A known lease still advances while the map is full (touched later than the others).
    clock = NOW + 60_000;
    assert.equal(minter.mint(request({ leaseId: leaseN(0), channelEpoch: '2', previousChannelEpoch: '1', helperNonce: nonceN(5000) })).ok, true);
    // One execution lifetime later the idle leases are forgotten; the recently touched lease 0 is not yet.
    clock = NOW + 86_400_000 + 1;
    assert.equal(minter.mint(request({ leaseId: leaseN(4096), helperNonce: nonceN(5001) })).ok, true);
    clock = NOW + 86_400_000 + 2;
    assert.equal(minter.mint(request({ leaseId: leaseN(0), channelEpoch: '2', helperNonce: nonceN(5002) })).error.code, 'channel_epoch_conflict');
});

// ---- A11.5 session key and R1 lease ownership (mint route spec 2026-10-30) ----

// Independent restatement of the helper's `session::session_key`: HKDF-SHA256, ikm the incarnation secret, salt
// SHA256(canonical claim bytes) as raw bytes, info `ploinky-target-session-v1`, 32 bytes.
function referenceSessionKey(secret, ticket) {
    const claimBytes = Buffer.from(ticket.split('.')[1], 'base64url');
    const salt = crypto.createHash('sha256').update(claimBytes).digest();
    return Buffer.from(crypto.hkdfSync('sha256', secret, salt, Buffer.from('ploinky-target-session-v1', 'ascii'), 32));
}

test('A11.5 the minter returns the per-ticket session key: HKDF of the incarnation secret over the canonical claims digest', () => {
    const { minter } = makeMinter();
    const first = minter.mint(request({ helperNonce: nonce(110) }));
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.deepEqual(Object.keys(first.value).sort(), ['exp', 'iat', 'jti', 'kid', 'sessionKey', 'ticket']);
    const key = first.value.sessionKey;
    assert.match(key, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(key, 'base64url').length, 32);
    assert.equal(Buffer.from(key, 'base64url').toString('base64url'), key, 'canonical base64url');
    assert.equal(key, referenceSessionKey(SECRET, first.value.ticket).toString('base64url'));
    // Fresh per ticket (the claims differ in jti, nonce and epoch); neither the key nor the secret is in the ticket.
    const second = minter.mint(request({ channelEpoch: '2', helperNonce: nonce(111) }));
    assert.notEqual(second.value.sessionKey, key);
    assert.equal(second.value.sessionKey, referenceSessionKey(SECRET, second.value.ticket).toString('base64url'));
    assert.equal(first.value.ticket.includes(key), false);
    // A different incarnation secret over the same claims gives a different key: the key is bound to the secret.
    assert.notEqual(referenceSessionKey(OTHER_SECRET, first.value.ticket).toString('base64url'), key);
});

// session-fixture-v1.json (AssistOSExplorer robo-work/native/crates/target-helper/tests/vectors, slice P6b, A11), copied
// here as literals: PUBLIC SYNTHETIC TEST MATERIAL, the fixture key is public and only valid in a proof-fixture build.
const SESSION_FIXTURE = Object.freeze({
    kid: 'proof-fixture-helper-ticket-v1',
    secretHex: '5055424c49432053594e5448455449432070726f6f662d666978747572652076',
    claimsCanonicalSha256: '63cbcaa88c38776fa59586babf55c91d87386c430edec83108cbef062c4ed869',
    sessionKeyHex: 'c469c78a13ffd968689de405e341f0198a45f7d1eb7db70b28a833f109a59725',
    compactJws: 'eyJhbGciOiJIUzI1NiIsImtpZCI6InByb29mLWZpeHR1cmUtaGVscGVyLXRpY2tldC12MSIsInR5cCI6InBsb2lua3ktdGFyZ2V0LWhlbHBlcitqd3QifQ.eyJhdWQiOiJwbG9pbmt5OnRhcmdldC1oZWxwZXI6Y2VmNjJhY2RmZmU5Y2VmMDc1MDk5OTg5MTliY2YxMGE5MTcwMDFhOTQ5MTA2N2MxMjdkYTA5YzAzODEzMWQzNSIsImJpbmRpbmciOnsiYXR0ZW1wdElkIjoiQmdZR0JnWUdCZ1lHQmdZR0JnWUdCZyIsImNoYW5uZWxNYW5pZmVzdERpZ2VzdCI6IjExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTEiLCJjb25maWdSZXZpc2lvbiI6MiwiY29udHJhY3REaWdlc3QiOiIwNzA3MDcwNzA3MDcwNzA3MDcwNzA3MDcwNzA3MDcwNzA3MDcwNzA3MDcwNzA3MDcwNzA3MDcwNzA3MDcwNzA3IiwiY29udHJhY3RWZXJzaW9uIjoxLCJlZmZlY3RpdmVTZWN1cml0eURpZ2VzdCI6IjBjMGMwYzBjMGMwYzBjMGMwYzBjMGMwYzBjMGMwYzBjMGMwYzBjMGMwYzBjMGMwYzBjMGMwYzBjMGMwYzBjMGMiLCJleGVjdXRpb25JZCI6IkJRVUZCUVVGQlFVRkJRVUZCUVVGQlEiLCJncmFudFBvbGljeURpZ2VzdCI6IjBkMGQwZDBkMGQwZDBkMGQwZDBkMGQwZDBkMGQwZDBkMGQwZDBkMGQwZDBkMGQwZDBkMGQwZDBkMGQwZDBkMGQiLCJoZWxwZXJFeGVjdXRhYmxlRGlnZXN0IjoiMDYwNjA2MDYwNjA2MDYwNjA2MDYwNjA2MDYwNjA2MDYwNjA2MDYwNjA2MDYwNjA2MDYwNjA2MDYwNjA2MDYwNiIsImhvbWVDb21wYXRpYmlsaXR5RGlnZXN0IjoiMTIxMjEyMTIxMjEyMTIxMjEyMTIxMjEyMTIxMjEyMTIxMjEyMTIxMjEyMTIxMjEyMTIxMjEyMTIxMjEyMTIxMiIsImlucHV0TWFuaWZlc3REaWdlc3QiOiIwZTBlMGUwZTBlMGUwZTBlMGUwZTBlMGUwZTBlMGUwZTBlMGUwZTBlMGUwZTBlMGUwZTBlMGUwZTBlMGUwZTBlIiwiaW52ZW50b3J5RGlnZXN0IjoiMDgwODA4MDgwODA4MDgwODA4MDgwODA4MDgwODA4MDgwODA4MDgwODA4MDgwODA4MDgwODA4MDgwODA4MDgwOCIsImpvdXJuYWxTdG9yZUlkZW50aXR5IjoiQXdNREF3TURBd01EQXdNREF3TURBdyIsImxpbWl0c0RpZ2VzdCI6IjBhMGEwYTBhMGEwYTBhMGEwYTBhMGEwYTBhMGEwYTBhMGEwYTBhMGEwYTBhMGEwYTBhMGEwYTBhMGEwYTBhMGEiLCJuYXRpdmVDb25maWdQcm9qZWN0aW9uRGlnZXN0IjoiMTAxMDEwMTAxMDEwMTAxMDEwMTAxMDEwMTAxMDEwMTAxMDEwMTAxMDEwMTAxMDEwMTAxMDEwMTAxMDEwMTAxMCIsInByb2ZpbGVEaWdlc3QiOiIwOTA5MDkwOTA5MDkwOTA5MDkwOTA5MDkwOTA5MDkwOTA5MDkwOTA5MDkwOTA5MDkwOTA5MDkwOTA5MDkwOTA5IiwicXVhbGlmaWNhdGlvblJlY29yZERpZ2VzdCI6IjBiMGIwYjBiMGIwYjBiMGIwYjBiMGIwYjBiMGIwYjBiMGIwYjBiMGIwYjBiMGIwYjBiMGIwYjBiMGIwYjBiMGIiLCJyb2JvdElkIjoiQkFRRUJBUUVCQVFFQkFRRUJBUUVCQSIsInNjb3BlIjp7ImFnZW50UHJpbmNpcGFsIjoiYWdlbnQ6U3ludGhldGljL3RhcmdldCIsImJveEdlbmVyYXRpb24iOiJib3gtZ2VuZXJhdGlvbi0xIiwiYm94SWRlbnRpdHkiOiJwdWJsaWMtc3ludGhldGljLWJveCIsImNvbnRhaW5lcklkIjoiY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjYyIsImVuYWJsZUdlbmVyYXRpb24iOiJ0YXJnZXQtZW5hYmxlLTEiLCJoZWxwZXJJbmNhcm5hdGlvbiI6IkFnSUNBZ0lDQWdJQ0FnSUNBZ0lDQWciLCJydW50aW1lSW5zdGFuY2VJZCI6InRhcmdldC1ydW50aW1lLTEiLCJ3b3JrZXJFbmFibGVHZW5lcmF0aW9uIjoid29ya2VyLWVuYWJsZS0xIiwid29ya2VyR2VuZXJhdGlvbiI6IkFRRUJBUUVCQVFFQkFRRUJBUUVCQVEiLCJ3b3JrZXJQcmluY2lwYWwiOiJhZ2VudDpTeW50aGV0aWMvd29ya2VyIiwid29ya2VyUnVudGltZUluc3RhbmNlSWQiOiJ3b3JrZXItcnVudGltZS0xIiwid29ya3NwYWNlSWQiOiJwdWJsaWMtc3ludGhldGljLXdvcmtzcGFjZSJ9LCJza2lsbFZpZXdNYW5pZmVzdERpZ2VzdCI6IjBmMGYwZjBmMGYwZjBmMGYwZjBmMGYwZjBmMGYwZjBmMGYwZjBmMGYwZjBmMGYwZjBmMGYwZjBmMGYwZjBmMGYiLCJzb3VyY2UiOnsicmVwb3NpdG9yeVNvdXJjZU1vZGUiOiJwcm9kIiwic291cmNlQWNjZXB0YW5jZUlkZW50aXR5IjoicHVibGljLXN5bnRoZXRpYy1hY2NlcHRhbmNlIiwic291cmNlQ2xvc3VyZURpZ2VzdCI6IjA0MDQwNDA0MDQwNDA0MDQwNDA0MDQwNDA0MDQwNDA0MDQwNDA0MDQwNDA0MDQwNDA0MDQwNDA0MDQwNDA0MDQiLCJzb3VyY2VQcm90ZWN0aW9uRXBvY2giOjMsInNvdXJjZVJlcG9zaXRvcnlJZGVudGl0eSI6Imh0dHBzOi8vZXhhbXBsZS5pbnZhbGlkL3B1YmxpYy1zeW50aGV0aWMuZ2l0Iiwic291cmNlUmV2aXNpb24iOnsiYWxnb3JpdGhtIjoiZ2l0LXNoYTEiLCJ2YWx1ZSI6ImFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWEifSwic291cmNlU2VsZWN0aW9uRGlnZXN0IjoiMDMwMzAzMDMwMzAzMDMwMzAzMDMwMzAzMDMwMzAzMDMwMzAzMDMwMzAzMDMwMzAzMDMwMzAzMDMwMzAzMDMwMyJ9LCJ0YXJnZXRJbWFnZURpZ2VzdCI6InNoYTI1NjowNTA1MDUwNTA1MDUwNTA1MDUwNTA1MDUwNTA1MDUwNTA1MDUwNTA1MDUwNTA1MDUwNTA1MDUwNTA1MDUwNTA1IiwidmVyc2lvbiI6MX0sImNoYW5uZWxFcG9jaCI6IjEiLCJleHAiOjE4MDAwMDAwMzAsImhlbHBlck5vbmNlIjoiSUNBZ0lDQWdJQ0FnSUNBZ0lDQWdJQ0FnSUNBZ0lDQWdJQ0FnSUNBZ0lDQSIsImlhdCI6MTgwMDAwMDAwMCwiaXNzIjoicGxvaW5reS1yb3V0ZXIiLCJqdGkiOiJJU0VoSVNFaElTRWhJU0VoSVNFaElTRWhJU0VoSVNFaElTRWhJU0VoSVNFIiwibGVhc2VJZCI6IkNRa0pDUWtKQ1FrSkNRa0pDUWtKQ1EiLCJsaW1pdHNEaWdlc3QiOiIwYTBhMGEwYTBhMGEwYTBhMGEwYTBhMGEwYTBhMGEwYTBhMGEwYTBhMGEwYTBhMGEwYTBhMGEwYTBhMGEwYTBhIiwib3BlcmF0aW9uSWQiOiJDQWdJQ0FnSUNBZ0lDQWdJQ0FnSUNBIiwicGVybWlzc2lvbnMiOlsiY29tbWl0IiwiY29ubmVjdCIsImlucHV0IiwibG9va3VwIiwicHJlcGFyZSIsInJlbGVhc2UiLCJyZW5ldyIsInN0b3AiXSwicHJldmlvdXNDaGFubmVsRXBvY2giOm51bGwsInB1cnBvc2UiOiJwbG9pbmt5LnRhcmdldC1oZWxwZXIudjEiLCJyZXF1ZXN0RGlnZXN0IjoiMTMxMzEzMTMxMzEzMTMxMzEzMTMxMzEzMTMxMzEzMTMxMzEzMTMxMzEzMTMxMzEzMTMxMzEzMTMxMzEzMTMxMyIsInJlc2VydmF0aW9uSWQiOiJCd2NIQndjSEJ3Y0hCd2NIQndjSEJ3Iiwic3ViIjoiYWdlbnQ6U3ludGhldGljL3dvcmtlciIsInZlcnNpb24iOjF9.IVlhWd60Yuy0yCGzVAkLRlUkf215R222L2dCAioNLaw',
});

test('A11.5 the minter reproduces session-fixture-v1.json byte for byte: the compact JWS and the session key', () => {
    const fixtureClaims = JSON.parse(Buffer.from(SESSION_FIXTURE.compactJws.split('.')[1], 'base64url').toString('utf8'));
    const sc = fixtureClaims.binding.scope;
    const secret = Buffer.from(SESSION_FIXTURE.secretHex, 'hex');
    const worker = { principal: sc.workerPrincipal, runtimeInstanceId: sc.workerRuntimeInstanceId, enableGeneration: sc.workerEnableGeneration, generation: sc.workerGeneration };
    const authority = createTargetHelperCallerAuthority();
    const raw = createTargetHelperTicketMinter({
        live: { workspaceId: sc.workspaceId, boxIdentity: sc.boxIdentity, boxGeneration: sc.boxGeneration },
        readTarget: (scopeArg) => entryFor(scopeArg),
        readWorker: () => worker,
        callerAuthority: authority,
        secrets: { useSecret: (_target, fn) => fn(SESSION_FIXTURE.kid, Buffer.from(secret)) },
        now: () => fixtureClaims.iat * 1000,
        randomBytes: (n) => Buffer.alloc(n, 0x21),
    });
    const minted = raw.mint(authority.issue(worker), {
        binding: fixtureClaims.binding, leaseId: fixtureClaims.leaseId, reservationId: fixtureClaims.reservationId,
        operationId: fixtureClaims.operationId, requestDigest: fixtureClaims.requestDigest, helperNonce: fixtureClaims.helperNonce,
        channelEpoch: fixtureClaims.channelEpoch, previousChannelEpoch: fixtureClaims.previousChannelEpoch,
        permissions: fixtureClaims.permissions, ttlSeconds: fixtureClaims.exp - fixtureClaims.iat,
    });
    assert.equal(minted.ok, true, JSON.stringify(minted));
    assert.equal(minted.value.ticket, SESSION_FIXTURE.compactJws);
    assert.equal(crypto.createHash('sha256').update(Buffer.from(minted.value.ticket.split('.')[1], 'base64url')).digest('hex'), SESSION_FIXTURE.claimsCanonicalSha256);
    assert.equal(Buffer.from(minted.value.sessionKey, 'base64url').toString('hex'), SESSION_FIXTURE.sessionKeyHex);
});

test('R1 a lease is bound to the principal that minted its first ticket; another principal is caller_mismatch, the same worker after a restart keeps it', () => {
    const authority = createTargetHelperCallerAuthority();
    let current = WORKER;
    const raw = createTargetHelperTicketMinter({
        live: LIVE, readTarget: (sc) => entryFor(sc), readWorker: () => current, callerAuthority: authority,
        secrets: { useSecret: (_target, fn) => fn(KID, Buffer.from(SECRET)) }, now: () => NOW,
    });
    const as = (worker, overrides) => {
        current = worker;
        const half = { workerPrincipal: worker.principal, workerRuntimeInstanceId: worker.runtimeInstanceId,
            workerEnableGeneration: worker.enableGeneration, workerGeneration: worker.generation };
        return raw.mint(authority.issue(worker), request({ binding: binding(half), leaseId: id(120), ...overrides }));
    };
    assert.equal(as(WORKER, { channelEpoch: '5', helperNonce: nonce(120) }).ok, true);
    // Another principal, even with an epoch above or below the lease's last epoch: caller_mismatch, never an epoch answer.
    const other = { principal: 'agent:robo/other', runtimeInstanceId: 'oinst-1', enableGeneration: 'ogen-1', generation: id(9) };
    for (const epoch of ['1', '5', '6', '99']) {
        assert.equal(as(other, { channelEpoch: epoch, helperNonce: nonce(121) }).error.code, 'caller_mismatch', epoch);
    }
    // The refusals consumed nothing: the owner continues with the next epoch and the same nonce the other caller tried.
    assert.equal(as(WORKER, { channelEpoch: '6', helperNonce: nonce(121) }).ok, true);
    // A restarted (new instance, enable generation) or advanced (new generation) instance of the same worker keeps the lease.
    const restarted = { ...WORKER, runtimeInstanceId: 'winst-2', enableGeneration: 'wgen-2', generation: id(10) };
    assert.equal(as(restarted, { channelEpoch: '7', helperNonce: nonce(122) }).ok, true);
    assert.equal(as(restarted, { channelEpoch: '7', helperNonce: nonce(123) }).error.code, 'channel_epoch_conflict');
    // The other principal can open its own lease.
    assert.equal(as(other, { leaseId: id(121), channelEpoch: '1', helperNonce: nonce(124) }).ok, true);
    assert.equal(as(WORKER, { leaseId: id(121), channelEpoch: '2', helperNonce: nonce(125) }).error.code, 'caller_mismatch');
});
