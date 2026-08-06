import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { runOuterCli } from '../../ploinky-box/bin/ploinky-box.mjs';
import { executeBoxCommand } from '../../ploinky-box/command/execute.mjs';
import { PodmanHostClient } from '../../ploinky-box/engine/libpodClient.mjs';
import { createOuterExecSessionStore } from '../../ploinky-box/lifecycle/outerJournal.mjs';
import { Phase10xRemoteClient } from '../helpers/phase10xRemoteClient.mjs';

const OWNED = 'a'.repeat(64);
const SESSION = 'd'.repeat(64);
const PROTECTED = 'b'.repeat(64);
const UNRELATED = 'c'.repeat(64);
const EVIDENCE_GENERATION = '1'.repeat(64);
const EVIDENCE_ENGINE = '2'.repeat(64);
const EVIDENCE_COMMAND = '3'.repeat(64);
const EVIDENCE_ATTEMPT_A = '4'.repeat(64);
const EVIDENCE_ATTEMPT_B = '5'.repeat(64);
const EVIDENCE_SESSION_A = '6'.repeat(64);
const EVIDENCE_SESSION_B = '7'.repeat(64);
const EVIDENCE_CONTAINER_B = '8'.repeat(64);

function evidenceBinding(overrides = {}) {
    return {
        connectionIdentity: 'phase10y-machine',
        containerId: OWNED,
        engineIdentity: EVIDENCE_ENGINE,
        generation: EVIDENCE_GENERATION,
        ...overrides,
    };
}

function evidenceAttempt(attemptId, createdAt, overrides = {}) {
    return {
        attemptId,
        commandHash: EVIDENCE_COMMAND,
        createdAt,
        tty: true,
        ...overrides,
    };
}

function evidenceFixture(t) {
    const workspaceRoot = fs.realpathSync(fs.mkdtempSync(
        path.join(os.tmpdir(), 'phase10y-exec-evidence-'),
    ));
    t.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }));
    return {
        workspaceRoot,
        store: createOuterExecSessionStore({ workspaceRoot }),
        filePath: path.join(
            workspaceRoot,
            '.ploinky',
            'private',
            `outer-box-exec-${OWNED}.json`,
        ),
    };
}

function transportResponse(statusCode, body = Buffer.alloc(0), contentType = undefined) {
    return {
        statusCode,
        headers: contentType ? { 'content-type': contentType } : {},
        body: Buffer.isBuffer(body) ? body : Buffer.from(String(body)),
    };
}

function transportJson(statusCode, value) {
    return transportResponse(statusCode, JSON.stringify(value), 'application/json');
}

function productionJournal(generation = EVIDENCE_GENERATION) {
    return {
        transaction: { id: 'phase10y-evidence-transaction', generation },
        phase: 'committed',
        engine: {
            name: 'podman',
            identity: EVIDENCE_ENGINE,
            apiVersion: 'v6.0.1',
            hostKind: 'podman-machine',
            connection: {
                name: 'phase10y-machine',
                identity: 'phase10y-machine',
                uri: 'ssh://localhost/run/user/501/podman.sock',
                socketPath: '/tmp/phase10y-evidence.sock',
            },
        },
        container: {
            id: OWNED,
            name: 'owned',
            labels: { owner: 'owned' },
            image: { rawId: 'e'.repeat(64) },
            creation: { dependencies: [], autoRemove: false },
        },
        predecessor: null,
    };
}

function execInspection({ running, canRemove, exitCode }) {
    return {
        ID: EVIDENCE_SESSION_A,
        ContainerID: OWNED,
        Running: running,
        ExitCode: exitCode,
        Pid: running ? 42 : 0,
        CanRemove: canRemove,
        OpenStdin: true,
        OpenStdout: true,
        OpenStderr: true,
        ProcessConfig: {
            entrypoint: '/bin/evidence-test',
            arguments: null,
            privileged: false,
            tty: true,
            user: 'podman',
        },
    };
}

function evidenceClient({ store, requestImpl, duplexImpl }) {
    return new PodmanHostClient({
        socketPath: '/tmp/phase10y-evidence.sock',
        engineIdentity: EVIDENCE_ENGINE,
        connectionIdentity: 'phase10y-machine',
        connectionUri: 'ssh://localhost/run/user/501/podman.sock',
        hostKind: 'podman-machine',
        timeoutMs: 2_000,
        execEvidenceStore: store,
        requestImpl,
        duplexImpl,
    });
}

function remoteRecord(id, name) {
    return {
        Id: id,
        Names: [name],
        Image: 'e'.repeat(64),
        ImageID: 'e'.repeat(64),
        State: 'running',
        Status: 'running',
        Pid: 42,
        AutoRemove: false,
        Dependencies: [],
        Labels: { owner: name },
    };
}

function remoteJournal() {
    return {
        phase: 'committed',
        container: {
            id: OWNED,
            name: 'owned',
            labels: { owner: 'owned' },
            image: { rawId: 'e'.repeat(64) },
            creation: { dependencies: [], autoRemove: false },
        },
        predecessor: null,
    };
}

function sharedRemote(outcome = {}) {
    return new Phase10xRemoteClient({
        containers: [
            remoteRecord(PROTECTED, 'protected'),
            remoteRecord(OWNED, 'owned'),
            remoteRecord(UNRELATED, 'unrelated'),
        ],
        ownedIds: [OWNED],
        generatedSessionIds: [SESSION],
        execOutcomes: [outcome],
    });
}

function assertSharedRemoteScope(remote) {
    for (const entry of remote.requestJournal) {
        assert.notEqual(entry.actor, PROTECTED);
        assert.notEqual(entry.actor, UNRELATED);
        assert.notEqual(entry.transport, 'cli');
    }
    for (const entry of remote.eventJournal) {
        assert.equal(entry.actor, OWNED);
        assert.equal(entry.transport, 'direct');
    }
}

function byteSink({ tty = false, rows = 24, columns = 80 } = {}) {
    const stream = new EventEmitter();
    const chunks = [];
    return Object.assign(stream, {
        isTTY: tty,
        rows: tty ? rows : undefined,
        columns: tty ? columns : undefined,
        write(chunk) {
            chunks.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(String(chunk)));
            return true;
        },
        bytes() { return Buffer.concat(chunks); },
        text() { return this.bytes().toString('utf8'); },
    });
}

function terminalStreams(inputBytes = Buffer.from('exit\n')) {
    const input = new PassThrough({ highWaterMark: 1 });
    input.isTTY = true;
    input.isRaw = false;
    input.rawModes = [];
    input.setRawMode = (enabled) => {
        input.isRaw = enabled;
        input.rawModes.push(enabled);
        return input;
    };
    input.end(inputBytes);
    return {
        input,
        output: byteSink({ tty: true }),
        errorOutput: byteSink({ tty: true }),
        signals: new EventEmitter(),
    };
}

function exactScope(ledger) {
    assert.equal(ledger.some((entry) => entry.actor === PROTECTED), false);
    assert.equal(ledger.some((entry) => entry.actor === UNRELATED), false);
    assert.equal(ledger.every((entry) => !entry.actor || entry.actor === OWNED), true);
}

function commandKind(argv) {
    if (argv.length === 2 && argv[0] === '/bin/bash' && argv[1] === '-i') return 'box-shell';
    if (argv.length === 1 && argv[0] === '/opt/ploinky/bin/ploinky-local') return 'bare';
    if (argv[0] === '/opt/ploinky/bin/ploinky-local' && argv[1] === 'cli') return 'agent-cli';
    throw new Error(`unexpected interactive argv: ${JSON.stringify(argv)}`);
}

function functionalHost(ledger, {
    resultByKind = {
        bare: { exitCode: 0, detached: false },
        'box-shell': { exitCode: 7, detached: false },
        'agent-cli': { exitCode: 19, detached: false },
    },
    waitForAbort = false,
} = {}) {
    return {
        async execContainerInteractive(request) {
            assert.equal(request.id, OWNED);
            assert.equal(request.tty, true);
            assert.equal(request.user, 'podman');
            assert.equal(request.workdir, '/workspace');
            assert.equal(request.detachKeys, 'ctrl-p,ctrl-q');
            assert.equal(request.rows, 24);
            assert.equal(request.columns, 80);
            const kind = commandKind(request.argv);
            ledger.push({ actor: request.id, operation: 'exec-create', kind });
            request.onSession(Object.freeze({
                sessionId: SESSION,
                async resize(rows, columns) {
                    ledger.push({ actor: request.id, operation: 'resize', rows, columns });
                },
            }));
            ledger.push({ actor: request.id, operation: 'exec-start', kind });
            if (waitForAbort) {
                return new Promise((resolve, reject) => {
                    request.signal.addEventListener('abort', () => {
                        ledger.push({ actor: request.id, operation: 'cancel', kind });
                        reject(request.signal.reason);
                    }, { once: true });
                });
            }
            const input = [];
            for await (const chunk of request.stdin) {
                input.push(Buffer.from(chunk));
                await new Promise((resolve) => setImmediate(resolve));
            }
            ledger.push({
                actor: request.id,
                operation: 'stdin-half-close',
                kind,
                bytes: Buffer.concat(input),
            });
            request.stdout.write(Buffer.from(`${kind}:stdout\n`));
            request.stdout.write(Buffer.from(`${kind}:merged-stderr\u001b[0m\n`));
            ledger.push({ actor: request.id, operation: 'stream-eof', kind });
            const result = resultByKind[kind];
            if (result?.detached === true) {
                ledger.push({ actor: request.id, operation: 'exec-detached-retained', kind });
                return result;
            }
            ledger.push({ actor: request.id, operation: 'exec-inspect', kind });
            ledger.push({ actor: request.id, operation: 'exec-remove-force-false', kind });
            return result;
        },
        async execContainer(request) {
            assert.equal(request.id, OWNED);
            assert.equal(request.user, 'podman');
            assert.equal(request.workdir, '/workspace');
            assert.equal(Buffer.isBuffer(request.input), true);
            ledger.push({
                actor: request.id,
                operation: 'non-tty-stdin-half-close',
                bytes: Buffer.from(request.input),
            });
            ledger.push({ actor: request.id, operation: 'non-tty-stream-eof' });
            ledger.push({ actor: request.id, operation: 'exec-inspect' });
            ledger.push({ actor: request.id, operation: 'exec-remove-force-false' });
            return {
                stdout: Buffer.from('bounded stdout\n'),
                stderr: Buffer.from('bounded stderr\n'),
                exitCode: 23,
                sessionId: SESSION,
            };
        },
        async cliContainer() {
            ledger.push({ actor: PROTECTED, operation: 'forbidden-host-cli' });
            throw new Error('ordinary host CLI seam must never be used');
        },
    };
}

function functionalSupervisor(hostClient, ledger) {
    const journal = Object.freeze({ phase: 'committed', generation: 'f'.repeat(64) });
    const prepared = Object.freeze({
        containerId: OWNED,
        hostClient,
        journal,
        hostPort: 19090,
    });
    return {
        async prepareBoxForCommand() {
            ledger.push({ operation: 'prepare-owned-generation' });
            return prepared;
        },
        async executeInteractiveCommand(selected, argv, options) {
            assert.equal(selected, prepared);
            return executeBoxCommand({
                hostClient: selected.hostClient,
                containerId: selected.containerId,
                journal: selected.journal,
                argv,
                hostPort: selected.hostPort,
                ...options,
            });
        },
    };
}

async function runInteractive(argv, {
    hostOptions,
    terminal = terminalStreams(),
    callerSignal = null,
    resizeDebounceMs = 0,
} = {}) {
    const ledger = [];
    const hostClient = functionalHost(ledger, hostOptions);
    const supervisor = functionalSupervisor(hostClient, ledger);
    const running = runOuterCli(argv, {
        env: {},
        ...terminal,
        supervisor,
        signalSource: terminal.signals,
        callerSignal,
        resizeDebounceMs,
        detectInsideBox: () => false,
    });
    return { running, ledger, terminal };
}

function assertCompletedSession({ ledger, terminal }, kind, input = 'exit\n') {
    assert.deepEqual(
        ledger.filter((entry) => entry.actor === OWNED).map((entry) => entry.operation),
        [
            'exec-create',
            'exec-start',
            'stdin-half-close',
            'stream-eof',
            'exec-inspect',
            'exec-remove-force-false',
        ],
    );
    const halfClose = ledger.find((entry) => entry.operation === 'stdin-half-close');
    assert.equal(halfClose.kind, kind);
    assert.equal(halfClose.bytes.toString('utf8'), input);
    assert.equal(terminal.output.text(), `${kind}:stdout\n${kind}:merged-stderr\u001b[0m\n`);
    assert.equal(terminal.errorOutput.text(), '');
    assert.deepEqual(terminal.input.rawModes, [true, false]);
    assert.equal(terminal.signals.eventNames().length, 0);
    exactScope(ledger);
}

test('exec evidence is a private 0600 file bound per exact container generation', (t) => {
    const fixture = evidenceFixture(t);
    const binding = evidenceBinding();
    const first = fixture.store.begin(
        binding,
        evidenceAttempt(EVIDENCE_ATTEMPT_A, 1_000),
    );

    assert.equal(first.revision, 1);
    assert.deepEqual(first.binding, binding);
    assert.deepEqual(first.attempts, [{
        attemptId: EVIDENCE_ATTEMPT_A,
        commandHash: EVIDENCE_COMMAND,
        createdAt: 1_000,
        updatedAt: 1_000,
        tty: true,
        state: 'creating',
        sessionId: null,
    }]);
    const evidenceStat = fs.lstatSync(fixture.filePath);
    assert.equal(evidenceStat.isFile(), true);
    assert.equal(evidenceStat.isSymbolicLink(), false);
    assert.equal(evidenceStat.nlink, 1);
    assert.equal(evidenceStat.mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(fixture.filePath)).mode & 0o777, 0o700);

    const secondBinding = evidenceBinding({ containerId: EVIDENCE_CONTAINER_B });
    fixture.store.begin(secondBinding, evidenceAttempt(EVIDENCE_ATTEMPT_B, 1_001));
    const secondPath = path.join(
        fixture.workspaceRoot,
        '.ploinky',
        'private',
        `outer-box-exec-${EVIDENCE_CONTAINER_B}.json`,
    );
    assert.equal(fs.existsSync(secondPath), true);
    assert.notEqual(fs.statSync(secondPath).ino, evidenceStat.ino);
    assert.deepEqual(fixture.store.read(binding), first);
});

test('begin survives a lost create response as a null-session ambiguous attempt', (t) => {
    const fixture = evidenceFixture(t);
    const binding = evidenceBinding();
    fixture.store.begin(binding, evidenceAttempt(EVIDENCE_ATTEMPT_A, 2_000));

    const afterCrash = createOuterExecSessionStore({
        workspaceRoot: fixture.workspaceRoot,
    }).read(binding);
    assert.equal(afterCrash.attempts[0].state, 'creating');
    assert.equal(afterCrash.attempts[0].sessionId, null);
    fixture.store.retain(binding, {
        attemptId: EVIDENCE_ATTEMPT_A,
        sessionId: null,
        state: 'ambiguous',
        updatedAt: 2_001,
    });

    const retained = createOuterExecSessionStore({
        workspaceRoot: fixture.workspaceRoot,
    }).read(binding);
    assert.equal(retained.revision, 2);
    assert.equal(retained.attempts[0].state, 'ambiguous');
    assert.equal(retained.attempts[0].sessionId, null);
});

test('exact session publication and detached retention persist without expiry', (t) => {
    const fixture = evidenceFixture(t);
    const binding = evidenceBinding();
    fixture.store.begin(binding, evidenceAttempt(EVIDENCE_ATTEMPT_A, 3_000));
    fixture.store.created(binding, {
        attemptId: EVIDENCE_ATTEMPT_A,
        sessionId: EVIDENCE_SESSION_A,
        updatedAt: 3_001,
    });
    const created = fixture.store.read(binding);
    assert.equal(created.attempts[0].state, 'created');
    assert.equal(created.attempts[0].sessionId, EVIDENCE_SESSION_A);

    fixture.store.retain(binding, {
        attemptId: EVIDENCE_ATTEMPT_A,
        sessionId: EVIDENCE_SESSION_A,
        state: 'detached',
        updatedAt: 3_002,
    });
    const detached = createOuterExecSessionStore({
        workspaceRoot: fixture.workspaceRoot,
    }).read(binding);
    assert.equal(detached.attempts[0].state, 'detached');
    assert.equal(detached.attempts[0].sessionId, EVIDENCE_SESSION_A);
    assert.throws(() => fixture.store.removed(binding, {
        attemptId: EVIDENCE_ATTEMPT_A,
        sessionId: EVIDENCE_SESSION_A,
    }), /removal publication is invalid/);
    assert.equal(fixture.store.read(binding).attempts[0].state, 'detached');
});

test('successful removal clears only the exact created attempt and exact session', (t) => {
    const fixture = evidenceFixture(t);
    const binding = evidenceBinding();
    fixture.store.begin(binding, evidenceAttempt(EVIDENCE_ATTEMPT_A, 4_000));
    fixture.store.created(binding, {
        attemptId: EVIDENCE_ATTEMPT_A,
        sessionId: EVIDENCE_SESSION_A,
        updatedAt: 4_001,
    });
    fixture.store.begin(binding, evidenceAttempt(EVIDENCE_ATTEMPT_B, 4_002));
    fixture.store.created(binding, {
        attemptId: EVIDENCE_ATTEMPT_B,
        sessionId: EVIDENCE_SESSION_B,
        updatedAt: 4_003,
    });

    assert.throws(() => fixture.store.removed(binding, {
        attemptId: EVIDENCE_ATTEMPT_A,
        sessionId: EVIDENCE_SESSION_B,
    }), /removal publication is invalid/);
    fixture.store.removed(binding, {
        attemptId: EVIDENCE_ATTEMPT_A,
        sessionId: EVIDENCE_SESSION_A,
    });
    const remaining = fixture.store.read(binding);
    assert.deepEqual(remaining.attempts.map(({ attemptId, sessionId }) => ({
        attemptId,
        sessionId,
    })), [{
        attemptId: EVIDENCE_ATTEMPT_B,
        sessionId: EVIDENCE_SESSION_B,
    }]);

    fixture.store.removed(binding, {
        attemptId: EVIDENCE_ATTEMPT_B,
        sessionId: EVIDENCE_SESSION_B,
    });
    assert.equal(fixture.store.read(binding, { allowMissing: true }), null);
    assert.equal(fs.existsSync(fixture.filePath), false);
});

test('session substitution, stale generation, and corrupt evidence fail closed', (t) => {
    const fixture = evidenceFixture(t);
    const binding = evidenceBinding();
    fixture.store.begin(binding, evidenceAttempt(EVIDENCE_ATTEMPT_A, 5_000));
    fixture.store.created(binding, {
        attemptId: EVIDENCE_ATTEMPT_A,
        sessionId: EVIDENCE_SESSION_A,
        updatedAt: 5_001,
    });
    assert.throws(() => fixture.store.retain(binding, {
        attemptId: EVIDENCE_ATTEMPT_A,
        sessionId: EVIDENCE_SESSION_B,
        state: 'ambiguous',
        updatedAt: 5_002,
    }), /session substitution is forbidden/);
    assert.equal(fixture.store.read(binding).attempts[0].sessionId, EVIDENCE_SESSION_A);

    const staleBinding = evidenceBinding({ generation: '9'.repeat(64) });
    assert.throws(() => fixture.store.read(staleBinding), /does not match the selected generation/);
    assert.throws(() => fixture.store.begin(
        staleBinding,
        evidenceAttempt(EVIDENCE_ATTEMPT_B, 5_003),
    ), /does not match the selected generation/);
    assert.equal(fixture.store.read(binding).attempts.length, 1);

    fs.writeFileSync(fixture.filePath, '{corrupt evidence', { mode: 0o600 });
    fs.chmodSync(fixture.filePath, 0o600);
    assert.throws(() => fixture.store.read(binding), /unreadable or corrupt/);
});

test('production client begins before create, publishes exact session, and clears after Force:false', async (t) => {
    const fixture = evidenceFixture(t);
    const binding = evidenceBinding();
    const requests = [];
    let inspections = 0;
    let observedCreating = false;
    let observedCreated = false;
    const client = evidenceClient({
        store: fixture.store,
        requestImpl: async (request) => {
            requests.push(request);
            if (request.path.includes('/containers/json?')) {
                return transportJson(200, [remoteRecord(OWNED, 'owned')]);
            }
            if (request.path.endsWith(`${OWNED}%25/exec`)) {
                const record = fixture.store.read(binding);
                observedCreating = record.attempts.length === 1
                    && record.attempts[0].state === 'creating'
                    && record.attempts[0].sessionId === null;
                return transportJson(201, { Id: EVIDENCE_SESSION_A });
            }
            if (request.path.endsWith(`/exec/${EVIDENCE_SESSION_A}/json`)) {
                inspections += 1;
                if (inspections === 1) {
                    const record = fixture.store.read(binding);
                    observedCreated = record.attempts[0].state === 'created'
                        && record.attempts[0].sessionId === EVIDENCE_SESSION_A;
                    return transportJson(200, execInspection({
                        running: false,
                        canRemove: false,
                        exitCode: 0,
                    }));
                }
                return transportJson(200, execInspection({
                    running: false,
                    canRemove: true,
                    exitCode: 37,
                }));
            }
            if (request.path.endsWith(`/exec/${EVIDENCE_SESSION_A}/remove`)) {
                return transportResponse(200);
            }
            throw new Error(`unexpected request ${request.path}`);
        },
        duplexImpl: async (request) => {
            request.onUpgraded();
            return { statusCode: 101, detached: false };
        },
    });
    const terminal = terminalStreams(Buffer.from('evidence stdin'));
    const result = await client.execContainerInteractive({
        id: OWNED,
        argv: ['/bin/evidence-test'],
        journal: productionJournal(),
        tty: true,
        rows: 24,
        columns: 80,
        stdin: terminal.input,
        stdout: terminal.output,
        stderr: terminal.errorOutput,
        timeoutMs: 1_000,
        inactivityTimeoutMs: 500,
    });

    assert.deepEqual(result, { exitCode: 37, detached: false });
    assert.equal(observedCreating, true);
    assert.equal(observedCreated, true);
    const remove = requests.find((entry) => entry.path.endsWith('/remove'));
    assert.equal(remove.method, 'POST');
    assert.equal(remove.body.toString('utf8'), '{"Force":false}');
    assert.equal(fixture.store.read(binding, { allowMissing: true }), null);
});

test('production create-response loss retains a null ambiguous attempt without starting', async (t) => {
    const fixture = evidenceFixture(t);
    const binding = evidenceBinding();
    let duplexCalls = 0;
    const client = evidenceClient({
        store: fixture.store,
        requestImpl: async (request) => {
            if (request.path.includes('/containers/json?')) {
                return transportJson(200, [remoteRecord(OWNED, 'owned')]);
            }
            if (request.path.endsWith(`${OWNED}%25/exec`)) {
                const creating = fixture.store.read(binding).attempts[0];
                assert.equal(creating.state, 'creating');
                assert.equal(creating.sessionId, null);
                throw new Error('create response lost');
            }
            throw new Error(`unexpected request ${request.path}`);
        },
        duplexImpl: async () => {
            duplexCalls += 1;
            throw new Error('duplex must not start');
        },
    });
    const terminal = terminalStreams();
    await assert.rejects(client.execContainerInteractive({
        id: OWNED,
        argv: ['/bin/evidence-test'],
        journal: productionJournal(),
        tty: true,
        rows: 24,
        columns: 80,
        stdin: terminal.input,
        stdout: terminal.output,
        stderr: terminal.errorOutput,
        timeoutMs: 1_000,
        inactivityTimeoutMs: 500,
    }), /create response lost/);

    const retained = fixture.store.read(binding);
    assert.equal(duplexCalls, 0);
    assert.equal(retained.attempts.length, 1);
    assert.equal(retained.attempts[0].state, 'ambiguous');
    assert.equal(retained.attempts[0].sessionId, null);
});

test('production detach retains the exact published session and never requests removal', async (t) => {
    const fixture = evidenceFixture(t);
    const binding = evidenceBinding();
    const requests = [];
    let inspections = 0;
    const client = evidenceClient({
        store: fixture.store,
        requestImpl: async (request) => {
            requests.push(request);
            if (request.path.includes('/containers/json?')) {
                return transportJson(200, [remoteRecord(OWNED, 'owned')]);
            }
            if (request.path.endsWith(`${OWNED}%25/exec`)) {
                return transportJson(201, { Id: EVIDENCE_SESSION_A });
            }
            if (request.path.endsWith(`/exec/${EVIDENCE_SESSION_A}/json`)) {
                inspections += 1;
                return transportJson(200, inspections === 1
                    ? execInspection({ running: false, canRemove: false, exitCode: 0 })
                    : execInspection({ running: true, canRemove: false, exitCode: 0 }));
            }
            throw new Error(`unexpected request ${request.path}`);
        },
        duplexImpl: async (request) => {
            request.onUpgraded();
            return { statusCode: 101, detached: true };
        },
    });
    const terminal = terminalStreams();
    const result = await client.execContainerInteractive({
        id: OWNED,
        argv: ['/bin/evidence-test'],
        journal: productionJournal(),
        tty: true,
        rows: 24,
        columns: 80,
        stdin: terminal.input,
        stdout: terminal.output,
        stderr: terminal.errorOutput,
        timeoutMs: 1_000,
        inactivityTimeoutMs: 500,
    });

    assert.deepEqual(result, { exitCode: 0, detached: true });
    assert.equal(requests.some((entry) => entry.path.endsWith('/remove')), false);
    const retained = fixture.store.read(binding);
    assert.equal(retained.attempts[0].state, 'detached');
    assert.equal(retained.attempts[0].sessionId, EVIDENCE_SESSION_A);
});

test('bare Ploinky functionally streams TTY input/output through completion', async () => {
    const scenario = await runInteractive([]);
    assert.equal(await scenario.running, 0);
    assertCompletedSession(scenario, 'bare');
});

test('ploinky cli Box shell functionally streams TTY input and propagates exit status', async () => {
    const scenario = await runInteractive(['cli']);
    assert.equal(await scenario.running, 7);
    assertCompletedSession(scenario, 'box-shell');
});

test('interactive agent CLI functionally streams TTY bytes and propagates exit status', async () => {
    const scenario = await runInteractive([
        'cli', 'Agent', '--workdir', 'project', '--', '--model', 'bounded model',
    ], { terminal: terminalStreams(Buffer.from('agent input\n')) });
    assert.equal(await scenario.running, 19);
    assertCompletedSession(scenario, 'agent-cli', 'agent input\n');
});

test('non-TTY execution delivers bounded stdin, separates stdout/stderr, and propagates exit', async () => {
    const ledger = [];
    const stdout = byteSink();
    const stderr = byteSink();
    const input = Buffer.from('one bounded stdin payload\n');
    const result = await executeBoxCommand({
        hostClient: functionalHost(ledger),
        containerId: OWNED,
        journal: { phase: 'committed' },
        argv: ['/opt/ploinky/bin/ploinky-local', 'status'],
        hostPort: 19090,
        input,
        stdout,
        stderr,
        timeoutMs: 1_234,
        maxOutputBytes: 4_096,
    });

    assert.equal(result.exitCode, 23);
    assert.equal(stdout.text(), 'bounded stdout\n');
    assert.equal(stderr.text(), 'bounded stderr\n');
    assert.deepEqual(
        ledger.map((entry) => entry.operation),
        [
            'non-tty-stdin-half-close',
            'non-tty-stream-eof',
            'exec-inspect',
            'exec-remove-force-false',
        ],
    );
    assert.deepEqual(ledger[0].bytes, input);
    exactScope(ledger);
});

test('shared remote ledger proves raw TTY bytes, write-half-close, exit proof, and non-force cleanup', async () => {
    const ttyBytes = Buffer.from([0x72, 0x61, 0x77, 0x00, 0xff, 0x1b, 0x5b, 0x30, 0x6d]);
    const remote = sharedRemote({ ttyBytes, exitCode: 31 });
    const terminal = terminalStreams(Buffer.from('bounded tty stdin'));
    let controller;
    const result = await executeBoxCommand({
        hostClient: remote,
        containerId: OWNED,
        journal: remoteJournal(),
        argv: ['/opt/ploinky/bin/ploinky-local'],
        stdin: terminal.input,
        stdout: terminal.output,
        stderr: terminal.errorOutput,
        interactive: true,
        tty: true,
        rows: 24,
        columns: 80,
        detachKeys: 'ctrl-p,ctrl-q',
        timeoutMs: 1_000,
        inactivityTimeoutMs: 500,
        maxOutputBytes: 4_096,
        onSession(value) { controller = value; },
    });

    assert.deepEqual(result, { exitCode: 31, detached: false });
    assert.equal(Object.isFrozen(controller), true);
    assert.equal(controller.sessionId, SESSION);
    assert.deepEqual(terminal.output.bytes(), ttyBytes);
    assert.equal(terminal.errorOutput.bytes().length, 0);
    assert.deepEqual(
        remote.requestJournal.map((entry) => entry.operation),
        [
            'exec-create',
            'exec-inspect-pre',
            'exec-start',
            'exec-stdin',
            'exec-write-half-close',
            'exec-inspect-final',
            'exec-remove',
        ],
    );
    const create = remote.requestJournal[0];
    assert.deepEqual(create.spec, {
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        DetachKeys: 'ctrl-p,ctrl-q',
        Tty: true,
        Env: [],
        Cmd: ['/opt/ploinky/bin/ploinky-local'],
        Privileged: false,
        User: 'podman',
        WorkingDir: '/workspace',
    });
    assert.deepEqual(
        remote.requestJournal.find((entry) => entry.operation === 'exec-stdin').bytes,
        Buffer.from('bounded tty stdin'),
    );
    assert.equal(
        remote.requestJournal.find((entry) => entry.operation === 'exec-inspect-final').running,
        false,
    );
    assert.equal(remote.requestJournal.at(-1).force, false);
    assert.equal(remote.execSessions.size, 0);
    assertSharedRemoteScope(remote);
});

test('foreign container or session substitution fails before start and any unowned mutation', async () => {
    const foreignSession = 'f'.repeat(64);
    for (const outcome of [
        { containerId: PROTECTED },
        { sessionId: foreignSession },
    ]) {
        const remote = sharedRemote(outcome);
        const terminal = terminalStreams();
        await assert.rejects(executeBoxCommand({
            hostClient: remote,
            containerId: OWNED,
            journal: remoteJournal(),
            argv: ['/opt/ploinky/bin/ploinky-local'],
            stdin: terminal.input,
            stdout: terminal.output,
            stderr: terminal.errorOutput,
            interactive: true,
            tty: true,
            rows: 24,
            columns: 80,
            timeoutMs: 1_000,
            inactivityTimeoutMs: 500,
            onSession() { throw new Error('foreign proof must fail before session admission'); },
        }), /pre-start binding proof failed/);
        assert.deepEqual(
            remote.requestJournal.map((entry) => entry.operation),
            ['exec-create', 'exec-inspect-pre'],
        );
        assert.deepEqual(remote.eventJournal, []);
        assert.equal(remote.execSessions.size, 1);
        assertSharedRemoteScope(remote);
    }
});

test('exit or cleanup ambiguity retains session evidence and never force-removes or falls back', async () => {
    for (const outcome of [
        { exitCode: 'not-an-exit-code' },
        { exitCode: 0, cleanupError: new Error('cleanup response lost') },
    ]) {
        const remote = sharedRemote(outcome);
        const terminal = terminalStreams();
        await assert.rejects(executeBoxCommand({
            hostClient: remote,
            containerId: OWNED,
            journal: remoteJournal(),
            argv: ['/opt/ploinky/bin/ploinky-local'],
            stdin: terminal.input,
            stdout: terminal.output,
            stderr: terminal.errorOutput,
            interactive: true,
            tty: true,
            rows: 24,
            columns: 80,
            timeoutMs: 1_000,
            inactivityTimeoutMs: 500,
            onSession() {},
        }));
        const removals = remote.requestJournal.filter((entry) => entry.operation === 'exec-remove');
        assert.equal(removals.length, outcome.cleanupError ? 1 : 0);
        assert.equal(removals.every((entry) => entry.force === false), true);
        assert.equal(remote.execSessions.has(SESSION), true);
        assert.equal(remote.requestJournal.some((entry) => entry.transport === 'cli'), false);
        assertSharedRemoteScope(remote);
    }
});

test('SIGWINCH is debounced to the exact live session before normal settlement', async () => {
    const terminal = terminalStreams();
    let releaseInput;
    const originalIterator = terminal.input[Symbol.asyncIterator].bind(terminal.input);
    terminal.input[Symbol.asyncIterator] = async function* delayedInput() {
        for await (const chunk of originalIterator()) yield chunk;
        await new Promise((resolve) => { releaseInput = resolve; });
    };
    const scenario = await runInteractive([], { terminal, resizeDebounceMs: 0 });
    await new Promise((resolve) => setImmediate(resolve));
    terminal.output.rows = 40;
    terminal.output.columns = 120;
    terminal.signals.emit('SIGWINCH');
    terminal.output.rows = 41;
    terminal.output.columns = 121;
    terminal.signals.emit('SIGWINCH');
    await new Promise((resolve) => setTimeout(resolve, 5));
    releaseInput();

    assert.equal(await scenario.running, 0);
    assert.deepEqual(
        scenario.ledger.filter((entry) => entry.operation === 'resize')
            .map(({ rows, columns }) => [rows, columns]),
        [[41, 121]],
    );
    assert.deepEqual(terminal.input.rawModes, [true, false]);
    exactScope(scenario.ledger);
});

test('detach settles independently from process exit and restores raw mode', async () => {
    const scenario = await runInteractive(['cli'], {
        hostOptions: {
            resultByKind: {
                'box-shell': { exitCode: 0, detached: true },
            },
        },
    });
    assert.equal(await scenario.running, 0);
    assert.match(scenario.terminal.errorOutput.text(), /detached.*exit status is not available/);
    assert.deepEqual(
        scenario.ledger.filter((entry) => entry.actor === OWNED).map((entry) => entry.operation),
        [
            'exec-create',
            'exec-start',
            'stdin-half-close',
            'stream-eof',
            'exec-detached-retained',
        ],
    );
    assert.deepEqual(scenario.terminal.input.rawModes, [true, false]);
    exactScope(scenario.ledger);
});

test('local SIGINT/SIGTERM/SIGHUP cancel once, map status, and restore terminal state', async () => {
    for (const [signal, expected] of Object.entries({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129 })) {
        const scenario = await runInteractive([], { hostOptions: { waitForAbort: true } });
        await new Promise((resolve) => setImmediate(resolve));
        scenario.terminal.signals.emit(signal);
        assert.equal(await scenario.running, expected, signal);
        assert.equal(
            scenario.ledger.filter((entry) => entry.operation === 'cancel').length,
            1,
            signal,
        );
        assert.deepEqual(scenario.terminal.input.rawModes, [true, false], signal);
        assert.equal(scenario.terminal.signals.eventNames().length, 0, signal);
        exactScope(scenario.ledger);
    }
});

test('caller cancellation and transport ambiguity restore raw mode without a CLI fallback', async () => {
    const caller = new AbortController();
    const scenario = await runInteractive([], {
        hostOptions: { waitForAbort: true },
        callerSignal: caller.signal,
    });
    await new Promise((resolve) => setImmediate(resolve));
    const reason = new Error('caller cancelled acceptance session');
    caller.abort(reason);
    await assert.rejects(scenario.running, reason);
    assert.deepEqual(scenario.terminal.input.rawModes, [true, false]);
    assert.equal(scenario.ledger.some((entry) => entry.operation === 'forbidden-host-cli'), false);
    exactScope(scenario.ledger);
});

test('malformed interactive settlement fails closed after restoring the terminal', async () => {
    for (const malformed of [
        null,
        { exitCode: -1, detached: false },
        { exitCode: 256, detached: false },
        { exitCode: 0 },
        { exitCode: 0, detached: 'false' },
    ]) {
        const terminal = terminalStreams();
        const scenario = await runInteractive([], {
            terminal,
            hostOptions: { resultByKind: { bare: malformed } },
        });
        await assert.rejects(scenario.running, /invalid settlement/i);
        assert.deepEqual(terminal.input.rawModes, [true, false]);
        assert.equal(scenario.ledger.some((entry) => entry.operation === 'forbidden-host-cli'), false);
        exactScope(scenario.ledger);
    }
});
