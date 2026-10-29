import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { EXECUTION_TARGET_HELPER_CONTRACT_ID, TARGET_LIMITS_V1 } from '../../cli/server/executionTarget/declaration.mjs';
import { createHelperTicketSecretProvider, MAX_TICKET_SECRET_FILE_BYTES } from '../../cli/server/executionTarget/helperTicketSecrets.mjs';
import {
    TARGET_JOURNAL_PATH,
    instancePaths,
    planExecutionTargetLaunch,
    provisionExecutionTarget,
    targetStatePaths,
} from '../../cli/server/executionTarget/provisioning.mjs';
import { createTargetHelperCallerAuthority, createTargetHelperTicketMinter } from '../../cli/server/security/tokens/targetHelperTicketMinter.mjs';

// Per-helper-incarnation ticket secret, Router side (P3/P4 delta). Provisioning writes the two copies; the provider
// reaches only the Router copy of the incarnation the record names, and every failure is `secret_unavailable`.

const PRINCIPAL = 'agent:rwrepo/rwtarget';
const IMAGE = `localhost/rwtarget@sha256:${'e'.repeat(64)}`;
const CONTAINER = 'ploinky_rwrepo_rwtarget_abc';
const VECTOR_INCARNATION = 'AgICAgICAgICAgICAgICAg';
const VECTOR_SECRET = 'ERERERERERERERERERERERERERERERERERERERERERE';
// Shared helper/Ploinky literal vector (32 x 0x11 under incarnation 16 x 0x02).
const VECTOR_TEXT = 'version=1\nhelperIncarnation=AgICAgICAgICAgICAgICAg\nkid=hti1.AgICAgICAgICAgICAgICAg\nsecret=ERERERERERERERERERERERERERERERERERERERERERE\n';
const LIVE = { workspaceId: 'ws-1', boxIdentity: 'box-1', boxGeneration: 'gen-1' };
const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);
const digest = (char) => char.repeat(64);
const id = (byte) => Buffer.alloc(16, byte).toString('base64url');

function manifest() {
    return {
        container: IMAGE,
        executionTarget: {
            version: 1,
            helper: { contractId: EXECUTION_TARGET_HELPER_CONTRACT_ID, contractDigest: digest('a'), executableDigest: digest('b') },
            inventoryDigest: digest('c'),
            profile: { id: 'nested-podman-proof', digest: digest('d') },
            stateExports: [],
            serviceExports: [],
            limits: { ...TARGET_LIMITS_V1 },
        },
    };
}

function workspace(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p4-secret-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const controllerStateDir = path.join(root, 'ws', '.ploinky', 'data');
    const boxTmpRoot = path.join(root, 'boxtmp');
    fs.mkdirSync(controllerStateDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(boxTmpRoot, { mode: 0o1777 });
    return { root, controllerStateDir, boxTmpRoot };
}

// Stands in for the target helper's `journal-init --root`.
function journalInit(args) {
    const volume = args[args.indexOf('-v') + 1];
    const journal = path.join(volume.slice(0, volume.indexOf(`:${TARGET_JOURNAL_PATH}`)), 'journal');
    if (!fs.existsSync(journal)) {
        fs.mkdirSync(journal, { mode: 0o700 });
        fs.writeFileSync(path.join(journal, 'journal-store.json'), JSON.stringify({ journalStoreIdentity: crypto.randomBytes(16).toString('base64url') }));
    }
    const identity = JSON.parse(fs.readFileSync(path.join(journal, 'journal-store.json'), 'utf8')).journalStoreIdentity;
    const stat = fs.lstatSync(journal, { bigint: true });
    return { status: 0, stdout: `${JSON.stringify({ ok: true, value: { device: String(stat.dev), inode: String(stat.ino), journalStoreIdentity: identity } })}\n` };
}

function provision(env, overrides = {}) {
    return provisionExecutionTarget({
        plan: planExecutionTargetLaunch({ manifest: manifest(), runMode: 'global', runtime: 'podman', insideBox: true }),
        principal: PRINCIPAL,
        containerName: CONTAINER,
        instanceId: 'inst-1',
        enableGeneration: 'egen-1',
        image: IMAGE,
        controllerStateDir: env.controllerStateDir,
        boxTmpRoot: env.boxTmpRoot,
        runJournalInit: journalInit,
        ...overrides,
    });
}

function vectorProvision(env) {
    return provision(env, { randomBytes: () => Buffer.alloc(16, 2), secretRandomBytes: () => Buffer.alloc(32, 0x11) });
}

function provider(env, overrides = {}) {
    return createHelperTicketSecretProvider({ controllerStateDir: env.controllerStateDir, boxTmpRoot: env.boxTmpRoot, ...overrides });
}

function target(result, overrides = {}) {
    return Object.freeze({
        ...LIVE, agentPrincipal: PRINCIPAL, containerId: 'a'.repeat(64), runtimeInstanceId: 'inst-1', enableGeneration: 'egen-1',
        helperIncarnation: result.helperIncarnation, ...overrides,
    });
}

// Calls useSecret and records what fn saw: a copy of the secret and the buffer itself (to prove it is zeroed after).
function use(secrets, tgt) {
    const seen = [];
    const value = secrets.useSecret(tgt, (kid, secret) => {
        seen.push({ kid, copy: Buffer.from(secret), buffer: secret });
        return { kid };
    });
    return { value, seen };
}

function refused(secrets, tgt, label) {
    const { value, seen } = use(secrets, tgt);
    assert.equal(value, null, label);
    assert.equal(seen.length, 0, `${label}: fn is never called`);
}

function secretText(incarnation, encoded, kid = `hti1.${incarnation}`) {
    return `version=1\nhelperIncarnation=${incarnation}\nkid=${kid}\nsecret=${encoded}\n`;
}

function replaceFile(file, content, fileMode = 0o600) {
    fs.rmSync(file, { force: true });
    fs.writeFileSync(file, content, { mode: fileMode });
    fs.chmodSync(file, fileMode);
}

// Independent helper-side parse of `control/helper-secret` (what the helper reads before unlinking it).
function parseHelperFile(text) {
    const match = /^version=1\nhelperIncarnation=([A-Za-z0-9_-]{22})\nkid=(hti1\.[A-Za-z0-9_-]{22})\nsecret=([A-Za-z0-9_-]{43})\n$/.exec(text);
    assert.ok(match, 'helper-side file is v1');
    assert.equal(match[2], `hti1.${match[1]}`);
    const secret = Buffer.from(match[3], 'base64url');
    assert.equal(secret.length, 32);
    return { helperIncarnation: match[1], kid: match[2], secret };
}

function verifyTicket(ticket, { kid, secret }) {
    const [header, payload, signature] = ticket.split('.');
    const decodedHeader = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
    const mac = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest();
    const given = Buffer.from(signature, 'base64url');
    return {
        ok: decodedHeader.alg === 'HS256' && decodedHeader.kid === kid && given.length === mac.length && crypto.timingSafeEqual(given, mac),
        claims: JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
    };
}

const WORKER = { principal: 'agent:robo/worker', runtimeInstanceId: 'winst-1', enableGeneration: 'wgen-1', generation: id(1) };

function minterFor(secrets) {
    const authority = createTargetHelperCallerAuthority();
    // readTarget always confirms the scope's target, so a refusal below can only come from the secret provider.
    const readTarget = (sc) => ({
        workspaceId: sc.workspaceId, boxIdentity: sc.boxIdentity, boxGeneration: sc.boxGeneration, principal: sc.agentPrincipal,
        containerId: sc.containerId, runtimeInstanceId: sc.runtimeInstanceId, enableGeneration: sc.enableGeneration,
        helperIncarnation: sc.helperIncarnation, enabled: true, running: true, runtime: 'container', placement: 'global',
    });
    const minter = createTargetHelperTicketMinter({ live: LIVE, readTarget, readWorker: () => WORKER, callerAuthority: authority, secrets, now: () => NOW });
    const context = authority.issue(WORKER);
    let nonceByte = 0x40;
    return (tgt) => {
        nonceByte += 1;
        const scope = {
            workspaceId: tgt.workspaceId, boxIdentity: tgt.boxIdentity, boxGeneration: tgt.boxGeneration,
            workerPrincipal: WORKER.principal, workerRuntimeInstanceId: WORKER.runtimeInstanceId, workerEnableGeneration: WORKER.enableGeneration,
            workerGeneration: WORKER.generation, agentPrincipal: tgt.agentPrincipal, containerId: tgt.containerId,
            runtimeInstanceId: tgt.runtimeInstanceId, enableGeneration: tgt.enableGeneration, helperIncarnation: tgt.helperIncarnation,
        };
        return minter.mint(context, {
            binding: { version: 1, scope, limitsDigest: digest('9'), robotId: id(3), executionId: id(4), attemptId: id(5), configRevision: 1 },
            reservationId: id(6), operationId: id(7), requestDigest: digest('7'), helperNonce: Buffer.alloc(32, nonceByte).toString('base64url'),
            channelEpoch: '1', previousChannelEpoch: null, permissions: ['commit', 'prepare'], ttlSeconds: 30,
        });
    };
}

test('P4 the provider parses the shared literal vector, hands fn the kid and secret synchronously, then zeroes the buffer', (t) => {
    const env = workspace(t);
    const result = vectorProvision(env);
    const instance = instancePaths(env.boxTmpRoot, result.instanceKey);
    assert.equal(fs.readFileSync(instance.routerSecret, 'utf8'), VECTOR_TEXT);
    const { value, seen } = use(provider(env), target(result));
    assert.deepEqual(value, { kid: `hti1.${VECTOR_INCARNATION}` });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].kid, `hti1.${VECTOR_INCARNATION}`);
    assert.deepEqual(seen[0].copy, Buffer.alloc(32, 0x11));
    assert.equal(seen[0].copy.toString('base64url'), VECTOR_SECRET);
    assert.deepEqual(seen[0].buffer, Buffer.alloc(32), 'zeroed after fn returns');
});

test('P4 the Router copy is not consumed: repeated useSecret calls give the same kid and secret, re-reading each time', (t) => {
    const env = workspace(t);
    const result = provision(env);
    const secrets = provider(env);
    const first = use(secrets, target(result));
    const second = use(secrets, target(result));
    assert.equal(first.seen[0].kid, second.seen[0].kid);
    assert.deepEqual(first.seen[0].copy, second.seen[0].copy);
    assert.ok(fs.existsSync(instancePaths(env.boxTmpRoot, result.instanceKey).routerSecret));
    // No cache: removing the file takes effect on the next call.
    fs.rmSync(instancePaths(env.boxTmpRoot, result.instanceKey).routerSecret);
    refused(secrets, target(result), 'removed after first use');
});

test('P4 end to end: provisioning -> provider -> minter -> HMAC verify with kid and secret parsed from the helper-side file', (t) => {
    const env = workspace(t);
    const first = provision(env);
    const secrets = provider(env);
    const mint = minterFor(secrets);
    const firstHelper = parseHelperFile(fs.readFileSync(instancePaths(env.boxTmpRoot, first.instanceKey).secret, 'utf8'));
    assert.equal(firstHelper.helperIncarnation, first.helperIncarnation);

    const minted = mint(target(first));
    assert.equal(minted.ok, true, JSON.stringify(minted));
    assert.equal(minted.value.kid, firstHelper.kid);
    const verified = verifyTicket(minted.value.ticket, firstHelper);
    assert.equal(verified.ok, true);
    assert.equal(verified.claims.binding.scope.helperIncarnation, first.helperIncarnation);
    assert.equal(verifyTicket(minted.value.ticket, { kid: firstHelper.kid, secret: crypto.randomBytes(32) }).ok, false);

    // A new incarnation: new secret and kid; the superseded kid is refused even though readTarget still confirms it.
    const second = provision(env, { containerName: 'ploinky_rwrepo_rwtarget_candidate', instanceId: 'inst-2', enableGeneration: 'egen-2' });
    const secondHelper = parseHelperFile(fs.readFileSync(instancePaths(env.boxTmpRoot, second.instanceKey).secret, 'utf8'));
    assert.notEqual(secondHelper.kid, firstHelper.kid);
    assert.equal(secondHelper.secret.equals(firstHelper.secret), false);
    assert.deepEqual(mint(target(first)), { ok: false, error: { code: 'secret_unavailable' } });
    const next = mint(target(second, { runtimeInstanceId: 'inst-2', enableGeneration: 'egen-2' }));
    assert.equal(next.ok, true, JSON.stringify(next));
    assert.equal(next.value.kid, secondHelper.kid);
    assert.equal(verifyTicket(next.value.ticket, secondHelper).ok, true);
    assert.equal(verifyTicket(next.value.ticket, { kid: secondHelper.kid, secret: firstHelper.secret }).ok, false, 'the old secret cannot verify');
});

test('P4 fn throwing yields null and a zeroed buffer; through the minter it is secret_unavailable', (t) => {
    const env = workspace(t);
    const result = provision(env);
    const real = provider(env);
    let captured = null;
    assert.equal(real.useSecret(target(result), (kid, secret) => { captured = secret; throw new Error('boom'); }), null);
    assert.deepEqual(captured, Buffer.alloc(32));
    captured = null;
    const throwing = { useSecret: (tgt, fn) => real.useSecret(tgt, (kid, secret) => { fn(kid, secret); captured = secret; throw new Error('after sign'); }) };
    assert.deepEqual(minterFor(throwing)(target(result)), { ok: false, error: { code: 'secret_unavailable' } });
    assert.ok(captured && captured.equals(Buffer.alloc(32)));
});

test('P4 provider refusals: absent, symlink, 0644, foreign owner, non-private instance dir', (t) => {
    const env = workspace(t);
    const result = provision(env);
    const instance = instancePaths(env.boxTmpRoot, result.instanceKey);
    const good = fs.readFileSync(instance.routerSecret);
    const secrets = provider(env);
    assert.equal(use(secrets, target(result)).seen.length, 1, 'control: the intact copy is usable');

    refused(provider(env, { euid: process.geteuid() + 1 }), target(result), 'foreign owner');

    fs.chmodSync(instance.routerSecret, 0o644);
    refused(secrets, target(result), '0644');
    fs.chmodSync(instance.routerSecret, 0o400);
    refused(secrets, target(result), '0400');
    fs.chmodSync(instance.routerSecret, 0o600);

    fs.chmodSync(instance.root, 0o750);
    refused(secrets, target(result), 'instance dir not private');
    fs.chmodSync(instance.root, 0o700);

    const elsewhere = path.join(env.root, 'copy');
    replaceFile(elsewhere, good);
    fs.rmSync(instance.routerSecret);
    refused(secrets, target(result), 'absent');
    fs.symlinkSync(elsewhere, instance.routerSecret);
    refused(secrets, target(result), 'symlink');
    fs.rmSync(instance.routerSecret);
    replaceFile(instance.routerSecret, good);
    assert.equal(use(secrets, target(result)).seen.length, 1, 'restored copy is usable again');
});

test('P4 provider refusals: the target must be exactly the incarnation and instance the record names', (t) => {
    const env = workspace(t);
    const result = provision(env);
    const secrets = provider(env);
    refused(secrets, target(result, { helperIncarnation: id(0x33) }), 'foreign incarnation');
    refused(secrets, target(result, { runtimeInstanceId: 'inst-other' }), 'record for another instance');
    refused(secrets, target(result, { enableGeneration: 'egen-other' }), 'another enable generation');
    refused(secrets, target(result, { agentPrincipal: 'agent:rwrepo/unknown' }), 'unknown principal');
    for (const bad of [null, undefined, 'x', [], { ...target(result), helperIncarnation: 'short' }, { ...target(result), agentPrincipal: 'rwrepo/rwtarget' }]) {
        refused(secrets, bad, JSON.stringify(bad));
    }
    assert.equal(secrets.useSecret(target(result), 'not a function'), null);

    const recordPath = targetStatePaths(env.controllerStateDir, PRINCIPAL).record;
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    fs.writeFileSync(recordPath, `${JSON.stringify({ ...record, current: null })}\n`);
    refused(secrets, target(result), 'current: null');
    fs.writeFileSync(recordPath, '{not json');
    refused(secrets, target(result), 'unreadable record');
    fs.writeFileSync(recordPath, `${JSON.stringify(record)}\n`);
    assert.equal(use(secrets, target(result)).seen.length, 1, 'restored record is usable again');
});

test('P4 provider refusals: the file must be the strict v1 text of this incarnation with a canonical 32-byte secret', (t) => {
    const env = workspace(t);
    const result = vectorProvision(env);
    const file = instancePaths(env.boxTmpRoot, result.instanceKey).routerSecret;
    const secrets = provider(env);
    const inc = VECTOR_INCARNATION;
    const other = id(0x33);
    const b64 = (length, byte = 0x11) => Buffer.alloc(length, byte).toString('base64url');
    const cases = {
        'file names another incarnation': secretText(other, VECTOR_SECRET),
        'kid mismatch': secretText(inc, VECTOR_SECRET, `hti1.${other}`),
        'kid without prefix': secretText(inc, VECTOR_SECRET, inc),
        '16-byte secret': secretText(inc, b64(16)),
        '31-byte secret': secretText(inc, b64(31)),
        '33-byte secret': secretText(inc, b64(33)),
        'padded base64url': secretText(inc, `${VECTOR_SECRET}=`),
        'standard base64 alphabet': secretText(inc, `${'+'.repeat(42)}A`),
        'non-canonical trailing bits': secretText(inc, `${VECTOR_SECRET.slice(0, 42)}F`),
        'reordered lines': `version=1\nkid=hti1.${inc}\nhelperIncarnation=${inc}\nsecret=${VECTOR_SECRET}\n`,
        'extra line': `${VECTOR_TEXT}extra=1\n`,
        'leading line': `# comment\n${VECTOR_TEXT}`,
        'missing final newline': VECTOR_TEXT.slice(0, -1),
        'CRLF': VECTOR_TEXT.replaceAll('\n', '\r\n'),
        'version 2': VECTOR_TEXT.replace('version=1', 'version=2'),
        'trailing space': VECTOR_TEXT.replace('\nsecret=', ' \nsecret='),
        empty: '',
    };
    for (const [label, text] of Object.entries(cases)) {
        replaceFile(file, text);
        refused(secrets, target(result), label);
    }
    replaceFile(file, VECTOR_TEXT);
    assert.equal(use(secrets, target(result)).seen.length, 1, 'the exact vector is accepted');
});

test('P4 a file over 256 bytes refuses at lstat, before it is opened', (t) => {
    const env = workspace(t);
    const result = vectorProvision(env);
    const file = instancePaths(env.boxTmpRoot, result.instanceKey).routerSecret;
    const opened = [];
    const spyFs = { ...fs, openSync: (target, ...rest) => { opened.push(target); return fs.openSync(target, ...rest); } };
    const secrets = provider(env, { fsApi: spyFs });
    assert.equal(MAX_TICKET_SECRET_FILE_BYTES, 256);
    replaceFile(file, `${VECTOR_TEXT}${'x'.repeat(257 - Buffer.byteLength(VECTOR_TEXT))}`);
    assert.equal(fs.statSync(file).size, 257);
    refused(secrets, target(result), '257 bytes');
    assert.deepEqual(opened.filter((name) => name === file), [], 'never opened');
    replaceFile(file, VECTOR_TEXT);
    assert.equal(use(secrets, target(result)).seen.length, 1);
    assert.deepEqual(opened.filter((name) => name === file), [file]);
});

test('P4 a file swapped between lstat and open is refused: a symlink by O_NOFOLLOW, another file by its identity', (t) => {
    const env = workspace(t);
    const result = vectorProvision(env);
    const file = instancePaths(env.boxTmpRoot, result.instanceKey).routerSecret;
    const decoy = path.join(env.root, 'decoy');
    replaceFile(decoy, VECTOR_TEXT);
    let swap = null;
    const swappingFs = {
        ...fs,
        openSync: (target, ...rest) => {
            if (target === file && swap) { swap(); swap = null; }
            return fs.openSync(target, ...rest);
        },
    };
    const secrets = provider(env, { fsApi: swappingFs });
    swap = () => { fs.rmSync(file); fs.symlinkSync(decoy, file); };
    refused(secrets, target(result), 'symlink swapped in after lstat');
    fs.rmSync(file);
    // A symlink to the very inode lstat saw passes an identity check; only O_NOFOLLOW refuses it.
    replaceFile(file, VECTOR_TEXT);
    const moved = path.join(env.root, 'moved');
    swap = () => { fs.renameSync(file, moved); fs.symlinkSync(moved, file); };
    refused(secrets, target(result), 'symlink to the same inode swapped in after lstat');
    fs.rmSync(file);
    replaceFile(file, VECTOR_TEXT);
    const other = path.join(env.root, 'other');
    replaceFile(other, VECTOR_TEXT);
    swap = () => fs.renameSync(other, file);
    refused(secrets, target(result), 'regular file replaced after lstat');
    assert.equal(use(secrets, target(result)).seen.length, 1, 'an unswapped valid file is accepted');
});

test('P4 the provider requires absolute roots and never throws from useSecret', (t) => {
    assert.throws(() => createHelperTicketSecretProvider({ controllerStateDir: 'rel', boxTmpRoot: '/tmp' }), TypeError);
    assert.throws(() => createHelperTicketSecretProvider({ controllerStateDir: '/x', boxTmpRoot: 'rel' }), TypeError);
    assert.throws(() => createHelperTicketSecretProvider(), TypeError);
    const env = workspace(t);
    const result = provision(env);
    const exploding = new Proxy(fs, { get: () => () => { throw new Error(`secret path ${env.root}`); } });
    refused(provider(env, { fsApi: exploding }), target(result), 'fs throwing');
});

// Wraps a BigInt stat so that selected fields read differently (everything else, including methods, is the real stat).
function statWith(stat, fields) {
    return new Proxy(stat, {
        get(real, key) {
            if (Object.hasOwn(fields, key)) return fields[key];
            const value = Reflect.get(real, key);
            return typeof value === 'function' ? value.bind(real) : value;
        },
    });
}

test('P4 the file-level owner and mode checks refuse on their own, at lstat and again at fstat', (t) => {
    const env = workspace(t);
    const result = vectorProvision(env);
    const instance = instancePaths(env.boxTmpRoot, result.instanceKey);
    const euid = process.geteuid();
    // Only the Router copy reads differently; the instance root stays genuine, so its own checks pass.
    function fsFor({ lstatFields = null, fstatFields = null }) {
        const fds = new Set();
        return {
            ...fs,
            lstatSync: (target, ...rest) => {
                const stat = fs.lstatSync(target, ...rest);
                return target === instance.routerSecret && lstatFields ? statWith(stat, lstatFields) : stat;
            },
            openSync: (target, ...rest) => {
                const fd = fs.openSync(target, ...rest);
                if (target === instance.routerSecret) fds.add(fd);
                return fd;
            },
            fstatSync: (fd, ...rest) => {
                const stat = fs.fstatSync(fd, ...rest);
                return fds.has(fd) && fstatFields ? statWith(stat, fstatFields) : stat;
            },
            closeSync: (fd) => { fds.delete(fd); return fs.closeSync(fd); },
        };
    }
    const fileMode = BigInt(fs.lstatSync(instance.routerSecret).mode);
    const looser = (fileMode & ~0o777n) | 0o644n;
    const cases = {
        'foreign owner at lstat': { lstatFields: { uid: BigInt(euid + 1) } },
        'foreign owner at fstat': { fstatFields: { uid: BigInt(euid + 1) } },
        '0644 at lstat': { lstatFields: { mode: looser } },
        '0644 at fstat': { fstatFields: { mode: looser } },
        'oversized at fstat': { fstatFields: { size: 257n } },
    };
    assert.equal(use(provider(env, { fsApi: fsFor({}) }), target(result)).seen.length, 1, 'control: the wrapper alone changes nothing');
    for (const [label, wrap] of Object.entries(cases)) refused(provider(env, { fsApi: fsFor(wrap) }), target(result), label);
});

test('P4 the previous Router copy is retired only after the new record is written: a failed record write leaves it serving', (t) => {
    const env = workspace(t);
    const first = provision(env);
    const old = instancePaths(env.boxTmpRoot, first.instanceKey);
    const recordPath = targetStatePaths(env.controllerStateDir, PRINCIPAL).record;
    const recordBefore = fs.readFileSync(recordPath);
    const failingFs = {
        ...fs,
        renameSync: (from, to) => {
            if (to === recordPath) throw Object.assign(new Error('record write failed'), { code: 'EIO' });
            return fs.renameSync(from, to);
        },
    };
    assert.throws(() => provision(env, { containerName: 'ploinky_rwrepo_rwtarget_b', instanceId: 'inst-2', enableGeneration: 'egen-2', fsApi: failingFs }),
        /record write failed/);
    assert.deepEqual(fs.readFileSync(recordPath), recordBefore, 'the record still names the first incarnation');
    assert.ok(fs.existsSync(old.routerSecret), 'the previous Router copy survives');
    const { value, seen } = use(provider(env), target(first));
    assert.deepEqual(value, { kid: `hti1.${first.helperIncarnation}` });
    assert.equal(seen.length, 1, 'and still serves its incarnation');
});
