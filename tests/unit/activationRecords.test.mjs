import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The lease module reads the workspace root when it is imported.
const workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-activation-records-')));
fs.mkdirSync(path.join(workspace, '.ploinky', 'data', 'edge-routing'), { recursive: true });
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
test.after(() => fs.rmSync(workspace, { recursive: true, force: true }));

const records = await import('../../cli/sandbox/activationRecords.mjs');
const locks = await import(`../../cli/utils/runtime/maintenanceLocks.js?activation=${Date.now()}`);
const { readActivationEvidence } = await import('../../ploinky-box/activationRecovery.mjs');
const { buildWorkspaceIdentity } = await import('../../ploinky-box/identity.mjs');
const { sealEdgeSelector } = await import('../../cli/sandbox/edgeSelectorRecord.mjs');

const {
    ACTIVATION_BARRIER_ADMIT,
    ACTIVATION_BARRIER_DENY,
    ACTIVATION_CONTEXT_ENV,
    activationMarkerPath,
    activationRecordPath,
    buildActivationBarrierMarker,
    classifyLeaseOperation,
    hostAdmittedActivation,
    markerRemovableBy,
    parseActivationBarrierMarker,
    parseActivationContext,
    parseActivationIntent,
    parseActivationReceipt,
    pruneActivationRecords,
    readActivationBarrierMarker,
    readActivationRequest,
    writeActivationIntent,
    writeActivationReceipt,
} = records;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OP = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);
const CONTAINER = 'c'.repeat(64);

function context(overrides = {}) {
    return {
        schema: 'ploinky-activation-context',
        version: 1,
        operation: 'restart',
        purpose: 'activate',
        settlesOperationId: null,
        operationId: OP,
        instance: 'ploinky-box-workspace-123456789abc',
        containerId: CONTAINER,
        workspaceRoot: workspace,
        ...overrides,
    };
}

function request(overrides = {}) {
    const env = { [ACTIVATION_CONTEXT_ENV]: JSON.stringify(context(overrides)) };
    return readActivationRequest(env);
}

function activeSelector() {
    return sealEdgeSelector({
        schemaVersion: 1,
        state: 'active',
        generation: `sha256:${'1'.repeat(64)}`,
        publicationState: 'ready',
        activationId: crypto.randomUUID(),
        activatedAt: new Date().toISOString(),
    });
}

function inactiveSelector() {
    return sealEdgeSelector({
        schemaVersion: 1,
        state: 'inactive',
        generation: `sha256:${'1'.repeat(64)}`,
        previousGeneration: `sha256:${'2'.repeat(64)}`,
        reason: 'coordinated-apply',
        activationId: crypto.randomUUID(),
        changedAt: new Date().toISOString(),
    });
}

function freshWorkspace(t) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-activation-ws-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, '.ploinky', 'data', 'edge-routing'), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.join(root, '.ploinky', 'data', 'edge-routing'), 0o700);
    return root;
}

function writeMarker(state = 'activated', operationId = OTHER) {
    const marker = buildActivationBarrierMarker({ operation: 'restart', operationId, state, containerId: CONTAINER });
    fs.writeFileSync(activationMarkerPath(workspace), JSON.stringify(marker), { mode: 0o600 });
    return marker;
}

function removeMarker() {
    fs.rmSync(activationMarkerPath(workspace), { force: true });
}

test.afterEach(() => {
    readActivationRequest({});
    removeMarker();
});

// --- AC1: the host-issued context ---------------------------------------

test('the activation context accepts the three purposes and rejects every malformed form before use', () => {
    for (const purpose of ['activate', 'restore']) assert.equal(parseActivationContext(JSON.stringify(context({ purpose }))).purpose, purpose);
    assert.equal(parseActivationContext(JSON.stringify(context({ purpose: 'settle', settlesOperationId: OTHER }))).settlesOperationId, OTHER);
    const rejected = [
        ['settle without the settled id', context({ purpose: 'settle' })],
        ['settle of its own id', context({ purpose: 'settle', settlesOperationId: OP })],
        ['restore with a settled id', context({ purpose: 'restore', settlesOperationId: OTHER })],
        ['activate with a settled id', context({ purpose: 'activate', settlesOperationId: OTHER })],
        ['an unknown purpose', context({ purpose: 'promote' })],
        ['an unknown operation', context({ operation: 'bind' })],
        ['an unknown field', { ...context(), extra: 1 }],
        ['a missing field', (() => { const value = context(); delete value.instance; return value; })()],
        ['a 31-hex operation id', context({ operationId: 'a'.repeat(31) })],
        ['a 33-hex operation id', context({ operationId: 'a'.repeat(33) })],
        ['an uppercase operation id', context({ operationId: 'A'.repeat(32) })],
        ['a short container id', context({ containerId: 'c'.repeat(12) })],
        ['a relative workspace', context({ workspaceRoot: 'workspace' })],
        ['another schema', context({ schema: 'ploinky-update-context' })],
    ];
    for (const [label, value] of rejected) {
        assert.throws(() => parseActivationContext(JSON.stringify(value)), { code: 'PLOINKY_ACTIVATION_CONTEXT_INVALID' }, label);
    }
    for (const raw of ['', '{', '[]', 'null', 'x'.repeat(2049)]) {
        assert.throws(() => parseActivationContext(raw), { code: 'PLOINKY_ACTIVATION_CONTEXT_INVALID' }, `raw ${raw.slice(0, 8)}`);
    }
    const padded = JSON.stringify(context({ instance: 'i'.repeat(256) }));
    assert.ok(Buffer.byteLength(padded) <= 2048);
});

test('reading the request always deletes the variable, so detached children never inherit it', () => {
    const env = { [ACTIVATION_CONTEXT_ENV]: JSON.stringify(context()), PATH: '/bin' };
    const read = readActivationRequest(env, { command: 'restart' });
    assert.equal(read.purpose, 'activate');
    assert.equal(hostAdmittedActivation(), 'activate');
    assert.equal(Object.hasOwn(env, ACTIVATION_CONTEXT_ENV), false);
    for (const value of ['', '{', 'x'.repeat(2049), JSON.stringify(context({ purpose: 'settle' }))]) {
        const bad = { [ACTIVATION_CONTEXT_ENV]: value };
        assert.throws(() => readActivationRequest(bad), { code: 'PLOINKY_ACTIVATION_CONTEXT_INVALID' });
        assert.equal(Object.hasOwn(bad, ACTIVATION_CONTEXT_ENV), false, 'deleted after a refusal');
        assert.equal(hostAdmittedActivation(), null, 'a refused context admits nothing');
    }
    assert.equal(readActivationRequest({}), null);
    assert.equal(hostAdmittedActivation(), null);
    // The command that reads it limits what it accepts.
    assert.throws(() => readActivationRequest({ [ACTIVATION_CONTEXT_ENV]: JSON.stringify(context({ purpose: 'restore' })) }, { command: 'restart' }), { code: 'PLOINKY_ACTIVATION_CONTEXT_INVALID' });
    assert.throws(() => readActivationRequest({ [ACTIVATION_CONTEXT_ENV]: JSON.stringify(context()) }, { command: 'start' }), { code: 'PLOINKY_ACTIVATION_CONTEXT_INVALID' });
    assert.equal(readActivationRequest({ [ACTIVATION_CONTEXT_ENV]: JSON.stringify(context({ operation: 'start', purpose: 'restore' })) }, { command: 'start' }).purpose, 'restore');
});

// --- AC1: write-once intent and receipt ---------------------------------

function spyFs(calls) {
    const wrap = (name) => (...args) => { calls.push(name); return fs[name](...args); };
    return {
        ...fs,
        fsyncSync: (fd) => { calls.push(fs.fstatSync(fd).isDirectory() ? 'fsync-directory' : 'fsync-file'); return fs.fsyncSync(fd); },
        linkSync: wrap('linkSync'),
        rmSync: wrap('rmSync'),
        openSync: fs.openSync,
        mkdirSync: fs.mkdirSync,
        lstatSync: fs.lstatSync,
        writeFileSync: fs.writeFileSync,
        closeSync: fs.closeSync,
    };
}

test('the intent is published once, with file fsync, link and directory fsync in that order', (t) => {
    const root = freshWorkspace(t);
    const req = request({ workspaceRoot: root });
    const calls = [];
    const intended = activeSelector();
    const predecessor = inactiveSelector();
    const written = writeActivationIntent({ workspaceRoot: root, request: req, intended, predecessor, policyStaged: true, fsApi: spyFs(calls) });
    assert.deepEqual(calls, ['fsync-file', 'linkSync', 'rmSync', 'fsync-directory']);
    const bytes = fs.readFileSync(written.path);
    assert.equal(written.digest, `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`);
    assert.equal(fs.statSync(written.path).nlink, 1);
    assert.equal(fs.statSync(written.path).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(path.dirname(written.path)), [`${OP}.intent.json`], 'no temp file is left');
    const parsed = parseActivationIntent(bytes.toString('utf8'), { operationId: OP, expectedContext: context({ workspaceRoot: root }) });
    assert.equal(parsed.state, 'valid');
    assert.equal(parsed.value.intended.selectorDigest, intended.selectorDigest);
    assert.equal(parsed.value.predecessor.activationId, predecessor.activationId);
    assert.equal(parsed.value.policyStaged, true);
    assert.throws(
        () => writeActivationIntent({ workspaceRoot: root, request: req, intended, predecessor, policyStaged: false }),
        { code: 'EEXIST' },
    );
    assert.equal(fs.readFileSync(written.path).equals(bytes), true, 'the first intent is never replaced');
    // A restore or unadmitted start never writes one.
    assert.throws(() => writeActivationIntent({ workspaceRoot: root, request: request({ workspaceRoot: root, operation: 'start', purpose: 'restore' }), intended, predecessor }));
    assert.throws(() => writeActivationIntent({ workspaceRoot: root, request: null, intended, predecessor }));
});

test('the intent and receipt parsers reject every record that is not exactly this operation', (t) => {
    const root = freshWorkspace(t);
    const expectedContext = context({ workspaceRoot: root });
    const req = request({ workspaceRoot: root });
    const written = writeActivationIntent({ workspaceRoot: root, request: req, intended: activeSelector(), predecessor: inactiveSelector(), policyStaged: false });
    const text = fs.readFileSync(written.path, 'utf8');
    const body = JSON.parse(text);
    const judge = (value) => parseActivationIntent(typeof value === 'string' ? value : JSON.stringify(value), { operationId: OP, expectedContext });
    assert.equal(judge(text).state, 'valid');
    assert.deepEqual(judge({ ...body, schema: 'ploinky-activation-receipt' }), { state: 'invalid', reason: 'unsupported' });
    assert.deepEqual(judge(text.slice(0, 30)), { state: 'invalid', reason: 'malformed' });
    assert.deepEqual(judge({ ...body, pad: 'x'.repeat(9 * 1024) }), { state: 'invalid', reason: 'oversized' });
    assert.deepEqual(judge({ ...body, operationId: OTHER }), { state: 'invalid', reason: 'wrong-operation' });
    assert.deepEqual(judge({ ...body, context: { ...body.context, containerId: 'd'.repeat(64) } }), { state: 'invalid', reason: 'foreign' });
    assert.deepEqual(judge({ ...body, intended: { ...body.intended, state: 'inactive' } }), { state: 'invalid', reason: 'malformed' });
    // The receipt binds to the exact intent bytes.
    writeActivationReceipt({ workspaceRoot: root, operationId: OP, intentDigest: written.digest, outcome: 'committed' });
    const receipt = fs.readFileSync(activationRecordPath(root, OP, 'receipt'), 'utf8');
    assert.equal(parseActivationReceipt(receipt, { operationId: OP, intentDigest: written.digest }).state, 'valid');
    assert.deepEqual(parseActivationReceipt(receipt, { operationId: OP, intentDigest: `sha256:${'0'.repeat(64)}` }), { state: 'invalid', reason: 'digest-mismatch' });
    assert.deepEqual(parseActivationReceipt(receipt, { operationId: OTHER, intentDigest: written.digest }), { state: 'invalid', reason: 'wrong-operation' });
    assert.throws(() => writeActivationReceipt({ workspaceRoot: root, operationId: OP, intentDigest: written.digest, outcome: 'not-committed' }), { code: 'EEXIST' });
});

test('the host evidence reader refuses symlinked, linked and foreign intents', (t) => {
    const root = freshWorkspace(t);
    const identity = buildWorkspaceIdentity(root, { markerFound: true });
    const expectedContext = context({ workspaceRoot: root });
    const req = request({ workspaceRoot: root });
    const written = writeActivationIntent({ workspaceRoot: root, request: req, intended: activeSelector(), predecessor: null, policyStaged: false });
    assert.equal(readActivationEvidence(identity, OP, expectedContext).intent.state, 'valid');
    assert.equal(readActivationEvidence(identity, OP, { ...expectedContext, containerId: 'd'.repeat(64) }).intent.reason, 'foreign');
    const hard = path.join(path.dirname(written.path), 'hard-link');
    fs.linkSync(written.path, hard);
    assert.deepEqual(readActivationEvidence(identity, OP, expectedContext).intent, { state: 'invalid', reason: 'linked' });
    fs.rmSync(hard);
    const moved = `${written.path}.real`;
    fs.renameSync(written.path, moved);
    fs.symlinkSync(moved, written.path);
    assert.deepEqual(readActivationEvidence(identity, OP, expectedContext).intent, { state: 'invalid', reason: 'symlink' });
    fs.rmSync(written.path);
    assert.equal(readActivationEvidence(identity, OP, expectedContext).intent.state, 'absent');
    // A group-writable controller directory fails the directory checks.
    fs.chmodSync(path.join(root, '.ploinky', 'data', 'edge-routing'), 0o770);
    assert.equal(readActivationEvidence(identity, OP, expectedContext).directories.state, 'invalid');
    fs.chmodSync(path.join(root, '.ploinky', 'data', 'edge-routing'), 0o700);
    // A group-writable workspace root does not (umask 002 users).
    fs.chmodSync(root, 0o775);
    assert.equal(readActivationEvidence(identity, OP, expectedContext).directories.state, 'valid');
});

test('pruning keeps the newest sixteen operations and removes abandoned temp files', (t) => {
    const root = freshWorkspace(t);
    const ids = Array.from({ length: 20 }, (_, index) => index.toString(16).padStart(32, '0'));
    const directory = path.join(root, '.ploinky', 'data', 'edge-routing', 'activations');
    fs.mkdirSync(directory, { mode: 0o700 });
    ids.forEach((id, index) => {
        for (const kind of ['intent', 'receipt']) {
            const file = path.join(directory, `${id}.${kind}.json`);
            fs.writeFileSync(file, '{}');
            fs.utimesSync(file, new Date(1_000_000 + index * 1000), new Date(1_000_000 + index * 1000));
        }
    });
    fs.writeFileSync(path.join(directory, `.${OP}.intent.json.1.x.tmp`), '');
    pruneActivationRecords({ workspaceRoot: root });
    const left = fs.readdirSync(directory).sort();
    assert.equal(left.length, 32);
    assert.deepEqual([...new Set(left.map((name) => name.slice(0, 32)))].sort(), ids.slice(4).sort());
});

// --- AC1 (r2): the marker ------------------------------------------------

test('the marker parser bounds the file and treats anything present but unreadable as malformed', (t) => {
    const marker = buildActivationBarrierMarker({ operation: 'start', operationId: OP, state: 'writer', containerId: CONTAINER });
    assert.equal(parseActivationBarrierMarker(JSON.stringify(marker)).state, 'valid');
    assert.equal(parseActivationBarrierMarker(JSON.stringify({ ...marker, state: 'kept' })).state, 'invalid');
    assert.equal(parseActivationBarrierMarker(JSON.stringify({ ...marker, pad: 'x'.repeat(2100) })).reason, 'oversized');
    const root = freshWorkspace(t);
    assert.deepEqual(readActivationBarrierMarker({ workspaceRoot: root }), { state: 'absent' });
    const file = activationMarkerPath(root);
    fs.writeFileSync(file, '{"schema":');
    assert.equal(readActivationBarrierMarker({ workspaceRoot: root }).state, 'malformed');
    fs.writeFileSync(file, 'x'.repeat(2049));
    assert.equal(readActivationBarrierMarker({ workspaceRoot: root }).state, 'malformed');
    fs.rmSync(file);
    const target = path.join(root, 'target.json');
    fs.writeFileSync(target, JSON.stringify(marker));
    fs.symlinkSync(target, file);
    assert.equal(readActivationBarrierMarker({ workspaceRoot: root }).state, 'malformed');
    fs.rmSync(file);
    fs.writeFileSync(file, JSON.stringify(marker));
    assert.equal(readActivationBarrierMarker({ workspaceRoot: root }).marker.operationId, OP);
});

test('remover 1 never removes a writer marker or the committing operation\'s own marker', () => {
    const marker = (state, operationId) => ({ state, operationId });
    const activate = request();
    assert.equal(markerRemovableBy(activate, marker('writer', OP)), false);
    assert.equal(markerRemovableBy(activate, marker('activated', OP)), false);
    assert.equal(markerRemovableBy(activate, marker('writer', OTHER)), false);
    assert.equal(markerRemovableBy(activate, marker('indeterminate', OTHER)), true, 'a stale or forged marker');
    const settle = request({ purpose: 'settle', settlesOperationId: OTHER });
    assert.equal(markerRemovableBy(settle, marker('activated', OTHER)), true);
    assert.equal(markerRemovableBy(settle, marker('writer', OTHER)), false);
    assert.equal(markerRemovableBy(settle, marker('activated', 'e'.repeat(32))), false, 'only the settled barrier');
    const restore = request({ operation: 'start', purpose: 'restore' });
    assert.equal(markerRemovableBy(restore, marker('activated', OTHER)), false);
    assert.equal(markerRemovableBy(null, marker('activated', OTHER)), false);
});

// --- AC16: in-Box refusal and the complete inventory ---------------------

function sampleOperation(pattern) {
    return pattern.endsWith('*') ? `${pattern.slice(0, -1)}sample` : pattern;
}

function leaseOutcome(operation) {
    try {
        const lease = locks.createWorkspaceMutationLease({ operation });
        assert.equal(locks.releaseWorkspaceMutationLease(lease), true);
        return 'admitted';
    } catch (error) {
        if (error.code === 'PLOINKY_ACTIVATION_RECOVERY_REQUIRED') return 'refused';
        throw error;
    }
}

test('with a marker present every DENY and unknown lease is refused and every ADMIT lease succeeds', () => {
    writeMarker();
    const denied = ACTIVATION_BARRIER_DENY.flatMap((pattern) => (pattern === 'canary-*'
        ? ['canary-start', 'canary-promote', 'canary-abort', 'canary-reset']
        : [sampleOperation(pattern)]));
    for (const operation of [...denied, 'workspace-mutation', 'unknown-operation']) {
        assert.equal(leaseOutcome(operation), 'refused', operation);
    }
    for (const operation of ACTIVATION_BARRIER_ADMIT.map(sampleOperation)) {
        assert.equal(leaseOutcome(operation), 'admitted', operation);
    }
    assert.throws(() => locks.withImmediateWorkspaceMutationLease('set-production-mode', () => 'changed'), (error) => {
        assert.equal(error.code, 'PLOINKY_ACTIVATION_RECOVERY_REQUIRED');
        assert.match(error.message, /^This workspace has an unsettled activation \(restart bbbbbbbb\); set-production-mode was refused\. Run `ploinky restart` on the host to settle it, or `ploinky stop`\. \[PLOINKY_ACTIVATION_RECOVERY_REQUIRED\]$/);
        return true;
    });
    // A malformed marker blocks like a valid one.
    fs.writeFileSync(activationMarkerPath(workspace), 'not json');
    assert.equal(leaseOutcome('agent-enable'), 'refused');
    assert.equal(leaseOutcome('workspace-stop'), 'admitted');
    removeMarker();
    assert.equal(leaseOutcome('agent-enable'), 'admitted', 'no marker admits everything');
});

test('host-admitted purposes open only workspace-start and workspace-restart', () => {
    writeMarker();
    request({ purpose: 'activate' });
    assert.equal(leaseOutcome('workspace-start'), 'admitted');
    assert.equal(leaseOutcome('workspace-restart'), 'admitted');
    assert.equal(leaseOutcome('agent-enable'), 'refused', 'a host-admitted start may not enable agents under a new lease');
    request({ purpose: 'settle', settlesOperationId: OTHER });
    assert.equal(leaseOutcome('workspace-restart'), 'admitted');
    assert.equal(leaseOutcome('workspace-start'), 'admitted');
});

// AC16b: restore admission through the real lease classifier.
test('a restore start is admitted under the marker; an unadmitted start and a restore restart are refused', () => {
    writeMarker('activated');
    readActivationRequest({});
    assert.throws(() => locks.createWorkspaceMutationLease({ operation: 'workspace-start' }), (error) => {
        assert.equal(error.code, 'PLOINKY_ACTIVATION_RECOVERY_REQUIRED');
        assert.match(error.message, /workspace-start was refused/);
        return true;
    });
    request({ operation: 'start', purpose: 'restore' });
    assert.equal(hostAdmittedActivation(), 'restore');
    const lease = locks.createWorkspaceMutationLease({ operation: 'workspace-start' });
    assert.equal(locks.releaseWorkspaceMutationLease(lease), true);
    assert.throws(() => locks.createWorkspaceMutationLease({ operation: 'workspace-restart' }), { code: 'PLOINKY_ACTIVATION_RECOVERY_REQUIRED' });
    assert.ok(fs.existsSync(activationMarkerPath(workspace)), 'the restore never removes the marker');
});

// The static inventory. Every call of a lease function under cli/ must name
// an operation the classifier knows. Sites whose operation is not a literal
// are resolved below; a new unresolved site fails the scan.
const LEASE_FUNCTIONS = [
    'createWorkspaceMutationLease', 'acquireWorkspaceMutationLease', 'withHeldOrAcquiredWorkspaceMutationLease',
    'acquireSettledWorkspaceMutationLease', 'withWorkspaceMutationLease', '_createWorkspaceLease', 'withLease',
    'acquireWorkspaceLease', 'acquireLease', 'lease', 'withWorkspaceLease', 'createLease', 'withLeaseFn',
    'withRepositoryLease', 'withImmediateWorkspaceMutationLease',
];
const FIRST_ARGUMENT_FUNCTIONS = new Set(['withImmediateWorkspaceMutationLease', 'withRepositoryLease']);

// file -> { args (normalized first argument) -> resolution }. A resolution is
// a list of operations, or 'pass-through' for a wrapper whose callers are
// scanned themselves. Each entry is checked against the file's own text.
const DYNAMIC_SITES = {
    'cli/utils/runtime/maintenanceLocks.js': {
        lockOptions: 'pass-through', options: 'pass-through', '{ operation }': 'pass-through',
    },
    'cli/commands/noWaitRunSettlement.js': { '{ operation }': 'pass-through' },
    'cli/commands/repoAgentCommands.js': { options: 'pass-through' },
    'cli/utils/repositoryUninstall.mjs': { leaseOptions: { literal: 'repositories-uninstall' } },
    'cli/commands/skillsCommands.js': { leaseOptions: { literal: 'repositories-prepare' } },
    'cli/utils/agents.js': { leaseOptions: { caller: /withAgentDisableRetry\('([a-z-]+)'/g } },
    'cli/commands/noWaitWorker.js': {
        '{ operation, waitTimeoutMs: remainingMs, retryIntervalMs: Math.min(1000, boundedPollIntervalMs), }': {
            defaultTemplate: /operation = `(no-wait-runtime:)\$\{/,
        },
    },
};

function stripComments(source) {
    return source.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
        .replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1');
}

function balancedArguments(source, open) {
    let depth = 0;
    for (let index = open; index < source.length; index += 1) {
        const char = source[index];
        if ('({['.includes(char)) depth += 1;
        else if (')}]'.includes(char)) {
            depth -= 1;
            if (depth === 0) return source.slice(open + 1, index);
        }
    }
    return '';
}

function firstArgument(text) {
    let depth = 0;
    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        if ('({['.includes(char)) depth += 1;
        else if (')}]'.includes(char)) depth -= 1;
        else if (char === ',' && depth === 0) return text.slice(0, index).trim();
    }
    return text.trim();
}

function sourceFiles(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(full);
        return /\.m?js$/.test(entry.name) ? [full] : [];
    });
}

function resolveValue(value, source) {
    const literal = /^'([^']+)'$/.exec(value) || /^"([^"]+)"$/.exec(value) || /^`([^`$]+)`$/.exec(value);
    if (literal) return [literal[1]];
    const template = /^`([^`$]*)\$\{/.exec(value);
    if (template && template[1]) return [`${template[1]}*`];
    const concatenated = /^'([^']+)'\s*\+/.exec(value);
    if (concatenated) return [`${concatenated[1]}*`];
    const constant = /^[A-Z][A-Z0-9_]*$/.exec(value);
    if (constant) {
        const declared = new RegExp(`const ${value} = '([^']+)'`).exec(source);
        if (declared) return [declared[1]];
    }
    return null;
}

function scanLeaseOperations() {
    const call = new RegExp(`(?<![\\w.$])(?:this\\.|locks\\.)?(${LEASE_FUNCTIONS.join('|')})\\s*\\(`, 'g');
    const operations = new Set();
    const unresolved = [];
    const cliSource = fs.readFileSync(path.join(repoRoot, 'cli/commands/cli.js'), 'utf8');
    for (const file of sourceFiles(path.join(repoRoot, 'cli'))) {
        const relative = path.relative(repoRoot, file).split(path.sep).join('/');
        const raw = fs.readFileSync(file, 'utf8');
        const source = stripComments(raw);
        for (const match of source.matchAll(call)) {
            if (/function\s*$/.test(source.slice(Math.max(0, match.index - 16), match.index))) continue;
            const line = source.slice(0, match.index).split('\n').length;
            const args = balancedArguments(source, match.index + match[0].length - 1);
            const first = firstArgument(args).replace(/\s+/g, ' ');
            let resolved = null;
            if (FIRST_ARGUMENT_FUNCTIONS.has(match[1])) resolved = resolveValue(first, source);
            if (!resolved) {
                const property = /operation:\s*('[^']*'(?:\s*\+[^,}]*)?|`[^`]*`|[A-Z][A-Z0-9_]*)/.exec(first);
                if (property) {
                    const value = property[1].trim();
                    if (value === '`workspace-${reason}`') {
                        // withReconciledWorkspace(reason): the literal reasons cli.js passes.
                        resolved = [...new Set([...cliSource.matchAll(/(?:withReconciledWorkspace|withCanarySafePreparation)\('([a-z]+)'/g)]
                            .map((reason) => `workspace-${reason[1]}`))];
                    } else if (value === "`${lockOptions?.operation || 'restart'}:${containerName}`") {
                        // withRestartLocks: its callers' operation literals, and its default.
                        const body = cliSource.match(/withRestartLocks\([\s\S]*?\{\s*operation:\s*'([a-z-]+)'/g) || [];
                        resolved = [...new Set(['restart', ...body.map((text) => /operation:\s*'([a-z-]+)'/.exec(text)[1])])]
                            .map((name) => `${name}:*`);
                    } else {
                        resolved = resolveValue(value, source);
                    }
                }
            }
            if (!resolved) {
                const known = DYNAMIC_SITES[relative]?.[first];
                if (known === 'pass-through') continue;
                if (known?.literal && raw.includes(`operation: '${known.literal}'`)) resolved = [known.literal];
                else if (known?.caller) resolved = [...raw.matchAll(known.caller)].map((caller) => caller[1]);
                else if (known?.defaultTemplate && known.defaultTemplate.test(raw)) resolved = [`${known.defaultTemplate.exec(raw)[1]}*`];
            }
            if (!resolved?.length) unresolved.push(`${relative}:${line} ${match[1]}(${first})`);
            else resolved.forEach((operation) => operations.add(operation));
        }
    }
    return { operations: [...operations].sort(), unresolved };
}

test('the static lease inventory of cli/ is complete and fully classified', (t) => {
    const { operations, unresolved } = scanLeaseOperations();
    const expected = [...ACTIVATION_BARRIER_DENY, ...ACTIVATION_BARRIER_ADMIT].sort();
    const report = `expected (DENY + ADMIT): ${JSON.stringify(expected)}\ncurrent (lease call sites): ${JSON.stringify(operations)}`;
    t.diagnostic(`expected=${JSON.stringify(expected)}`);
    t.diagnostic(`current=${JSON.stringify(operations)}`);
    assert.deepEqual(unresolved, [], `lease call sites whose operation could not be resolved:\n${unresolved.join('\n')}\n${report}`);
    const unclassified = operations.filter((operation) => !expected.includes(operation)
        && classifyLeaseOperation(sampleOperation(operation)) === 'unknown');
    assert.deepEqual(unclassified, [], `operations in neither DENY nor ADMIT:\n${report}`);
    for (const required of ['set-production-mode', 'set-workspace-profile', 'start:*', 'restart:*', 'router-restart',
        'hardware-apply', 'agent-disable', 'watchdog-restart:*']) {
        assert.ok(expected.includes(required), `the classification lacks ${required}\n${report}`);
        assert.ok(operations.includes(required), `the scan did not find ${required}\n${report}`);
    }
    // Every expected entry that names a lease operation is still in use, except
    // classification-only names (authorities, not lease call sites).
    const classificationOnly = new Set(['skills-export', 'exclusions-refresh', 'canary-status']);
    const stale = expected.filter((pattern) => !operations.includes(pattern) && !classificationOnly.has(pattern)
        && !operations.some((operation) => operation.endsWith('*') && pattern.startsWith(operation.slice(0, -1))));
    assert.deepEqual(stale, [], `classified operations no lease call site uses:\n${report}`);
});

test('a malformed marker is refused with M9 wording that points at stop, not at a settle that cannot remove it', () => {
    fs.writeFileSync(activationMarkerPath(workspace), 'not json');
    assert.throws(() => locks.createWorkspaceMutationLease({ operation: 'agent-enable' }), (error) => {
        assert.equal(error.code, 'PLOINKY_ACTIVATION_RECOVERY_REQUIRED');
        assert.match(error.message, /^This workspace has an unreadable activation barrier marker; agent-enable was refused\./);
        assert.match(error.message, /run `ploinky stop` on the host/);
        assert.doesNotMatch(error.message, /Run `ploinky restart`/);
        return true;
    });
});
