const FULL_ID = /^[a-f0-9]{64}$/;
const CANONICAL_LIST = Object.freeze({
    all: true,
    sync: false,
    size: false,
    namespace: false,
});

function clone(value) {
    return structuredClone(value);
}

function assertId(id) {
    if (!FULL_ID.test(String(id || ''))) {
        throw new Error('fake requires a full 64-hex container ID');
    }
    return String(id);
}

function selectedProof(journal, id) {
    if (journal?.container?.id === id) return journal.container;
    if (journal?.predecessor?.id === id) return journal.predecessor.container;
    throw new Error('fake journal does not own exact selected container ID');
}

function assertStandalone(journal, id) {
    const selected = selectedProof(journal, id);
    if (!Array.isArray(selected?.creation?.dependencies)
        || selected.creation.dependencies.length !== 0) {
        throw new Error('fake refuses a target with dependencies');
    }
    if (selected.creation.autoRemove !== false) {
        throw new Error('fake refuses an auto-remove target');
    }
}

function assertExecUser(user) {
    const value = String(user || '');
    const [name] = value.split(':', 1);
    if (value.length === 0 || name === 'root' || /^0$/u.test(name)) {
        throw new Error('fake refuses a privileged exec user');
    }
    return value;
}

function assertTerminalDimension(value, label) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 65535) {
        throw new Error(`fake ${label} is outside terminal bounds`);
    }
    return value;
}

async function writeOutput(stream, value) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value || ''));
    if (bytes.length === 0) return;
    if (!stream || typeof stream.write !== 'function') {
        throw new Error('fake interactive exec output stream is unavailable');
    }
    if (!stream.write(bytes)) {
        await new Promise((resolve, reject) => {
            stream.once('drain', resolve);
            stream.once('error', reject);
        });
    }
}

async function readInput(stream) {
    if (stream === undefined || stream === null) return Buffer.alloc(0);
    const chunks = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
}

function abortError() {
    const error = new Error('fake interactive exec caller cancelled');
    error.code = 'PLOINKY_BOX_HOST_CANCELLED';
    return error;
}

function waitForAbort(signal) {
    if (!signal || typeof signal.addEventListener !== 'function') {
        throw new Error('fake wait-for-abort outcome requires an AbortSignal');
    }
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
        const aborted = () => reject(abortError());
        signal.addEventListener('abort', aborted, { once: true });
        void resolve;
    });
}

export class Phase10xRemoteClient {
    constructor({
        containers = [],
        volumes = [],
        ownedIds = [],
        generatedIds = [],
        generatedSessionIds = [],
        execOutcomes = [],
    } = {}) {
        this.containers = new Map(containers.map((entry) => [assertId(entry.Id ?? entry.ID), clone(entry)]));
        this.volumes = new Map(volumes.map((entry) => [String(entry.Name), clone(entry)]));
        this.ownedIds = new Set(ownedIds.map(assertId));
        this.generatedIds = [...generatedIds];
        this.generatedSessionIds = [...generatedSessionIds];
        this.execOutcomes = [...execOutcomes];
        this.execSessions = new Map();
        this.requestJournal = [];
        this.stateJournal = [];
        this.eventJournal = [];
        this.identity = Object.freeze({
            engine: 'podman',
            engineIdentity: '1'.repeat(64),
            connectionIdentity: 'phase10x-fake-machine',
            connectionUri: 'ssh://localhost/run/user/501/podman.sock',
            socketPath: '/tmp/phase10x-fake.sock',
            hostKind: 'podman-machine',
            apiVersion: 'v6.0.1',
        });
    }

    snapshot(reason) {
        this.stateJournal.push({
            reason,
            containers: clone([...this.containers.values()]),
            volumes: clone([...this.volumes.values()]),
        });
    }

    event(actor, status, transport = 'direct') {
        this.eventJournal.push({ actor, status, transport });
    }

    clearJournals() {
        this.requestJournal.length = 0;
        this.stateJournal.length = 0;
        this.eventJournal.length = 0;
    }

    async cliContainer(operation, id) {
        const target = assertId(id);
        this.requestJournal.push({ transport: 'cli', operation, id: target });
        if (operation === 'run') {
            // Characterize the hidden lifecycle bundled by `podman run --rm`.
            // Production must reject the command before invoking a remote CLI;
            // this fake deliberately records what would already have happened.
            const transient = '0'.repeat(64);
            if (this.containers.has(transient)) {
                throw new Error('fake transient run identity is unexpectedly occupied');
            }
            this.containers.set(transient, {
                Id: transient,
                Names: ['phase10x-unproven-run'],
                Image: target,
                ImageID: target,
                State: 'created',
                Status: 'created',
                Pid: 0,
                AutoRemove: true,
                Dependencies: [],
                Labels: {},
            });
            this.event(transient, 'create', 'cli');
            this.event(transient, 'start', 'cli');
            this.event(transient, 'wait', 'cli');
            this.containers.delete(transient);
            this.event(transient, 'remove', 'cli');
            this.snapshot('cli-run-remove');
            throw new Error('ordinary remote CLI run --rm is unproven and forbidden');
        }
        if (['logs', 'wait', 'exec', 'cp'].includes(operation)) {
            throw new Error(`ordinary remote CLI ${operation} is unproven and forbidden`);
        }
        if (operation === 'inspect') {
            if (this.containers.has(target)) this.event(target, 'sync', 'cli');
            throw new Error('ordinary remote CLI inspect is forbidden');
        }
        if (!['start', 'stop', 'rm'].includes(operation)) {
            throw new Error(`unknown fake CLI operation ${operation}`);
        }
        for (const actor of this.containers.keys()) this.event(actor, 'sync', 'cli');
        const selected = this.containers.get(target);
        if (!selected) throw new Error('selected fake container is absent');
        if (operation === 'start') {
            selected.State = 'running';
            selected.Status = 'running';
            selected.Pid = 42;
            this.event(target, 'init', 'cli');
            this.event(target, 'start', 'cli');
        } else if (operation === 'stop') {
            selected.State = 'exited';
            selected.Status = 'exited';
            selected.Pid = 0;
            this.event(target, 'died', 'cli');
            this.event(target, 'cleanup', 'cli');
        } else {
            this.containers.delete(target);
            this.event(target, 'remove', 'cli');
        }
        this.snapshot(`cli-${operation}`);
        return clone(selected);
    }

    async listContainers(options = CANONICAL_LIST) {
        if (JSON.stringify(options) !== JSON.stringify(CANONICAL_LIST)) {
            throw new Error('fake direct list requires exact sync=false options');
        }
        this.requestJournal.push({
            transport: 'direct',
            method: 'GET',
            path: '/v6.0.1/libpod/containers/json?all=true&sync=false&size=false&namespace=false',
        });
        return clone([...this.containers.values()]);
    }

    async findContainerById(id) {
        const target = assertId(id);
        const matches = (await this.listContainers()).filter((entry) => (entry.Id ?? entry.ID) === target);
        if (matches.length > 1) throw new Error('duplicate fake exact ID');
        return matches[0] || null;
    }

    async createContainer(spec) {
        this.requestJournal.push({ transport: 'direct', method: 'POST', operation: 'create', spec: clone(spec) });
        const id = assertId(this.generatedIds.shift() || 'f'.repeat(64));
        if (this.containers.has(id)) throw new Error('duplicate generated fake ID');
        const created = {
            Id: id,
            Names: [spec.name],
            Image: spec.image,
            ImageID: spec.image,
            State: 'created',
            Status: 'created',
            Pid: 0,
            AutoRemove: spec.remove,
            Dependencies: clone(spec.dependencyContainers),
            Labels: clone(spec.labels),
        };
        this.containers.set(id, created);
        this.ownedIds.add(id);
        this.event(id, 'create');
        this.snapshot('direct-create');
        return { id, warnings: [] };
    }

    async startContainer({ id, journal }) {
        const target = assertId(id);
        assertStandalone(journal, target);
        const selected = this.containers.get(target);
        if (!selected || !this.ownedIds.has(target)) throw new Error('fake start target is not exact owned');
        if ((selected.Dependencies || []).length !== 0) throw new Error('fake start target has dependencies');
        if (selected.AutoRemove !== false) throw new Error('fake start target is auto-remove');
        this.requestJournal.push({ transport: 'direct', method: 'POST', operation: 'start', id: target });
        selected.State = 'running';
        selected.Status = 'running';
        selected.Pid = 42;
        this.event(target, 'init');
        this.event(target, 'start');
        this.snapshot('direct-start');
        return { started: true, id: target };
    }

    async stopContainer({ id, timeout = 10, journal }) {
        const target = assertId(id);
        assertStandalone(journal, target);
        const selected = this.containers.get(target);
        if (!selected || !this.ownedIds.has(target)) throw new Error('fake stop target is not exact owned');
        this.requestJournal.push({ transport: 'direct', method: 'POST', operation: 'stop', id: target, timeout });
        selected.State = 'exited';
        selected.Status = 'exited';
        selected.Pid = 0;
        this.event(target, 'died');
        this.event(target, 'cleanup');
        this.snapshot('direct-stop');
        return { stopped: true, id: target };
    }

    async deleteContainer({ id, timeout = 10, journal }) {
        const target = assertId(id);
        assertStandalone(journal, target);
        const selected = this.containers.get(target);
        if (!selected || !this.ownedIds.has(target)) throw new Error('fake delete target is not exact owned');
        if (!['configured', 'created', 'exited', 'stopped'].includes(String(selected.State).toLowerCase())) {
            throw new Error('fake delete target is not proven stopped');
        }
        this.requestJournal.push({ transport: 'direct', method: 'DELETE', operation: 'delete', id: target, timeout });
        this.containers.delete(target);
        this.event(target, 'remove');
        this.snapshot('direct-delete');
        return { removed: true, id: target, absent: true };
    }

    async execContainerInteractive({
        id,
        argv,
        user = 'podman',
        workdir = '/workspace',
        env = {},
        journal,
        tty = false,
        detachKeys = '',
        rows,
        columns,
        stdin,
        stdout,
        stderr,
        signal,
        onSession,
    }) {
        const target = assertId(id);
        assertStandalone(journal, target);
        if (!this.ownedIds.has(target)) throw new Error('fake exec target is not exact owned');
        const selected = this.containers.get(target);
        if (!selected || String(selected.State).toLowerCase() !== 'running') {
            throw new Error('fake exec target is not proven running');
        }
        const nameCollision = [...this.containers.entries()].find(([containerId, entry]) => (
            containerId !== target
            && Array.isArray(entry.Names)
            && entry.Names.some((name) => String(name).replace(/^\//u, '') === target)
        ));
        if (nameCollision) {
            throw new Error('fake exec target full ID is shadowed by a foreign exact container name');
        }
        if (!Array.isArray(argv) || argv.length === 0
            || argv.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
            throw new Error('fake exec argv is invalid');
        }
        const execUser = assertExecUser(user);
        if (typeof workdir !== 'string' || !workdir.startsWith('/')) {
            throw new Error('fake exec working directory must be absolute');
        }
        if (!env || typeof env !== 'object' || Array.isArray(env)) {
            throw new Error('fake exec environment must be a map');
        }
        if (typeof tty !== 'boolean' || typeof detachKeys !== 'string') {
            throw new Error('fake exec terminal configuration is invalid');
        }
        const initialRows = tty ? assertTerminalDimension(rows, 'terminal rows') : 0;
        const initialColumns = tty ? assertTerminalDimension(columns, 'terminal columns') : 0;
        if (onSession !== undefined && typeof onSession !== 'function') {
            throw new Error('fake exec session callback must be a function');
        }
        if (signal?.aborted) throw abortError();

        const sessionId = assertId(this.generatedSessionIds.shift() || '9'.repeat(64));
        if (this.execSessions.has(sessionId)) throw new Error('duplicate generated fake exec session ID');
        const outcome = this.execOutcomes.shift() || {};
        const bindingId = assertId(outcome.containerId || target);
        const reportedSessionId = assertId(outcome.sessionId || sessionId);
        const session = {
            id: sessionId,
            containerId: bindingId,
            running: false,
            removed: false,
            tty,
        };
        this.execSessions.set(sessionId, session);
        this.requestJournal.push({
            transport: 'direct',
            method: 'POST',
            operation: 'exec-create',
            path: `/v6.0.1/libpod/containers/${target}%25/exec`,
            actor: target,
            id: target,
            sessionId,
            spec: {
                AttachStdin: stdin !== undefined && stdin !== null,
                AttachStdout: true,
                AttachStderr: true,
                DetachKeys: detachKeys,
                Tty: tty,
                Env: Object.entries(env).map(([key, value]) => `${key}=${value}`),
                Cmd: [...argv],
                Privileged: false,
                User: execUser,
                WorkingDir: workdir,
            },
        });
        this.requestJournal.push({
            transport: 'direct',
            method: 'GET',
            operation: 'exec-inspect-pre',
            path: `/v6.0.1/libpod/exec/${reportedSessionId}/json`,
            actor: reportedSessionId,
            id: reportedSessionId,
            sessionId: reportedSessionId,
            observedContainerId: bindingId,
        });
        if (bindingId !== target || reportedSessionId !== sessionId) {
            throw new Error('fake exec pre-start binding proof failed');
        }

        let live = false;
        const controller = Object.freeze({
            sessionId,
            resize: async (nextRows, nextColumns) => {
                if (!tty) throw new Error('fake cannot resize a non-TTY exec session');
                if (!live || !session.running) throw new Error('fake cannot resize a non-running exec session');
                const height = assertTerminalDimension(nextRows, 'terminal rows');
                const width = assertTerminalDimension(nextColumns, 'terminal columns');
                this.requestJournal.push({
                    transport: 'direct',
                    method: 'GET',
                    operation: 'exec-inspect-resize',
                    path: `/v6.0.1/libpod/exec/${sessionId}/json`,
                    actor: sessionId,
                    id: sessionId,
                    sessionId,
                    observedContainerId: target,
                });
                this.requestJournal.push({
                    transport: 'direct',
                    method: 'POST',
                    operation: 'exec-resize',
                    path: `/v6.0.1/libpod/exec/${sessionId}/resize?h=${height}&w=${width}&running=false`,
                    actor: sessionId,
                    id: sessionId,
                    sessionId,
                    containerId: target,
                    rows: height,
                    columns: width,
                    running: false,
                });
                if (outcome.resizeError) throw outcome.resizeError;
                return { rows: height, columns: width };
            },
        });
        this.requestJournal.push({
            transport: 'direct',
            method: 'POST',
            operation: 'exec-start',
            path: `/v6.0.1/libpod/exec/${sessionId}/start`,
            actor: sessionId,
            id: sessionId,
            sessionId,
            containerId: target,
            tty,
            rows: initialRows,
            columns: initialColumns,
        });
        if (outcome.startError) throw outcome.startError;
        live = true;
        session.running = true;
        this.event(target, 'exec');
        if (onSession) onSession(controller);

        const inputBytes = await readInput(stdin);
        this.requestJournal.push({
            transport: 'direct',
            method: 'STREAM',
            operation: 'exec-stdin',
            actor: sessionId,
            id: sessionId,
            sessionId,
            containerId: target,
            bytes: inputBytes,
        });
        this.requestJournal.push({
            transport: 'direct',
            method: 'STREAM',
            operation: 'exec-write-half-close',
            actor: sessionId,
            id: sessionId,
            sessionId,
            containerId: target,
        });
        if (outcome.waitFor) await outcome.waitFor;
        if (outcome.waitForAbort) await waitForAbort(signal);
        if (outcome.error) throw outcome.error;
        if (tty) {
            await writeOutput(stdout, outcome.ttyBytes ?? outcome.stdout ?? Buffer.alloc(0));
        } else {
            await writeOutput(stdout, outcome.stdout ?? Buffer.alloc(0));
            await writeOutput(stderr, outcome.stderr ?? Buffer.alloc(0));
        }

        const detached = outcome.detached === true;
        session.running = detached;
        live = detached;
        this.requestJournal.push({
            transport: 'direct',
            method: 'GET',
            operation: 'exec-inspect-final',
            path: `/v6.0.1/libpod/exec/${sessionId}/json`,
            actor: sessionId,
            id: sessionId,
            sessionId,
            observedContainerId: target,
            running: detached,
        });
        if (detached) return { exitCode: 0, detached: true };

        const exitCode = outcome.exitCode ?? 0;
        if (!Number.isSafeInteger(exitCode)) throw new Error('fake exec exit code is invalid');
        this.requestJournal.push({
            transport: 'direct',
            method: 'POST',
            operation: 'exec-remove',
            path: `/v6.0.1/libpod/exec/${sessionId}/remove`,
            actor: sessionId,
            id: sessionId,
            sessionId,
            containerId: target,
            force: false,
        });
        if (outcome.cleanupError) throw outcome.cleanupError;
        session.removed = true;
        this.execSessions.delete(sessionId);
        return { exitCode, detached: false };
    }
}

export function createPhase10xRemoteClient(options) {
    return new Phase10xRemoteClient(options);
}
