import assert from 'node:assert/strict';
import test from 'node:test';

import {
    ROUTER_AUTHORITY_HELPER_IMAGE,
    ROUTER_AUTHORITY_HELPER_MAX_LIFETIME_MS,
    runContainerAuthorityProbe,
} from '../../cli/sandbox/routerAuthorityAttestation.js';
import {
    AUTHORITY_ATTESTATION_TTL_MS,
    createRouterAuthorityAttestationRegistry,
} from '../../cli/server/routerAuthorityAttestationRegistry.js';

const NONCE = 'a'.repeat(64);
const GENERATION_LEASE_ID = `sha256:${'b'.repeat(64)}`;
const TARGET_IMAGE = 'example.invalid/agent@sha256:fixture';
const TARGET_IMAGE_ID = `sha256:${'c'.repeat(64)}`;
const HELPER_IMAGE_ID = `sha256:${'d'.repeat(64)}`;
const HELPER_ID = 'e'.repeat(64);
const NETWORK = 'fixture-network';
const HOST_MAPPING = 'host.containers.internal:host-gateway';
const PLAN = Object.freeze({
    alias: 'fixture-agent',
    attachments: Object.freeze([{ name: NETWORK, primary: true }]),
    args: Object.freeze([
        '--network', NETWORK,
        '--network-alias', 'fixture-agent',
        '--add-host', HOST_MAPPING,
    ]),
});
const INTENT = Object.freeze({
    physicalOrigin: 'http://host.containers.internal:8080',
    requestAuthority: '127.0.0.1:18080',
    publicAuthority: '127.0.0.1:18080',
});
const EXTERNAL = Object.freeze([
    { host: '127.0.0.1:18080', status: 401, body: '{"error":"fixture"}' },
    { host: 'host.containers.internal:8080', status: 421, body: '{"error":"UNKNOWN_HOST"}' },
]);

function ok(stdout = '') {
    return { status: 0, stdout, stderr: '' };
}

function failed(message = 'fixture failure') {
    return { status: 1, stdout: '', stderr: message };
}

class FakeAuthorityRuntime {
    constructor(options = {}) {
        this.options = options;
        this.clock = options.clock ?? 1_000_000;
        this.events = [];
        this.containers = new Map();
        this.pending = null;
        this.inspectCount = 0;
        this.nextId = HELPER_ID;
    }

    now() {
        return this.clock;
    }

    sleep(milliseconds) {
        this.events.push('sleep');
        this.clock += milliseconds;
        if (this.pending && this.events.filter((event) => event === 'sleep').length >= (this.options.delayedCreateSleep ?? 1)) {
            this.containers.set(this.pending.id, this.pending);
            this.pending = null;
        }
    }

    seedHelper({ nonce, id, running, createdAt }) {
        this.containers.set(id, this.makeContainer({
            id,
            nonce,
            name: `ploinky-authority-${nonce.slice(0, 16)}`,
            running,
            createdAt,
        }));
    }

    makeContainer({ id = this.nextId, nonce = NONCE, name = `ploinky-authority-${nonce.slice(0, 16)}`, running = false, createdAt = this.clock } = {}) {
        return {
            id,
            name,
            created: new Date(createdAt).toISOString(),
            image: HELPER_IMAGE_ID,
            user: '65534:65534',
            entrypoint: ['node'],
            init: true,
            readonlyRootfs: true,
            pidsLimit: 32,
            memory: 64 * 1024 * 1024,
            nanoCpus: 250_000_000,
            networkMode: NETWORK,
            extraHosts: [HOST_MAPPING],
            mountCount: 0,
            bindCount: 0,
            tmpfsCount: 0,
            portBindingCount: 0,
            capDrop: ['ALL'],
            capAdd: [],
            securityOpt: ['no-new-privileges'],
            env: ['PATH=/usr/bin'],
            helperLabel: nonce,
            networks: { [NETWORK]: {} },
            running,
            status: running ? 'running' : 'created',
        };
    }

    findContainer(reference) {
        return this.containers.get(reference)
            || [...this.containers.values()].find((container) => container.name === reference)
            || null;
    }

    run(_command, args) {
        if (args[0] === 'image' && args[1] === 'inspect') {
            const reference = args.at(-1);
            if (args.includes('{{.Config.User}}')) {
                this.events.push('target-user');
                return ok('1000:1000');
            }
            if (reference === ROUTER_AUTHORITY_HELPER_IMAGE) {
                this.events.push('helper-image');
                return ok(HELPER_IMAGE_ID);
            }
            this.events.push('target-image');
            return ok(TARGET_IMAGE_ID);
        }
        if (args[0] === 'ps') {
            this.events.push('stale-list');
            return ok([...this.containers.keys()].join('\n'));
        }
        if (args[0] === 'create') {
            this.events.push('create');
            assert.match(args.at(-1), /setTimeout\(\(\) => process\.exit\(0\), 60000\)/);
            const name = args[args.indexOf('--name') + 1];
            const label = args[args.indexOf('--label') + 1];
            const nonce = label.slice(label.indexOf('=') + 1);
            const container = this.makeContainer({ name, nonce });
            if (this.options.createTimeout) {
                this.pending = container;
                return { status: null, stdout: '', stderr: '', error: new Error('create timed out') };
            }
            this.containers.set(container.id, container);
            return ok(container.id);
        }
        if (args[0] === 'container' && args[1] === 'inspect') {
            this.events.push('inspect');
            const container = this.findContainer(args.at(-1));
            if (!container) return failed('missing container');
            this.inspectCount += 1;
            const projected = structuredClone(container);
            if (this.inspectCount === this.options.mutateInspectAt) {
                Object.assign(projected, this.options.inspectMutation || {});
            }
            return ok(JSON.stringify(projected));
        }
        if (args[0] === 'start') {
            this.events.push('start');
            if (this.options.startFailure) return failed('start failed');
            const container = this.findContainer(args[1]);
            container.running = true;
            container.status = 'running';
            this.clock += this.options.startDelayMs || 0;
            return ok();
        }
        if (args[0] === 'exec') {
            this.events.push('exec');
            this.clock += this.options.execDelayMs || 0;
            if (typeof this.options.onExec === 'function') this.options.onExec();
            if (this.options.execFailure) return failed(this.options.execFailure);
            return ok(this.options.execOutput ?? JSON.stringify(EXTERNAL));
        }
        if (args[0] === 'stop') {
            this.events.push('stop');
            const container = this.findContainer(args.at(-1));
            if (!container) return failed('missing container');
            container.running = false;
            container.status = 'exited';
            return ok();
        }
        if (args[0] === 'rm') {
            this.events.push('rm');
            const container = this.findContainer(args[1]);
            if (!container) return failed('missing container');
            this.containers.delete(container.id);
            return ok();
        }
        if (args[0] === 'container' && args[1] === 'exists') {
            this.events.push('exists');
            return this.findContainer(args[2]) ? ok() : failed('absent');
        }
        throw new Error(`unexpected fake runtime command: ${args.join(' ')}`);
    }
}

function observation() {
    return {
        rawHost: '127.0.0.1:18080',
        normalizedHost: '127.0.0.1',
        effectiveListener: 'public',
        rawInterfaceClass: 'loopback',
        socketLocalAddress: '127.0.0.1',
        socketRemoteAddress: '127.0.0.1',
        routePlanOk: true,
        routePlanStatus: 200,
        routePlanCode: null,
        hostSelectionKind: null,
        controlMiss: false,
        generationLeaseId: GENERATION_LEASE_ID,
    };
}

function lifecycle(runtime) {
    const registry = createRouterAuthorityAttestationRegistry({ now: () => runtime.now() });
    const recorded = [];
    runtime.options.onExec = () => {
        recorded.push(registry.record(NONCE, observation()));
        recorded.push(registry.record(NONCE, observation()));
    };
    return {
        recorded,
        registerObservation() {
            runtime.events.push('register');
            const result = registry.register(NONCE, GENERATION_LEASE_ID);
            if (!result.ok) throw new Error(`registry-register:${result.status}`);
        },
        consumeObservation() {
            runtime.events.push('consume');
            const result = registry.consume(NONCE);
            if (!result.ok) throw new Error(`registry-consume:${result.status}`);
            return result.records;
        },
    };
}

function runProbe(runtime, overrides = {}) {
    const registryLifecycle = lifecycle(runtime);
    return {
        registryLifecycle,
        invoke() {
            return runContainerAuthorityProbe({
                runtime: 'podman',
                plan: PLAN,
                image: TARGET_IMAGE,
                intent: INTENT,
                nonce: NONCE,
                commandRunner: runtime,
                registerObservation: overrides.registerObservation || registryLifecycle.registerObservation,
                consumeObservation: overrides.consumeObservation || registryLifecycle.consumeObservation,
            });
        },
    };
}

test('production helper orchestration preserves exact lifecycle order and immutable cleanup', () => {
    const runtime = new FakeAuthorityRuntime();
    const { invoke, registryLifecycle } = runProbe(runtime);
    const result = invoke();
    assert.equal(result.helper.id, HELPER_ID);
    assert.deepEqual(registryLifecycle.recorded, [true, true]);
    assert.deepEqual(runtime.events, [
        'target-image', 'target-user', 'helper-image', 'stale-list',
        'create', 'inspect', 'start', 'inspect', 'register', 'exec', 'consume',
        'inspect', 'stop', 'inspect', 'rm', 'exists', 'exists',
    ]);
    assert.equal(runtime.containers.size, 0);
});

test('cold start longer than the nonce TTL occurs before production registration', () => {
    const runtime = new FakeAuthorityRuntime({ startDelayMs: AUTHORITY_ATTESTATION_TTL_MS + 2_000 });
    const { invoke, registryLifecycle } = runProbe(runtime);
    invoke();
    assert.deepEqual(registryLifecycle.recorded, [true, true]);
    assert.ok(runtime.events.indexOf('start') < runtime.events.indexOf('register'));
});

test('exec that exceeds the nonce TTL fails closed and still removes the helper', () => {
    const runtime = new FakeAuthorityRuntime({ execDelayMs: AUTHORITY_ATTESTATION_TTL_MS + 1 });
    const { invoke, registryLifecycle } = runProbe(runtime);
    assert.throws(invoke, /registry-consume:(?:not-found|404)/);
    assert.deepEqual(registryLifecycle.recorded, [false, false]);
    assert.equal(runtime.containers.size, 0);
});

test('initial confinement mismatch prevents registration and removes the created helper', () => {
    const runtime = new FakeAuthorityRuntime({ mutateInspectAt: 1, inspectMutation: { user: '0:0' } });
    const { invoke } = runProbe(runtime);
    assert.throws(invoke, /identity or confinement could not be proven/);
    assert.equal(runtime.events.includes('register'), false);
    assert.equal(runtime.containers.size, 0);
});

test('start failure removes the exact created helper without registering', () => {
    const runtime = new FakeAuthorityRuntime({ startFailure: true });
    const { invoke } = runProbe(runtime);
    assert.throws(invoke, /bounded helper operation failed/);
    assert.equal(runtime.events.includes('register'), false);
    assert.equal(runtime.containers.size, 0);
});

test('running re-inspection mismatch prevents registration and cleans up', () => {
    const runtime = new FakeAuthorityRuntime({ mutateInspectAt: 2, inspectMutation: { helperLabel: 'f'.repeat(64) } });
    const { invoke } = runProbe(runtime);
    assert.throws(invoke, /identity or confinement could not be proven/);
    assert.equal(runtime.events.includes('register'), false);
    assert.equal(runtime.containers.size, 0);
});

test('malformed probe output and consume failure both clean up exactly', () => {
    for (const mode of ['malformed', 'consume']) {
        const runtime = new FakeAuthorityRuntime(mode === 'malformed' ? { execOutput: 'not-json' } : {});
        const prepared = mode === 'consume'
            ? runProbe(runtime, { consumeObservation: () => { runtime.events.push('consume'); throw new Error('consume failed'); } })
            : runProbe(runtime);
        assert.throws(prepared.invoke, mode === 'malformed' ? /malformed/ : /consume failed/);
        assert.equal(runtime.containers.size, 0, mode);
    }
});

test('create timeout reconciles delayed completion by name and removes the proven immutable ID', () => {
    const runtime = new FakeAuthorityRuntime({ createTimeout: true, delayedCreateSleep: 2 });
    const { invoke } = runProbe(runtime);
    assert.throws(invoke, /bounded helper operation failed/);
    assert.equal(runtime.events.filter((event) => event === 'sleep').length, 2);
    assert.equal(runtime.events.includes('rm'), true);
    assert.equal(runtime.containers.size, 0);
});

test('stale reconciliation removes old or exited helpers but preserves a young live probe', () => {
    const runtime = new FakeAuthorityRuntime();
    const oldNonce = '1'.repeat(64);
    const exitedNonce = '2'.repeat(64);
    const youngNonce = '3'.repeat(64);
    runtime.seedHelper({
        nonce: oldNonce,
        id: '1'.repeat(64),
        running: true,
        createdAt: runtime.now() - ROUTER_AUTHORITY_HELPER_MAX_LIFETIME_MS - 20_000,
    });
    runtime.seedHelper({ nonce: exitedNonce, id: '2'.repeat(64), running: false, createdAt: runtime.now() });
    runtime.seedHelper({ nonce: youngNonce, id: '3'.repeat(64), running: true, createdAt: runtime.now() });
    runProbe(runtime).invoke();
    assert.equal(runtime.findContainer('1'.repeat(64)), null);
    assert.equal(runtime.findContainer('2'.repeat(64)), null);
    assert.notEqual(runtime.findContainer('3'.repeat(64)), null);
});

test('cleanup identity mismatch never stops or removes an ambiguous container', () => {
    const runtime = new FakeAuthorityRuntime({
        execFailure: 'probe failed',
        mutateInspectAt: 3,
        inspectMutation: { image: `sha256:${'f'.repeat(64)}` },
    });
    const { invoke } = runProbe(runtime);
    assert.throws(invoke, /identity or confinement could not be proven/);
    assert.equal(runtime.events.includes('stop'), false);
    assert.equal(runtime.events.includes('rm'), false);
    assert.equal(runtime.containers.size, 1);
});
