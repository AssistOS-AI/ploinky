import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
    HardwareStoreError,
    MAX_AGENT_ENTRIES,
    STORE_SCHEMA,
    assertGateOffStoreEmpty,
    assertHardwareStateConfined,
    clearAgentLimits,
    clearAllLimits,
    hardwareStorePaths,
    initializeStore,
    parseLimitsRequestBody,
    readStoreSnapshot,
    setAgentLimits,
    validateAgentLimits,
    validateStoreDocument,
} from '../../cli/sandbox/hardwareLimits/store.mjs';
import { acquireStoreLock, recoverStaleStoreLock } from '../../cli/sandbox/hardwareLimits/storeLock.mjs';
import { validatePolicyShape } from '../../cli/sandbox/docker/containerRuntimePolicy.js';
import { isManagedManifestVolumeSource } from '../../cli/sandbox/runtimeCapabilities.js';
import { runLimitsClear } from '../../ploinky-box/hardwareLimitsGate.mjs';
import { MIB } from '../../cli/sandbox/hardwareLimits/resolve.mjs';

const ACTOR = { id: 'admin', name: 'Admin' };
const INSTALLED = new Set(['demo/agent', 'demo/other', `demo/${'a'.repeat(128)}`]);
const ENVELOPE = Object.freeze({ cpus: 8, memoryBytes: 16 * 1024 * MIB });
const CAPABILITIES = Object.freeze({ gate: 'on', controllers: ['cpu', 'memory', 'pids'] });

function fixture(t) {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-store-')));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const workspaceRoot = path.join(home, 'workspace');
    fs.mkdirSync(workspaceRoot);
    const identity = Object.freeze({
        instance: 'ploinky-box-demo-0123456789ab', pathHash: '0123456789ab', workspaceRoot, dataPaths: {},
    });
    const paths = hardwareStorePaths({ identity, homeDirectory: home });
    return { home, identity, paths };
}

function initialized(t) {
    const context = fixture(t);
    const snapshot = initializeStore({ paths: context.paths, identity: context.identity });
    return { ...context, token: snapshot.token };
}

function set(context, token, limits = { cpus: 2 }, agentRef = 'demo/agent', extra = {}) {
    return setAgentLimits({
        paths: context.paths, identity: context.identity, expectedToken: token, agentRef, limits, actor: ACTOR,
        installedRefs: INSTALLED, capabilities: CAPABILITIES, envelope: ENVELOPE, ...extra,
    });
}

function rejectsCode(fn, code) {
    assert.throws(fn, (error) => {
        assert.equal(error.code, code, error.message);
        return true;
    });
}

function auditEvents(paths) {
    try {
        return fs.readFileSync(paths.auditPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    } catch (error) {
        if (error?.code === 'ENOENT') return [];
        throw error;
    }
}

function lockedHost(identity) {
    return { assertHeld: (instance) => assert.equal(instance, identity.instance) };
}

test('S.cas', (t) => {
    const context = initialized(t);
    const first = set(context, context.token, { cpus: 2 });
    assert.equal(first.token.revision, context.token.revision + 1);
    rejectsCode(() => set(context, context.token, { cpus: 3 }), 'revision_conflict');
    const snapshot = readStoreSnapshot({ paths: context.paths, identity: context.identity });
    assert.deepEqual(snapshot.agents.get('demo/agent'), { cpus: 2 });
    // An identical policy still increments the revision.
    const again = set(context, first.token, { cpus: 2 });
    assert.equal(again.token.revision, first.token.revision + 1);
});

test('S.host-clear-race', (t) => {
    const context = initialized(t);
    const routerToken = set(context, context.token, { cpus: 2 }).token;
    const held = acquireStoreLock({ storeRoot: context.paths.storeRoot, operation: 'router-write' });
    rejectsCode(() => clearAgentLimits({
        paths: context.paths, identity: context.identity, agentRef: 'demo/agent', lockOptions: { deadlineMs: 60 },
    }), 'store_busy');
    held.release();
    const cleared = runLimitsClear({ identity: context.identity, lock: lockedHost(context.identity), agentRef: 'demo/agent', homeDirectory: context.home });
    assert.equal(cleared.cleared, true);
    // The router's token predates the host clear and cannot win.
    rejectsCode(() => set(context, routerToken, { cpus: 4 }), 'revision_conflict');
    assert.equal(readStoreSnapshot({ paths: context.paths, identity: context.identity }).agents.size, 0);
});

test('S.live-lock-never-stolen', (t) => {
    const context = initialized(t);
    const held = acquireStoreLock({ storeRoot: context.paths.storeRoot, operation: 'paused-writer' });
    let clock = Date.now();
    rejectsCode(() => acquireStoreLock({
        storeRoot: context.paths.storeRoot, deadlineMs: 50, now: () => (clock += 3_600_000), sleep: () => {},
    }), 'store_busy');
    rejectsCode(() => recoverStaleStoreLock({ storeRoot: context.paths.storeRoot, quiescence: { hostWorkspaceLockHeld: true } }), 'store_busy');
    held.release();
    // Quiescence proved: a genuinely stale lock is quarantined, not deleted.
    // A writer that crashed while holding the lock leaves it behind.
    acquireStoreLock({ storeRoot: context.paths.storeRoot, operation: 'crashed-writer' });
    const recovered = recoverStaleStoreLock({
        storeRoot: context.paths.storeRoot, quiescence: { hostWorkspaceLockHeld: true, boxQuiescent: true },
    });
    assert.equal(recovered.recovered, true);
    assert.ok(fs.existsSync(recovered.quarantine));
    acquireStoreLock({ storeRoot: context.paths.storeRoot }).release();
});

test('S.absent-never-initialized', (t) => {
    const context = fixture(t);
    const snapshot = readStoreSnapshot({ paths: context.paths, identity: context.identity });
    assert.equal(snapshot.status, 'absent-never-initialized');
    assert.equal(snapshot.agents.size, 0);
    assert.equal(fs.existsSync(context.paths.storeRoot), false, 'reading never initializes');
    const boxPaths = hardwareStorePaths({ identity: context.identity, context: 'box', boxRoot: path.join(context.home, 'box-store') });
    assert.equal(readStoreSnapshot({ paths: boxPaths, identity: context.identity }).status, 'unreadable',
        'inside a Box a missing bound store is never an empty policy');
});

test('S.initialized-missing', (t) => {
    const context = initialized(t);
    fs.unlinkSync(context.paths.policyPath);
    const snapshot = readStoreSnapshot({ paths: context.paths, identity: context.identity });
    assert.equal(snapshot.status, 'unreadable');
    assert.match(snapshot.diagnostic, /missing from an initialized store/);
    rejectsCode(() => assertGateOffStoreEmpty({ paths: context.paths, identity: context.identity }), 'store_unreadable');
});

function corrupt(t, mutate) {
    const context = initialized(t);
    mutate(context);
    return readStoreSnapshot({ paths: context.paths, identity: context.identity });
}

test('S.symlink', (t) => {
    const snapshot = corrupt(t, ({ paths }) => {
        const real = `${paths.policyPath}.real`;
        fs.renameSync(paths.policyPath, real);
        fs.symlinkSync(real, paths.policyPath);
    });
    assert.equal(snapshot.status, 'unreadable');
});

test('S.hardlink', (t) => {
    const snapshot = corrupt(t, ({ paths }) => fs.linkSync(paths.policyPath, `${paths.policyPath}.alias`));
    assert.equal(snapshot.status, 'unreadable');
    assert.match(snapshot.diagnostic, /2 links/);
});

test('S.wrong-owner', (t) => {
    const context = initialized(t);
    const fsApi = { ...fs, constants: fs.constants, fstatSync: (descriptor) => {
        const stat = fs.fstatSync(descriptor);
        return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { uid: stat.uid + 1 });
    } };
    const snapshot = readStoreSnapshot({ paths: context.paths, identity: context.identity, fsApi });
    assert.equal(snapshot.status, 'unreadable');
    assert.match(snapshot.diagnostic, /unexpected owner/);
});

test('S.nonregular', (t) => {
    const directory = corrupt(t, ({ paths }) => {
        fs.unlinkSync(paths.policyPath);
        fs.mkdirSync(paths.policyPath);
    });
    assert.equal(directory.status, 'unreadable');
    const fifo = corrupt(t, ({ paths }) => {
        fs.unlinkSync(paths.policyPath);
        assert.equal(spawnSync('mkfifo', ['-m', '600', paths.policyPath]).status, 0);
    });
    assert.equal(fifo.status, 'unreadable');
});

test('S.oversize', (t) => {
    const snapshot = corrupt(t, ({ paths }) => {
        const document = JSON.parse(fs.readFileSync(paths.policyPath, 'utf8'));
        fs.writeFileSync(paths.policyPath, JSON.stringify(document) + ' '.repeat(70 * 1024), { mode: 0o600 });
    });
    assert.equal(snapshot.status, 'unreadable');
    assert.match(snapshot.diagnostic, /exceeds 65536 bytes/);
});

test('S.unknown-key', (t) => {
    const snapshot = corrupt(t, ({ paths }) => {
        const document = JSON.parse(fs.readFileSync(paths.policyPath, 'utf8'));
        fs.writeFileSync(paths.policyPath, JSON.stringify({ ...document, pool: { cpus: 4 } }), { mode: 0o600 });
    });
    assert.equal(snapshot.status, 'unreadable');
    assert.match(snapshot.diagnostic, /unknown key 'pool'/);
});

test('S.selective-corrupt-refused', (t) => {
    const context = initialized(t);
    fs.writeFileSync(context.paths.policyPath, '{not json', { mode: 0o600 });
    assert.throws(() => runLimitsClear({ identity: context.identity, lock: lockedHost(context.identity), agentRef: 'demo/agent', homeDirectory: context.home }),
        /Selective clear cannot preserve the other entries/);
    assert.equal(fs.readFileSync(context.paths.policyPath, 'utf8'), '{not json', 'nothing changed');
});

test('S.reset-new-epoch', (t) => {
    const context = initialized(t);
    const before = readStoreSnapshot({ paths: context.paths, identity: context.identity });
    fs.writeFileSync(context.paths.policyPath, '{not json', { mode: 0o600 });
    const reset = runLimitsClear({ identity: context.identity, lock: lockedHost(context.identity), all: true, homeDirectory: context.home });
    assert.equal(reset.reset, true);
    assert.equal(reset.token.revision, 1);
    assert.notEqual(reset.token.epoch, before.token.epoch);
    assert.ok(fs.existsSync(reset.quarantined), 'the corrupt file is quarantined for inspection');
    const after = readStoreSnapshot({ paths: context.paths, identity: context.identity });
    assert.equal(after.status, 'valid');
    assert.equal(after.storeId, before.storeId, 'store identity is preserved');
    assert.equal(after.agents.size, 0);
});

test('S.old-token-rejected', (t) => {
    const context = initialized(t);
    const oldToken = context.token;
    assert.equal(oldToken.revision, 1);
    fs.writeFileSync(context.paths.policyPath, '{broken', { mode: 0o600 });
    const reset = clearAllLimits({ paths: context.paths, identity: context.identity, actor: ACTOR });
    assert.equal(reset.token.revision, 1);
    rejectsCode(() => set(context, oldToken, { cpus: 1 }), 'revision_conflict');
    assert.equal(set(context, reset.token, { cpus: 1 }).token.revision, 2);
});

test('S.outbox-before-rename', (t) => {
    const context = initialized(t);
    assert.throws(() => set(context, context.token, { cpus: 2 }, 'demo/agent', {
        faults: { beforeRename: () => { throw new Error('crash before rename'); } },
    }), /crash before rename/);
    const snapshot = readStoreSnapshot({ paths: context.paths, identity: context.identity });
    assert.deepEqual(snapshot.token, context.token, 'no policy change');
    assert.equal(snapshot.document.auditOutbox, null);
    assert.equal(auditEvents(context.paths).length, 0);
    assert.equal(set(context, context.token, { cpus: 2 }).token.revision, 2);
});

test('S.outbox-after-rename', (t) => {
    const context = initialized(t);
    assert.throws(() => set(context, context.token, { cpus: 2 }, 'demo/agent', {
        faults: { afterRename: () => { throw new Error('crash after rename'); } },
    }), /crash after rename/);
    const committed = readStoreSnapshot({ paths: context.paths, identity: context.identity });
    assert.equal(committed.token.revision, 2, 'the policy committed');
    assert.ok(committed.document.auditOutbox, 'its audit event waits in the outbox');
    const next = set(context, committed.token, { cpus: 3 });
    assert.equal(next.token.revision, 3);
    const events = auditEvents(context.paths);
    assert.deepEqual(events.map((event) => event.after?.cpus), [2, 3], 'the outbox was delivered before the next write');
});

test('S.audit-failure-committed', (t) => {
    const context = initialized(t);
    assert.throws(() => set(context, context.token, { cpus: 2 }, 'demo/agent', {
        faults: { duringAuditFlush: () => { throw new Error('audit disk full'); } },
    }), (error) => error instanceof HardwareStoreError && error.code === 'audit_pending'
        && error.committed === true && error.token.revision === 2);
    const snapshot = readStoreSnapshot({ paths: context.paths, identity: context.identity });
    assert.deepEqual(snapshot.agents.get('demo/agent'), { cpus: 2 }, 'never claims the policy was unchanged');
    assert.ok(snapshot.document.auditOutbox);
});

test('S.audit-dedup', (t) => {
    const context = initialized(t);
    assert.throws(() => set(context, context.token, { cpus: 2 }, 'demo/agent', {
        faults: { beforeOutboxClear: () => { throw new Error('crash after append'); } },
    }));
    // The flush appended but the outbox was not cleared; recovery must not
    // append the same transaction again.
    const pending = readStoreSnapshot({ paths: context.paths, identity: context.identity });
    const transactionId = pending.document.auditOutbox.transactionId;
    set(context, pending.token, { cpus: 4 });
    const matches = auditEvents(context.paths).filter((event) => event.transactionId === transactionId);
    assert.equal(matches.length, 1);
});

test('S.private-path-overlap', (t) => {
    const context = fixture(t);
    const state = path.join(context.home, '.ploinky-box', 'hardware-limits');
    fs.mkdirSync(state, { recursive: true });
    for (const workspaceRoot of [context.home, path.join(context.home, '.ploinky-box'), path.join(state, 'x')]) {
        assert.throws(() => assertHardwareStateConfined({ workspaceRoot, homeDirectory: context.home }), /overlaps writable Box source/);
    }
    assert.throws(() => assertHardwareStateConfined({ workspaceRoot: context.identity.workspaceRoot, dataPaths: { cache: state }, homeDirectory: context.home }),
        /overlaps writable Box source/);
    assert.equal(assertHardwareStateConfined({ workspaceRoot: context.identity.workspaceRoot, homeDirectory: context.home }), true);
});

test('S.orphan-clear', (t) => {
    const context = initialized(t);
    // An entry whose agent is no longer installed stays visible and clearable.
    const document = JSON.parse(fs.readFileSync(context.paths.policyPath, 'utf8'));
    document.agents['gone/agent'] = { cpus: 1 };
    fs.writeFileSync(context.paths.policyPath, JSON.stringify(document), { mode: 0o600 });
    const snapshot = readStoreSnapshot({ paths: context.paths, identity: context.identity });
    assert.ok(snapshot.agents.has('gone/agent'));
    rejectsCode(() => set(context, snapshot.token, { cpus: 1 }, 'gone/agent'), 'unknown_agent');
    const cleared = clearAgentLimits({ paths: context.paths, identity: context.identity, expectedToken: snapshot.token, agentRef: 'gone/agent', actor: ACTOR });
    assert.equal(cleared.cleared, true);
    // Clearing an absent entry is an idempotent success.
    assert.equal(clearAgentLimits({ paths: context.paths, identity: context.identity, expectedToken: cleared.token, agentRef: 'gone/agent', actor: ACTOR }).cleared, false);
});

// ---------------------------------------------------------------------------
// §18.4 schema and boundary vectors (S.vector.<row>.<index>, 1-based)

function validate(limits, { agentRef = 'demo/agent', envelope = ENVELOPE, capabilities = CAPABILITIES } = {}) {
    return validateAgentLimits({ agentRef, limits, installedRefs: INSTALLED, capabilities, envelope });
}

// Each case is [description, fn(t)]; the description documents the §18.4
// input in listed order.
function vectorCases(row, cases) {
    cases.forEach(([, fn], index) => {
        test(`S.vector.${row}.${index + 1}`, (t) => fn(t));
    });
}

const accepts = (fn) => () => assert.doesNotThrow(fn);
const rejects = (fn, code) => () => assert.throws(fn, (error) => {
    if (code) assert.equal(error.code, code, error.message);
    return true;
});

vectorCases('cpu', [
    ['0', rejects(() => validate({ cpus: 0 }), 'invalid_limits')],
    ['0.04', rejects(() => validate({ cpus: 0.04 }), 'invalid_limits')],
    ['0.05', accepts(() => validate({ cpus: 0.05 }))],
    ['envelope', accepts(() => validate({ cpus: ENVELOPE.cpus }))],
    ['envelope+0.01', rejects(() => validate({ cpus: ENVELOPE.cpus + 0.01 }), 'exceeds_envelope')],
    ['1.234', rejects(() => validate({ cpus: 1.234 }), 'invalid_limits')],
    ['-1', rejects(() => validate({ cpus: -1 }), 'invalid_limits')],
    ['"2"', rejects(() => validate({ cpus: '2' }), 'invalid_limits')],
    ['NaN', rejects(() => validate({ cpus: Number.NaN }), 'invalid_limits')],
    ['Infinity', rejects(() => validate({ cpus: Number.POSITIVE_INFINITY }), 'invalid_limits')],
    ['null', rejects(() => validate({ cpus: null }), 'invalid_limits')],
]);

vectorCases('ram-percent', [
    ['0', rejects(() => validate({ memoryPercent: 0 }), 'invalid_limits')],
    ['1', accepts(() => validate({ memoryPercent: 1 }))],
    ['100', accepts(() => validate({ memoryPercent: 100 }))],
    ['101', rejects(() => validate({ memoryPercent: 101 }), 'invalid_limits')],
    ['50.5', rejects(() => validate({ memoryPercent: 50.5 }), 'invalid_limits')],
    ['"50"', rejects(() => validate({ memoryPercent: '50' }), 'invalid_limits')],
    ['null', rejects(() => validate({ memoryPercent: null }), 'invalid_limits')],
]);

vectorCases('ram-bytes', [
    ['63 MiB', rejects(() => validate({ memoryPercent: 1 }, { envelope: { cpus: 8, memoryBytes: 6300 * MIB } }), 'exceeds_envelope')],
    ['64 MiB', () => assert.equal(validate({ memoryPercent: 1 }, { envelope: { cpus: 8, memoryBytes: 6400 * MIB } }).memoryBytes, 64 * MIB)],
    ['64.5 MiB', () => assert.equal(validate({ memoryPercent: 1 }, { envelope: { cpus: 8, memoryBytes: 6450 * MIB } }).memoryBytes, 64 * MIB)],
]);

const GPU_ELIGIBLE = Object.freeze({
    ...CAPABILITIES,
    gpu: { eligible: true, memoryModel: 'dedicated', deviceMemoryBytes: 64 * 1024 * MIB, imageUserKnown: true, name: 'test GPU' },
});
const gpu = (value, capabilities = GPU_ELIGIBLE) => validate({ gpu: value }, { capabilities });

vectorCases('gpu-percent', [
    ['0', rejects(() => gpu({ smPercent: 0, vramPercent: 50 }), 'invalid_limits')],
    ['1', accepts(() => gpu({ smPercent: 1, vramPercent: 1 }))],
    ['100', accepts(() => gpu({ smPercent: 100, vramPercent: 100 }))],
    ['101', rejects(() => gpu({ smPercent: 101, vramPercent: 50 }), 'invalid_limits')],
    ['50.5', rejects(() => gpu({ smPercent: 50.5, vramPercent: 50 }), 'invalid_limits')],
    ['"50"', rejects(() => gpu({ smPercent: '50', vramPercent: 50 }), 'invalid_limits')],
    ['missing smPercent', rejects(() => gpu({ vramPercent: 50 }), 'invalid_limits')],
    ['missing vramPercent', rejects(() => gpu({ smPercent: 50 }), 'invalid_limits')],
]);

const deviceWith = (bytes, extra = {}) => ({ ...CAPABILITIES, gpu: { ...GPU_ELIGIBLE.gpu, deviceMemoryBytes: bytes, ...extra } });
vectorCases('gpu-bytes', [
    ['511 MiB', rejects(() => gpu({ smPercent: 50, vramPercent: 1 }, deviceWith(51100 * MIB)), 'exceeds_envelope')],
    ['512 MiB', () => assert.equal(gpu({ smPercent: 50, vramPercent: 1 }, deviceWith(51200 * MIB)).gpuBytes, 512 * MIB)],
    ['numeric GB10', rejects(() => gpu({ smPercent: 50, vramPercent: 50 }, deviceWith(128 * 1024 * MIB, { memoryModel: 'unified', name: 'NVIDIA GB10' })), 'gpu_sharing_unavailable')],
    ['unknown model', rejects(() => gpu({ smPercent: 50, vramPercent: 50 }, deviceWith(8 * 1024 * MIB, { memoryModel: 'unknown' })), 'gpu_sharing_unavailable')],
]);

const pids = (value) => validatePolicyShape({ resources: { pidsLimit: value } }, 'policy');
vectorCases('declared-pids', [
    ['0', rejects(() => pids(0))],
    ['1', accepts(() => pids(1))],
    ['1048576', accepts(() => pids(1048576))],
    ['1048577', rejects(() => pids(1048577))],
    ['1.5', rejects(() => pids(1.5))],
    ['"64"', rejects(() => pids('64'))],
]);

vectorCases('reference', [
    ['empty', rejects(() => validate({ cpus: 1 }, { agentRef: '' }), 'invalid_limits')],
    ['a', rejects(() => validate({ cpus: 1 }, { agentRef: 'a' }), 'invalid_limits')],
    ['a/b/c', rejects(() => validate({ cpus: 1 }, { agentRef: 'a/b/c' }), 'invalid_limits')],
    ['../x', rejects(() => validate({ cpus: 1 }, { agentRef: '../x' }), 'invalid_limits')],
    ['valid', accepts(() => validate({ cpus: 1 }, { agentRef: 'demo/agent' }))],
    ['component length 128', accepts(() => validate({ cpus: 1 }, { agentRef: `demo/${'a'.repeat(128)}` }))],
    ['component length 129', rejects(() => validate({ cpus: 1 }, { agentRef: `demo/${'a'.repeat(129)}` }), 'invalid_limits')],
    ['Unicode', rejects(() => validate({ cpus: 1 }, { agentRef: 'demo/agént' }), 'invalid_limits')],
    ['prototype-like', rejects(() => validate({ cpus: 1 }, { agentRef: '__proto__/constructor' }), 'invalid_limits')],
    ['installed-absent', rejects(() => validate({ cpus: 1 }, { agentRef: 'demo/missing' }), 'unknown_agent')],
    ['orphan-clear', () => {
        // A well-formed orphan reference is accepted by the clear path.
        const document = minimalDocument({ 'gone/agent': { cpus: 1 } });
        assert.equal(validateStoreDocument(document).agents.has('gone/agent'), true);
    }],
]);

function minimalDocument(agents = {}, extra = {}) {
    return {
        schema: STORE_SCHEMA, instance: 'ploinky-box-demo-0123456789ab', storeId: 'b'.repeat(32), epoch: 'c'.repeat(32),
        revision: 1, updatedAt: '2026-10-01T00:00:00.000Z', agents, auditOutbox: null, auditReceipt: null, ...extra,
    };
}

function storeIdentityAlignedBytes(context, document, padTo = null) {
    const identityDocument = JSON.parse(fs.readFileSync(context.paths.identityPath, 'utf8'));
    const aligned = { ...document, instance: identityDocument.instance, storeId: identityDocument.storeId };
    const text = JSON.stringify(aligned);
    return padTo ? text.slice(0, -1) + ' '.repeat(padTo - Buffer.byteLength(text)) + '}' : text;
}

function entries(count) {
    return Object.fromEntries(Array.from({ length: count }, (_, index) => [`repo/agent${index}`, { cpus: 1 }]));
}

vectorCases('store-size', [
    ['65536 bytes', (t) => {
        const context = initialized(t);
        fs.writeFileSync(context.paths.policyPath, storeIdentityAlignedBytes(context, minimalDocument(), 65536), { mode: 0o600 });
        assert.equal(fs.statSync(context.paths.policyPath).size, 65536);
        assert.equal(readStoreSnapshot({ paths: context.paths, identity: context.identity }).status, 'valid');
    }],
    ['65537 bytes', (t) => {
        const context = initialized(t);
        fs.writeFileSync(context.paths.policyPath, storeIdentityAlignedBytes(context, minimalDocument(), 65537), { mode: 0o600 });
        assert.equal(readStoreSnapshot({ paths: context.paths, identity: context.identity }).status, 'unreadable');
    }],
    ['256 entries', () => assert.equal(validateStoreDocument(minimalDocument(entries(MAX_AGENT_ENTRIES))).agents.size, 256)],
    ['257 entries', rejects(() => validateStoreDocument(minimalDocument(entries(MAX_AGENT_ENTRIES + 1))), 'store_unreadable')],
]);

function requestBody(bytes) {
    const base = JSON.stringify({ action: 'set_agent_limits' });
    return Buffer.from(base.slice(0, -1) + ' '.repeat(bytes - Buffer.byteLength(base)) + '}');
}

vectorCases('http-size', [
    ['16384 bytes', () => assert.equal(parseLimitsRequestBody(requestBody(16384)).action, 'set_agent_limits')],
    ['16385 bytes', rejects(() => parseLimitsRequestBody(requestBody(16385)), 'invalid_limits')],
]);

vectorCases('structure', [
    ['unexpected key', rejects(() => validate({ cpus: 1, burst: 2 }), 'invalid_limits')],
    ['array instead of object', rejects(() => validate([{ cpus: 1 }]), 'invalid_limits')],
    ['unsupported schema', rejects(() => validateStoreDocument(minimalDocument({}, { schema: 'ploinky.hardware-limits/v2' })), 'store_unreadable')],
    ['old epoch', (t) => {
        const context = initialized(t);
        assert.throws(() => set(context, { epoch: 'd'.repeat(32), revision: context.token.revision }), (error) => error.code === 'revision_conflict');
    }],
    ['stale revision', (t) => {
        const context = initialized(t);
        const next = set(context, context.token).token;
        assert.throws(() => set(context, { ...next, revision: next.revision - 1 }), (error) => error.code === 'revision_conflict');
        assert.equal(readStoreSnapshot({ paths: context.paths, identity: context.identity }).token.revision, next.revision, 'no mutation');
    }],
    ['empty limit object', rejects(() => validate({}), 'invalid_limits')],
    ['pool field', rejects(() => validate({ pool: { cpus: 4 } }), 'invalid_limits')],
]);

vectorCases('private-paths', [
    ['exact store', (t) => {
        const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-vec-')));
        t.after(() => fs.rmSync(home, { recursive: true, force: true }));
        const store = path.join(home, '.ploinky-box', 'hardware-limits', 'ploinky-box-demo-0123456789ab', 'store');
        fs.mkdirSync(store, { recursive: true });
        assert.throws(() => assertHardwareStateConfined({ workspaceRoot: store, homeDirectory: home }), /overlaps writable Box source/);
    }],
    ['store ancestor', (t) => {
        const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-vec-')));
        t.after(() => fs.rmSync(home, { recursive: true, force: true }));
        assert.throws(() => assertHardwareStateConfined({ workspaceRoot: path.join(home, '.ploinky-box'), homeDirectory: home }), /overlaps/);
    }],
    ['relative escape', (t) => {
        const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-vec-')));
        t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        assert.equal(isManagedManifestVolumeSource('../.ploinky-box/hardware-limits', { workspaceRoot: root }), false);
    }],
    ['symlink/canonical escape', (t) => {
        const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-vec-')));
        t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        const outside = path.join(root, 'outside-store');
        const workspace = path.join(root, 'workspace');
        fs.mkdirSync(outside);
        fs.mkdirSync(workspace);
        fs.symlinkSync(outside, path.join(workspace, 'alias'));
        assert.equal(isManagedManifestVolumeSource('alias', { workspaceRoot: workspace }), false);
    }],
    ['MPS pipe as workspace root', rejects(() => assertHardwareStateConfined({ workspaceRoot: '/run/ploinky-mps-pipe', homeDirectory: os.tmpdir() }), 'identity_changed')],
    ['valid disjoint', (t) => {
        const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-vec-')));
        t.after(() => fs.rmSync(home, { recursive: true, force: true }));
        const workspace = path.join(home, 'projects', 'ws');
        fs.mkdirSync(workspace, { recursive: true });
        assert.equal(assertHardwareStateConfined({ workspaceRoot: workspace, homeDirectory: home }), true);
        assert.equal(isManagedManifestVolumeSource('data/models', { workspaceRoot: workspace }), true);
    }],
]);
