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

export class Phase10xRemoteClient {
    constructor({ containers = [], volumes = [], ownedIds = [], generatedIds = [] } = {}) {
        this.containers = new Map(containers.map((entry) => [assertId(entry.Id ?? entry.ID), clone(entry)]));
        this.volumes = new Map(volumes.map((entry) => [String(entry.Name), clone(entry)]));
        this.ownedIds = new Set(ownedIds.map(assertId));
        this.generatedIds = [...generatedIds];
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
}

export function createPhase10xRemoteClient(options) {
    return new Phase10xRemoteClient(options);
}
