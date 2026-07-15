#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    BOX_ROUTER_PORT,
    IDENTITY_SCHEMA_LABEL,
    IDENTITY_SCHEMA_VERSION,
    EXPLICIT_PUBLISHES_LABEL,
    GENERATED_PUBLISHES_LABEL,
    PATH_HASH_LABEL,
    PUBLISH_PLAN_VERSION_LABEL,
    REQUESTED_IMAGE_LABEL,
    REQUIRED_IMAGE_ENV,
    REQUIRED_RUNTIME_IMAGE,
    REQUIRED_PUBLISH_PLAN_VERSION,
    RUNTIME_CONTRACT_LABEL,
    VOLUME_ROLE_LABEL,
    VOLUME_ROLES,
    buildRuntimeRunArgs,
    createDefaultRuntimeConfig,
    diffRuntimeConfig,
    mergeAndValidatePublishes,
    mergeDesiredRuntimeConfig,
    normalizeContainerInspect,
    normalizeImageInspect,
    planReconciliation,
    runtimeVolumeNames,
    validateImageContract,
} from './runtime-contract.mjs';
import { createEngineClient } from './runtime-engine.mjs';
import {
    applyAuthoritativePublicationPlan,
    assertStateCommandFlags,
    createRuntimeSupervisor,
    forwardCoreCommand,
    hostRuntimeLockPath,
    parseHostInvocation,
    publicationContractForPlan,
    publicUsageText,
    resolveEngineOwnership,
    resolveHostPloinkySource,
    resolveInstanceIdentity,
    routeHostInvocation,
    runSupervisorWithBoundary,
    shouldInstallDeps,
    withHostRuntimeLock,
    inferPublicStartBranchArgs,
    validateNestedGidMap,
    validateNestedUidMap,
} from './runtime-supervisor.mjs';
import {
    contract1Image,
    contract2Container,
    contract2Image,
    contract2RuntimeFixture,
    createFakeEngine,
    createSupervisorHarness,
    identityFor,
    ownedVolume,
} from '../tests/helpers/runtimeSupervisorHarness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const PLOINKY = path.join(REPO_ROOT, 'bin', 'ploinky');
const PCLI = path.join(REPO_ROOT, 'bin', 'p-cli');
const PSH = path.join(REPO_ROOT, 'bin', 'psh');
const INSTALL_DEPS = path.join(REPO_ROOT, 'bin', 'ploinky-install-deps');
const SUPERVISOR = path.join(REPO_ROOT, 'container', 'runtime-supervisor.mjs');

function runCalls(harness, command) {
    return harness.calls.filter(call => call.kind === 'run' && call.args[0] === command);
}

function mutationCalls(fake) {
    return fake.calls.filter(call => call.kind === 'run');
}

function rawVolumeSet(identity, roles = Object.keys(VOLUME_ROLES)) {
    const names = runtimeVolumeNames(identity.instance);
    return Object.fromEntries(roles.map(role => {
        const volume = ownedVolume(names[role], identity.pathHash, role);
        return [volume.Name, volume];
    }));
}

function invocationFor(cwd = '/workspace/demo') {
    return {
        ...identityFor(cwd),
        image: REQUIRED_RUNTIME_IMAGE,
        port: '8080',
        publish: [],
        explicit: new Set(),
        sourceDirResolved: '/source/ploinky',
        mountDirResolved: '',
        listenLan: false,
    };
}

function writableBuffer() {
    let value = '';
    return {
        stream: { isTTY: false, write(chunk) { value += String(chunk); return true; } },
        text: () => value,
    };
}

function makeFakeNodeCapture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-node-capture-'));
    const capture = path.join(dir, 'argv.txt');
    const executable = path.join(dir, 'node');
    fs.writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' "$@" > "$CAPTURE_FILE"\n`);
    fs.chmodSync(executable, 0o755);
    return { dir, capture };
}

function capturedArgv(capture) {
    return fs.readFileSync(capture, 'utf8').trimEnd().split('\n');
}

test('contract-4 image normalizes and validates every required metadata field', () => {
    const normalized = normalizeImageInspect(JSON.stringify([contract2Image()]));
    assert.equal(normalized.id, 'sha256:runtime-2');
    assert.equal(normalized.contract, '4');
    assert.deepEqual(normalized.env, REQUIRED_IMAGE_ENV);
    assert.equal(validateImageContract(normalized, REQUIRED_RUNTIME_IMAGE), normalized);
});

test('contract-4 validation emits field-specific failures', async t => {
    const cases = [
        ['image ID', raw => { raw.Id = ''; }, /image ID/],
        ['contract label', raw => { delete raw.Config.Labels[RUNTIME_CONTRACT_LABEL]; }, /runtime-contract/],
        ['user', raw => { raw.Config.User = 'root'; }, /Config\.User/],
        ['required env missing', raw => {
            raw.Config.Env = raw.Config.Env.filter(value => !value.startsWith('HOME='));
        }, /Config\.Env HOME/],
        ['required env wrong', raw => {
            raw.Config.Env = raw.Config.Env.map(value => value.startsWith('PATH=') ? 'PATH=/usr/bin' : value);
        }, /Config\.Env PATH/],
        ['extra env', raw => { raw.Config.Env.push('SURPRISE=1'); }, /Config\.Env/],
        ['working directory', raw => { raw.Config.WorkingDir = '/'; }, /Config\.WorkingDir/],
        ['entrypoint value', raw => { raw.Config.Entrypoint = ['/bin/sh']; }, /Config\.Entrypoint/],
        ['entrypoint shape', raw => { raw.Config.Entrypoint = '/usr/local/bin/ploinky-box-entrypoint'; }, /Config\.Entrypoint/],
        ['command', raw => { raw.Config.Cmd = ['bash']; }, /Config\.Cmd/],
        ['declared volume', raw => { raw.Config.Volumes = { '/home/podman': {} }; }, /Config\.Volumes/],
    ];
    for (const [name, mutate, pattern] of cases) {
        await t.test(name, () => {
            const raw = contract2Image();
            mutate(raw);
            assert.throws(
                () => validateImageContract(normalizeImageInspect(raw), REQUIRED_RUNTIME_IMAGE),
                pattern,
            );
        });
    }
});

test('runtime creation args pin the validated ID and label the logical reference', () => {
    const invocation = invocationFor();
    const config = createDefaultRuntimeConfig(invocation);
    config.imageId = 'sha256:validated';
    const args = buildRuntimeRunArgs(config, { engine: 'podman' });
    assert.equal(args.at(-1), 'sha256:validated');
    assert.ok(args.includes(`${REQUESTED_IMAGE_LABEL}=${REQUIRED_RUNTIME_IMAGE}`));
    assert.ok(args.includes(`${IDENTITY_SCHEMA_LABEL}=${IDENTITY_SCHEMA_VERSION}`));
    assert.ok(args.includes(`${PATH_HASH_LABEL}=${invocation.pathHash}`));
    for (const name of Object.values(runtimeVolumeNames(invocation.instance))) {
        assert.ok(args.some(value => value.startsWith(`${name}:`)), name);
    }
});

test('outer options stop at the first command and downstream argv remains exact', () => {
    const argv = [
        '--port=9192', '--publish', '127.0.0.1:9000:9000/udp',
        'client', 'tool', 'demo', '--port', '44', '--image=x', '--name', 'agent', '--engine=docker',
    ];
    const parsed = parseHostInvocation(argv, { PLOINKY_BOX_ENGINE: 'docker' });
    assert.equal(parsed.port, '9192');
    assert.deepEqual(parsed.publish, ['127.0.0.1:9000:9000/udp']);
    assert.equal(parsed.command, 'client');
    assert.deepEqual(parsed.args, argv.slice(4));
    assert.deepEqual(routeHostInvocation(parsed).forwardedArgs, ['client', ...argv.slice(4)]);
});

test('double dash permits a downstream command beginning with an option', () => {
    const parsed = parseHostInvocation(['--port', '9192', '--', '--agent-field', 'x']);
    assert.equal(parsed.command, '--agent-field');
    assert.deepEqual(parsed.args, ['x']);
});

test('every outer-option spelling remains an ordinary downstream token after the boundary', () => {
    const tails = [
        ['--port', '9000'], ['--port=9000'],
        ['--publish', '9000:9000'], ['--publish=9000:9000'],
        ['--expose', '9001:9001'], ['--expose=9001:9001'],
        ['--image', 'example/image:tag'], ['--image=example/image:tag'],
        ['--mount', '/tmp/data'], ['--mount=/tmp/data'],
        ['--listen-lan'], ['--dry-run'], ['--help'], ['-h'],
    ];
    for (const tail of tails) {
        const parsed = parseHostInvocation(['cli', 'agent', ...tail]);
        assert.equal(parsed.command, 'cli');
        assert.deepEqual(parsed.args, ['agent', ...tail]);
    }
    const repeated = parseHostInvocation([
        '--publish', '9000:9000', '--expose=9001:9001',
        '--publish', '9002:9002', 'list', 'agents',
    ]);
    assert.deepEqual(repeated.publish, ['9000:9000', '9001:9001', '9002:9002']);
    assert.deepEqual(repeated.args, ['agents']);
});

test('removed public selectors fail only when they occupy the outer prefix', () => {
    assert.throws(() => parseHostInvocation(['--name', 'demo', 'status']), /no longer supported/);
    assert.throws(() => parseHostInvocation(['--engine=docker', 'status']), /no longer supported/);
    const parsed = parseHostInvocation(['client', 'tool', '--name', 'demo', '--engine=docker']);
    assert.deepEqual(parsed.args, ['tool', '--name', 'demo', '--engine=docker']);
});

test('state commands reject creation flags and lifecycle tails', () => {
    const prefixed = parseHostInvocation(['--image', 'example/image:tag', 'status']);
    assert.throws(() => assertStateCommandFlags(prefixed), /--image/);
    const tailed = parseHostInvocation(['destroy', '--force']);
    assert.throws(() => assertStateCommandFlags(tailed), /unexpected trailing argument/);
});

test('start-tail --port forms fail before engine discovery or mutation', async t => {
    for (const tail of [['--port', '9192'], ['--port=9192']]) {
        await t.test(tail.join(' '), async () => {
            const harness = createSupervisorHarness();
            assert.equal(await harness.supervisor.run(['start', 'explorer', ...tail]), 1);
            assert.match(harness.stderr, /must precede 'start'/);
            assert.equal(harness.calls.length, 0);
        });
    }
});

test('malformed public start positional ports fail before planning, pulling, or mutation', async t => {
    for (const value of ['+9192', '9192junk', '1.5', '-1', ' 9192 ', '0', '65536']) {
        await t.test(JSON.stringify(value), async () => {
            let plannerCalls = 0;
            const harness = createSupervisorHarness({
                preparePublicationPlan: async () => {
                    plannerCalls += 1;
                    throw new Error('planner must not run');
                },
            });
            assert.equal(await harness.supervisor.run(['start', 'explorer', value]), 1);
            assert.match(harness.stderr, /exact unsigned decimal string|range 1\.\.65535/);
            assert.equal(plannerCalls, 0);
            assert.equal(runCalls(harness, 'pull').length, 0);
            assert.equal(mutationCalls(harness).length, 0);
        });
    }
});

test('outer --port is strict and normalized before publication', async () => {
    const invalid = createSupervisorHarness();
    assert.equal(await invalid.supervisor.run(['--port', ' 9192 ', 'list']), 1);
    assert.match(invalid.stderr, /exact unsigned decimal string/);
    assert.equal(mutationCalls(invalid).length, 0);

    const normalized = createSupervisorHarness({ fetchResponse: { ok: true } });
    assert.equal(await normalized.supervisor.run(['--port', '019192', 'start', 'explorer']), 0);
    const creation = runCalls(normalized, 'run').at(-1);
    assert.ok(creation.args.includes('127.0.0.1:19192:8080'));
    assert.equal(creation.args.some(arg => String(arg).includes('019192')), false);
});

test('non-start post-command port tokens are forwarded byte-for-byte', async () => {
    const fixture = contract2RuntimeFixture();
    const harness = createSupervisorHarness(fixture);
    const tail = ['tool', 'sample', '--port', '0', '--port=9192'];
    assert.equal(await harness.supervisor.run(['client', ...tail]), 0);
    const call = runCalls(harness, 'exec').at(-1);
    const core = call.args.indexOf('ploinky');
    assert.deepEqual(call.args.slice(core), ['ploinky', 'client', ...tail]);
});

test('exact-directory identity is stable through symlinks and separates directories', () => {
    const linked = resolveInstanceIdentity({}, '/tmp/link', () => '/srv/projects/demo');
    const real = resolveInstanceIdentity({}, '/srv/projects/demo', value => value);
    assert.equal(linked.instance, real.instance);
    const left = resolveInstanceIdentity({}, '/one/demo', value => value);
    const right = resolveInstanceIdentity({}, '/two/demo', value => value);
    const child = resolveInstanceIdentity({}, '/one/demo/child', value => value);
    const moved = resolveInstanceIdentity({}, '/one/renamed', value => value);
    assert.notEqual(left.instance, right.instance);
    assert.notEqual(left.instance, child.instance);
    assert.notEqual(left.instance, moved.instance);
    assert.match(left.instance, /^ploinky-box-demo-[a-f0-9]{12}$/);
    assert.deepEqual(Object.values(runtimeVolumeNames(left.instance)), [
        `${left.instance}-workspace`,
        `${left.instance}-containers`,
        `${left.instance}-ploinky-deps`,
    ]);
});

test('host runtime lock serializes one exact directory and permits a different directory', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-host-runtime-lock-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const first = identityFor('/workspace/first');
    const second = identityFor('/workspace/second');
    const options = {
        rootDir: root,
        timeoutMs: 1000,
        retryMs: 10,
        staleGraceMs: 10,
    };
    let releaseFirst;
    let firstEntered = false;
    let sameEntered = false;
    let otherEntered = false;
    const gate = new Promise(resolve => { releaseFirst = resolve; });
    const holding = withHostRuntimeLock(first, async () => {
        firstEntered = true;
        await gate;
    }, options);
    while (!firstEntered) await new Promise(resolve => setTimeout(resolve, 1));
    const same = withHostRuntimeLock(first, async () => { sameEntered = true; }, options);
    const other = withHostRuntimeLock(second, async () => { otherEntered = true; }, options);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(sameEntered, false);
    assert.equal(otherEntered, true);
    releaseFirst();
    await Promise.all([holding, same, other]);
    assert.equal(sameEntered, true);
    assert.equal(fs.existsSync(hostRuntimeLockPath(first, options)), false);
    assert.equal(fs.existsSync(hostRuntimeLockPath(second, options)), false);
});

test('host runtime lock recovers a dead owner without stealing a live lock', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-host-runtime-stale-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const invocation = identityFor('/workspace/stale');
    const options = {
        rootDir: root,
        timeoutMs: 1000,
        retryMs: 10,
        staleGraceMs: 0,
    };
    const lockPath = hostRuntimeLockPath(invocation, options);
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
        token: 'dead',
        pid: 999_999,
        canonicalPath: invocation.canonicalPath,
        acquiredAt: '2000-01-01T00:00:00.000Z',
    }));
    let entered = false;
    await withHostRuntimeLock(invocation, async () => { entered = true; }, options);
    assert.equal(entered, true);
    assert.equal(fs.existsSync(lockPath), false);
});

test('PLOINKY_BOX_ENGINE cannot influence parsing or empty-identity selection', () => {
    assert.equal(parseHostInvocation([], { PLOINKY_BOX_ENGINE: 'docker' }).engine, '');
    const invocation = invocationFor();
    const podman = createFakeEngine({ engine: 'podman' });
    const docker = createFakeEngine({ engine: 'docker' });
    const selected = resolveEngineOwnership(invocation, {
        env: { PLOINKY_BOX_ENGINE: 'docker' },
        installedEngines: ['podman', 'docker'],
        engineClients: { podman: podman.engineClient, docker: docker.engineClient },
    });
    assert.equal(selected.engine, 'podman');
});

test('cross-engine discovery selects the sole complete or partial resource owner', async t => {
    for (const owner of ['podman', 'docker']) {
        await t.test(owner, () => {
            const invocation = invocationFor();
            const names = runtimeVolumeNames(invocation.instance);
            const ownerFake = createFakeEngine({
                engine: owner,
                volumes: {
                    [names.workspace]: ownedVolume(names.workspace, invocation.pathHash, 'workspace'),
                },
            });
            const other = owner === 'podman' ? 'docker' : 'podman';
            const otherFake = createFakeEngine({ engine: other });
            const result = resolveEngineOwnership(invocation, {
                installedEngines: ['podman', 'docker'],
                engineClients: {
                    [owner]: ownerFake.engineClient,
                    [other]: otherFake.engineClient,
                },
            });
            assert.equal(result.engine, owner);
            assert.equal(result.inventory.volumes.roles.workspace.state, 'valid');
            assert.equal(result.inventory.volumes.roles.containers.state, 'absent');
        });
    }
});

test('cross-engine discovery rejects split container/volume ownership', () => {
    const invocation = invocationFor();
    const names = runtimeVolumeNames(invocation.instance);
    const podman = createFakeEngine({
        engine: 'podman',
        container: contract2Container(),
    });
    const docker = createFakeEngine({
        engine: 'docker',
        volumes: {
            [names.workspace]: ownedVolume(names.workspace, invocation.pathHash, 'workspace'),
        },
    });
    const result = resolveEngineOwnership(invocation, {
        installedEngines: ['podman', 'docker'],
        engineClients: { podman: podman.engineClient, docker: docker.engineClient },
    });
    assert.equal(result.issue.kind, 'split');
});

test('cross-engine discovery rejects exact-name foreign volumes', () => {
    const invocation = invocationFor();
    const names = runtimeVolumeNames(invocation.instance);
    const podman = createFakeEngine({
        engine: 'podman',
        volumes: { [names.workspace]: { Name: names.workspace, Labels: {} } },
    });
    const result = resolveEngineOwnership(invocation, {
        installedEngines: ['podman'],
        engineClients: { podman: podman.engineClient },
    });
    assert.equal(result.issue.kind, 'foreign');
    assert.match(result.issue.message, /foreign\/unsupported/);
});

test('an unreachable installed engine is unknown even when the peer owns resources', () => {
    const invocation = invocationFor();
    const podman = createFakeEngine({ engine: 'podman', container: contract2Container() });
    const docker = createFakeEngine({ engine: 'docker', failures: { info: 1 } });
    const result = resolveEngineOwnership(invocation, {
        installedEngines: ['podman', 'docker'],
        engineClients: { podman: podman.engineClient, docker: docker.engineClient },
    });
    assert.equal(result.issue.kind, 'unknown');
    assert.match(result.issue.message, /docker/);
});

test('generic does-not-exist diagnostics remain unknown instead of proving the box absent', () => {
    const invocation = invocationFor();
    const fake = createFakeEngine({ engine: 'podman' });
    const client = {
        ...fake.engineClient,
        query(args, options) {
            if (args[0] === 'container' && args[1] === 'inspect') {
                return {
                    ok: false,
                    status: 1,
                    stdout: '',
                    stderr: 'container inspection failed because the runtime cache does not exist',
                };
            }
            return fake.engineClient.query(args, options);
        },
    };
    const result = resolveEngineOwnership(invocation, {
        installedEngines: ['podman'],
        engineClients: { podman: client },
    });
    assert.equal(result.issue.kind, 'unknown');
    assert.match(result.issue.message, /container ownership probe failed/);
});

test('unknown-engine classification covers absent, unknown, and not-installed peers', async t => {
    const scenarios = [
        { name: 'unknown plus absent', installed: ['podman', 'docker'], podmanUnknown: true, dockerUnknown: false, issue: 'unknown' },
        { name: 'unknown plus unknown', installed: ['podman', 'docker'], podmanUnknown: true, dockerUnknown: true, issue: 'unknown' },
        { name: 'not-installed peer is omitted', installed: ['docker'], podmanUnknown: false, dockerUnknown: false, engine: 'docker' },
    ];
    for (const scenario of scenarios) {
        await t.test(scenario.name, () => {
            const invocation = invocationFor();
            const podman = createFakeEngine({ engine: 'podman', failures: scenario.podmanUnknown ? { info: 1 } : {} });
            const docker = createFakeEngine({ engine: 'docker', failures: scenario.dockerUnknown ? { info: 1 } : {} });
            const result = resolveEngineOwnership(invocation, {
                installedEngines: scenario.installed,
                engineClients: { podman: podman.engineClient, docker: docker.engineClient },
            });
            if (scenario.issue) assert.equal(result.issue.kind, scenario.issue);
            else assert.equal(result.engine, scenario.engine);
            if (!scenario.installed.includes('podman')) assert.equal(podman.calls.length, 0);
        });
    }
});

test('unknown discovery gives partial status but blocks ordinary mutation', async () => {
    const stdout = writableBuffer();
    const stderr = writableBuffer();
    const podman = createFakeEngine({ engine: 'podman' });
    const docker = createFakeEngine({ engine: 'docker', failures: { info: 1 } });
    const supervisor = createRuntimeSupervisor({
        stdout: stdout.stream,
        stderr: stderr.stream,
        stdin: { isTTY: false },
        cwd: '/workspace/demo',
        realpath: value => path.resolve(value),
        env: {},
        installedEngines: ['podman', 'docker'],
        engineClients: { podman: podman.engineClient, docker: docker.engineClient },
    });
    assert.equal(await supervisor.run(['status']), 1);
    assert.match(stdout.text(), /ownership unresolved/);
    assert.match(stdout.text(), /engine docker: unknown/);
    await assert.rejects(() => supervisor.run(['list', 'agents']), /make every installed engine answer/);
    assert.equal(mutationCalls(podman).length, 0);
    assert.equal(mutationCalls(docker).length, 0);
});

test('status inventories partial retained resources without creating missing roles', async () => {
    const identity = identityFor();
    const names = runtimeVolumeNames(identity.instance);
    const podman = createFakeEngine({
        engine: 'podman',
        volumes: { [names.workspace]: ownedVolume(names.workspace, identity.pathHash, 'workspace') },
    });
    const stdout = writableBuffer();
    const supervisor = createRuntimeSupervisor({
        stdout: stdout.stream,
        stderr: writableBuffer().stream,
        stdin: { isTTY: false },
        cwd: '/workspace/demo',
        realpath: value => path.resolve(value),
        env: {},
        installedEngines: ['podman'],
        engineClients: { podman: podman.engineClient },
    });
    assert.equal(await supervisor.run(['status']), 1);
    assert.match(stdout.text(), /workspace=valid/);
    assert.match(stdout.text(), /containers=absent/);
    assert.equal(mutationCalls(podman).length, 0);
});

test('help is local and probes no engine', async () => {
    const podman = createFakeEngine({ engine: 'podman', failures: { info: 1 } });
    const stdout = writableBuffer();
    const supervisor = createRuntimeSupervisor({
        stdout: stdout.stream,
        stderr: writableBuffer().stream,
        stdin: { isTTY: false },
        installedEngines: ['podman'],
        engineClients: { podman: podman.engineClient },
        showHelp: () => {},
    });
    assert.equal(await supervisor.run([] .concat('help')), 0);
    assert.equal(podman.calls.length, 0);
});

test('every outer mutation route is held by the exact-directory host lock while status and help stay read-only', async t => {
    const cases = [
        { argv: ['list', 'agents'] },
        { argv: ['start', 'explorer'], fetchResponse: { ok: true } },
        { argv: ['stop'] },
        { argv: ['destroy'], answer: 'no' },
        { argv: [], stdoutIsTTY: true },
    ];
    for (const entry of cases) {
        await t.test(entry.argv.join(' ') || 'bare', async () => {
            const fixture = contract2RuntimeFixture();
            let locks = 0;
            const harness = createSupervisorHarness({
                ...fixture,
                ...entry,
                withHostRuntimeLock: async (invocation, callback) => {
                    locks += 1;
                    assert.equal(invocation.canonicalPath, fixture.identity.canonicalPath);
                    return callback();
                },
            });
            await harness.supervisor.run(entry.argv);
            assert.equal(locks, 1);
        });
    }

    for (const argv of [['status'], ['help']]) {
        await t.test(`${argv[0]} is lock-free`, async () => {
            const fixture = contract2RuntimeFixture();
            const harness = createSupervisorHarness({
                ...fixture,
                withHostRuntimeLock: async () => {
                    throw new Error('read-only route acquired mutation lock');
                },
            });
            await harness.supervisor.run(argv);
            assert.doesNotMatch(harness.stderr, /acquired mutation lock/);
        });
    }
});

test('missing create pulls despite a cached tag, validates, and runs the new ID', async () => {
    const oldImage = contract2Image('sha256:old');
    const newImage = contract2Image('sha256:new');
    const harness = createSupervisorHarness({
        images: { [REQUIRED_RUNTIME_IMAGE]: oldImage, [oldImage.Id]: oldImage },
        pullImages: { [REQUIRED_RUNTIME_IMAGE]: newImage },
    });
    assert.equal(await harness.supervisor.run(['list', 'agents']), 0);
    assert.equal(runCalls(harness, 'pull').length, 1);
    const create = runCalls(harness, 'run')[0];
    assert.equal(create.args.at(-1), newImage.Id);
    assert.ok(create.args.includes(`${REQUESTED_IMAGE_LABEL}=${REQUIRED_RUNTIME_IMAGE}`));
});

test('a custom image is pulled, contract-validated, and pinned by ID', async () => {
    const reference = 'registry.example/ploinky/custom:runtime';
    const image = contract2Image('sha256:custom');
    const harness = createSupervisorHarness({ pullImages: { [reference]: image } });
    assert.equal(await harness.supervisor.run(['--image', reference, 'list']), 0);
    assert.deepEqual(runCalls(harness, 'pull')[0].args, ['pull', reference]);
    const create = runCalls(harness, 'run')[0].args;
    assert.equal(create.at(-1), image.Id);
    assert.ok(create.includes(`${REQUESTED_IMAGE_LABEL}=${reference}`));
});

test('missing create explicitly creates and labels all named volumes before attachment', async () => {
    const harness = createSupervisorHarness();
    assert.equal(await harness.supervisor.run(['list', 'agents']), 0);
    const identity = identityFor();
    const names = runtimeVolumeNames(identity.instance);
    const creates = harness.calls.filter(call =>
        call.kind === 'run' && call.args[0] === 'volume' && call.args[1] === 'create'
    );
    assert.equal(creates.length, 3);
    for (const [role, expectedRole] of Object.entries(VOLUME_ROLES)) {
        const call = creates.find(entry => entry.args.at(-1) === names[role]);
        assert.ok(call, role);
        assert.ok(call.args.includes(`${IDENTITY_SCHEMA_LABEL}=1`));
        assert.ok(call.args.includes(`${PATH_HASH_LABEL}=${identity.pathHash}`));
        assert.ok(call.args.includes(`${VOLUME_ROLE_LABEL}=${expectedRole}`));
        assert.deepEqual(harness.state.volumes.get(names[role]).Labels, {
            [IDENTITY_SCHEMA_LABEL]: '1',
            [PATH_HASH_LABEL]: identity.pathHash,
            [VOLUME_ROLE_LABEL]: expectedRole,
        });
    }
    const createIndex = harness.calls.findIndex(call => call.kind === 'run' && call.args[0] === 'run');
    assert.ok(creates.every(call => harness.calls.indexOf(call) < createIndex));
});

test('partial labelled volume sets are reused and only missing roles are created', async () => {
    const identity = identityFor();
    const names = runtimeVolumeNames(identity.instance);
    const harness = createSupervisorHarness({
        volumes: {
            [names.workspace]: ownedVolume(names.workspace, identity.pathHash, 'workspace'),
        },
    });
    assert.equal(await harness.supervisor.run(['list', 'agents']), 0);
    const creates = harness.calls.filter(call =>
        call.kind === 'run' && call.args[0] === 'volume' && call.args[1] === 'create'
    );
    assert.deepEqual(creates.map(call => call.args.at(-1)).sort(), [names.containers, names.deps].sort());
});

test('foreign volume discovery fails before pull or mutation', async () => {
    const identity = identityFor();
    const names = runtimeVolumeNames(identity.instance);
    const podman = createFakeEngine({
        engine: 'podman',
        volumes: { [names.workspace]: { Name: names.workspace, Labels: {} } },
    });
    const stderr = writableBuffer();
    const supervisor = createRuntimeSupervisor({
        stdout: writableBuffer().stream,
        stderr: stderr.stream,
        stdin: { isTTY: false },
        cwd: '/workspace/demo',
        realpath: value => path.resolve(value),
        env: {},
        installedEngines: ['podman'],
        engineClients: { podman: podman.engineClient },
    });
    assert.equal(await runSupervisorWithBoundary(supervisor, ['list', 'agents'], stderr.stream), 1);
    assert.match(stderr.text(), /foreign\/unsupported/);
    assert.equal(mutationCalls(podman).length, 0);
});

test('new path-hashed create never attaches legacy basename-only volumes', async () => {
    const harness = createSupervisorHarness({
        volumes: {
            'ploinky-box-demo-workspace': { Name: 'ploinky-box-demo-workspace', Labels: {} },
            'ploinky-box-demo-containers': { Name: 'ploinky-box-demo-containers', Labels: {} },
            'ploinky-box-demo-ploinky-deps': { Name: 'ploinky-box-demo-ploinky-deps', Labels: {} },
        },
    });
    assert.equal(await harness.supervisor.run(['list', 'agents']), 0);
    const args = runCalls(harness, 'run')[0].args;
    assert.equal(args.some(value => /^ploinky-box-demo-(workspace|containers|ploinky-deps):/.test(value)), false);
    assert.equal(harness.state.volumes.has('ploinky-box-demo-workspace'), true);
});

test('compatible running reuse and stopped start perform no registry pull', async t => {
    for (const state of ['running', 'exited']) {
        await t.test(state, async () => {
            const fixture = contract2RuntimeFixture({ state });
            const harness = createSupervisorHarness(fixture);
            assert.equal(await harness.supervisor.run(['list', 'agents']), 0);
            assert.equal(runCalls(harness, 'pull').length, 0);
            assert.equal(runCalls(harness, 'start').length, state === 'exited' ? 1 : 0);
        });
    }
});

test('current-contract replacement pulls and validates before shutdown', async () => {
    const fixture = contract2RuntimeFixture();
    const next = contract2Image('sha256:next');
    const harness = createSupervisorHarness({
        ...fixture,
        pullImages: { [REQUIRED_RUNTIME_IMAGE]: next },
    });
    assert.equal(await harness.supervisor.run(['--port', '9192', 'list', 'agents']), 0);
    const pullIndex = harness.calls.findIndex(call => call.kind === 'run' && call.args[0] === 'pull');
    const shutdownIndex = harness.calls.findIndex(call =>
        call.kind === 'run' && call.args.includes('ploinky') && call.args.includes('stop')
    );
    assert.ok(pullIndex >= 0 && shutdownIndex > pullIndex);
    assert.equal(runCalls(harness, 'run').at(-1).args.at(-1), next.Id);
});

test('pull or image-contract failure leaves the existing box running', async t => {
    await t.test('pull failure', async () => {
        const fixture = contract2RuntimeFixture();
        const harness = createSupervisorHarness({ ...fixture, failures: { pull: 1 } });
        assert.equal(await harness.supervisor.run(['--port', '9192', 'list']), 1);
        assert.equal(harness.state.container.inspect.State.Status, 'running');
        assert.equal(runCalls(harness, 'stop').length, 0);
    });
    await t.test('metadata failure', async () => {
        const fixture = contract2RuntimeFixture();
        const invalid = contract2Image('sha256:invalid');
        invalid.Config.User = 'root';
        const harness = createSupervisorHarness({
            ...fixture,
            pullImages: { [REQUIRED_RUNTIME_IMAGE]: invalid },
        });
        assert.equal(await harness.supervisor.run(['--port', '9192', 'list']), 1);
        assert.match(harness.stderr, /Config\.User/);
        assert.equal(harness.state.container.inspect.State.Status, 'running');
        assert.equal(runCalls(harness, 'stop').length, 0);
    });
});

test('contract-1 ordinary commands fail closed without pull, planner, or mutation', async () => {
    const fixture = contract2RuntimeFixture({ imageId: 'sha256:runtime-1' });
    fixture.images = { 'sha256:runtime-1': contract1Image() };
    let plannerCalls = 0;
    const harness = createSupervisorHarness({
        ...fixture,
        preparePublicationPlan: async () => { plannerCalls += 1; return { schemaVersion: 2, publishes: [] }; },
    });
    assert.equal(await harness.supervisor.run(['start', 'explorer']), 1);
    assert.match(harness.stderr, /unsupported/);
    assert.match(harness.stderr, /ploinky destroy/);
    assert.equal(plannerCalls, 0);
    assert.equal(mutationCalls(harness).length, 0);
});

test('current-contract box missing router publication fails before planning or core mutation', async () => {
    const fixture = contract2RuntimeFixture();
    delete fixture.container.inspect.HostConfig.PortBindings[`${BOX_ROUTER_PORT}/tcp`];
    let plannerCalls = 0;
    const harness = createSupervisorHarness({
        ...fixture,
        preparePublicationPlan: async () => {
            plannerCalls += 1;
            return { schemaVersion: 2, publishes: [] };
        },
    });

    assert.equal(await harness.supervisor.run(['start', 'explorer']), 1);
    assert.match(harness.stderr, /required 8080\/tcp router publication is missing/);
    assert.match(harness.stderr, /ploinky destroy explicitly/);
    assert.equal(plannerCalls, 0);
    assert.equal(mutationCalls(harness).length, 0);
});

test('contract-2 and contract-3 boxes require explicit destroy without planning or mutation', async t => {
    for (const legacyContract of ['2', '3']) {
        await t.test(`contract ${legacyContract}`, async () => {
            const imageId = `sha256:runtime-legacy-${legacyContract}`;
            const fixture = contract2RuntimeFixture({ imageId });
            const legacyImage = contract2Image(imageId);
            legacyImage.Config.Labels[RUNTIME_CONTRACT_LABEL] = legacyContract;
            fixture.images = { [legacyImage.Id]: legacyImage };
            let plannerCalls = 0;
            const harness = createSupervisorHarness({
                ...fixture,
                preparePublicationPlan: async () => {
                    plannerCalls += 1;
                    return { schemaVersion: 2, publishes: [] };
                },
            });

            assert.equal(await harness.supervisor.run(['start', 'explorer']), 1);
            assert.match(harness.stderr, /runtime-contract/);
            assert.match(harness.stderr, /ploinky destroy explicitly/);
            assert.equal(plannerCalls, 0);
            assert.equal(mutationCalls(harness).length, 0);
        });
    }
});

test('status, stop, and destroy remain pull-free for contract-1 boxes', async t => {
    for (const command of ['status', 'stop', 'destroy']) {
        await t.test(command, async () => {
            const fixture = contract2RuntimeFixture({ imageId: 'sha256:runtime-1' });
            fixture.images = { 'sha256:runtime-1': contract1Image() };
            const harness = createSupervisorHarness({
                ...fixture,
                answer: command === 'destroy' ? 'y' : null,
            });
            await harness.supervisor.run([command]);
            assert.equal(runCalls(harness, 'pull').length, 0);
            if (command === 'destroy') assert.equal(harness.state.container, null);
        });
    }
});

test('failed replacement rolls back prior image ID, labels, environment, config, and volumes', async () => {
    const fixture = contract2RuntimeFixture();
    fixture.container.inspect.HostConfig.Privileged = true;
    fixture.container.inspect.Config.Labels['example.keep'] = 'yes';
    fixture.container.inspect.Config.Env.push('CUSTOM_RUNTIME_SETTING=kept');
    const priorVolumes = cloneVolumeMap(fixture.volumes);
    const harness = createSupervisorHarness({
        ...fixture,
        pullImages: { [REQUIRED_RUNTIME_IMAGE]: contract2Image('sha256:next') },
        failures: { 'health replacement': 1 },
    });
    assert.equal(await harness.supervisor.run(['--port', '9192', 'list']), 1);
    const runs = runCalls(harness, 'run');
    assert.equal(runs.length, 1);
    assert.equal(runs[0].args.at(-1), 'sha256:next');
    assert.equal(runs[0].args.includes('--privileged'), false);
    const renames = runCalls(harness, 'rename');
    assert.equal(renames.length, 2);
    assert.equal(renames[0].args[1], identityFor().instance);
    assert.equal(renames[1].args[2], identityFor().instance);
    assert.deepEqual(harness.state.container.inspect, fixture.container.inspect);
    assert.equal(harness.state.container.inspect.HostConfig.Privileged, true);
    assert.deepEqual(Object.fromEntries(harness.state.volumes), priorVolumes);
});

function cloneVolumeMap(volumes) {
    return structuredClone(volumes);
}

test('replacement transaction preserves or restores the prior box when stop, rename, or replacement fails', async t => {
    const cases = [
        { name: 'outer stop fails', failures: { stop: 17 }, expectedCode: 17, restored: false },
        { name: 'preserve rename fails', failures: { rename: 18 }, expectedCode: 18, restored: false },
        { name: 'replacement create fails', failures: { 'run replacement': 19 }, expectedCode: 1, restored: true },
    ];
    for (const entry of cases) {
        await t.test(entry.name, async () => {
            const fixture = contract2RuntimeFixture();
            fixture.container.inspect.Config.Labels['example.prior'] = 'retained';
            const harness = createSupervisorHarness({
                ...fixture,
                failures: entry.failures,
                rmFailureRemovesContainer: entry.rmFailureRemovesContainer,
            });
            assert.equal(await harness.supervisor.run(['--port', '19191', 'list']), entry.expectedCode);
            assert.ok(harness.state.container);
            assert.equal(harness.state.container.inspect.Image, fixture.container.inspect.Image);
            assert.equal(harness.state.container.inspect.State.Status, 'running');
            assert.equal(
                harness.state.container.inspect.Config.Labels['example.prior'],
                'retained',
            );
            assert.deepEqual(
                harness.state.container.inspect.HostConfig.PortBindings['8080/tcp'],
                [{ HostIp: '127.0.0.1', HostPort: '8080' }],
            );
            if (entry.restored) assert.match(harness.stderr, /previous runtime restored/);
        });
    }
});

test('failed initial run removes a partially created box and its anonymous volumes', async () => {
    const harness = createSupervisorHarness({
        failures: { 'run create': 29 },
        createFailureCreatesContainer: true,
    });
    assert.equal(await harness.supervisor.run(['list', 'agents']), 29);
    assert.equal(harness.state.container, null);
    assert.equal(harness.state.anonymousVolumes.size, 0);
    assert.equal(runCalls(harness, 'rm').length, 1);
    assert.ok(runCalls(harness, 'rm')[0].args.includes('--volumes'));
    for (const name of Object.values(runtimeVolumeNames(identityFor().instance))) {
        assert.equal(harness.state.volumes.has(name), true, name);
    }
});

test('destroy directly removes only the outer box, cleans anonymous volumes, and retains named volumes', async () => {
    const fixture = contract2RuntimeFixture();
    const labelsBefore = structuredClone(fixture.volumes);
    const harness = createSupervisorHarness({
        ...fixture,
        anonymousVolumes: ['anonymous-image-volume'],
        answer: 'y',
    });
    assert.equal(await harness.supervisor.run(['destroy']), 0);
    assert.match(harness.prompt, new RegExp(fixture.identity.instance));
    assert.match(harness.prompt, /named volumes.*retained/i);
    const rms = runCalls(harness, 'rm');
    assert.equal(rms.length, 1);
    assert.deepEqual(rms[0].args, ['rm', '-f', '--volumes', fixture.identity.instance]);
    assert.equal(runCalls(harness, 'stop').length, 0);
    assert.equal(runCalls(harness, 'exec').length, 0);
    assert.equal(harness.calls.some(call => call.kind === 'run' && call.args[0] === 'volume' && call.args[1] === 'rm'), false);
    assert.equal(harness.state.container, null);
    assert.equal(harness.state.anonymousVolumes.size, 0);
    assert.deepEqual(Object.fromEntries(harness.state.volumes), labelsBefore);
});

test('destroy refusal mutates nothing', async () => {
    const fixture = contract2RuntimeFixture();
    const harness = createSupervisorHarness({ ...fixture, answer: 'no' });
    assert.equal(await harness.supervisor.run(['destroy']), 1);
    assert.ok(harness.state.container);
    assert.equal(mutationCalls(harness).length, 0);
});

test('foreign retained resources block destroy before confirmation or mutation', async () => {
    const identity = identityFor();
    const names = runtimeVolumeNames(identity.instance);
    const podman = createFakeEngine({
        engine: 'podman',
        volumes: { [names.workspace]: { Name: names.workspace, Labels: {} } },
    });
    const stdout = writableBuffer();
    const stderr = writableBuffer();
    let prompts = 0;
    const supervisor = createRuntimeSupervisor({
        stdout: stdout.stream,
        stderr: stderr.stream,
        stdin: { isTTY: false },
        cwd: '/workspace/demo',
        realpath: value => path.resolve(value),
        env: {},
        installedEngines: ['podman'],
        engineClients: { podman: podman.engineClient },
        askLine: async () => { prompts += 1; return 'y'; },
    });
    assert.equal(await runSupervisorWithBoundary(supervisor, ['destroy'], stderr.stream), 1);
    assert.equal(prompts, 0);
    assert.equal(mutationCalls(podman).length, 0);
});

test('destroy is idempotent with a missing box and retained volumes', async () => {
    const fixture = contract2RuntimeFixture();
    const harness = createSupervisorHarness({ container: null, volumes: fixture.volumes, answer: 'y' });
    assert.equal(await harness.supervisor.run(['destroy']), 0);
    assert.equal(harness.prompt, '');
    assert.match(harness.stdout, /already absent.*retained named volumes/i);
    assert.equal(mutationCalls(harness).length, 0);
});

test('retained named volumes are reattached on recreation', async () => {
    const fixture = contract2RuntimeFixture();
    const harness = createSupervisorHarness({ ...fixture, answer: 'y' });
    assert.equal(await harness.supervisor.run(['destroy']), 0);
    assert.equal(await harness.supervisor.run(['list', 'agents']), 0);
    const create = runCalls(harness, 'run').at(-1);
    for (const name of Object.values(runtimeVolumeNames(fixture.identity.instance))) {
        assert.ok(create.args.some(value => value.startsWith(`${name}:`)), name);
        assert.equal(harness.state.volumes.has(name), true);
    }
});

test('bare ploinky opens p-cli and parameterless cli opens the in-box Bash route', async () => {
    const fixture = contract2RuntimeFixture();
    const bare = createSupervisorHarness({ ...fixture, stdoutIsTTY: true });
    assert.equal(await bare.supervisor.run([]), 0);
    const bareExec = runCalls(bare, 'exec').at(-1).args;
    assert.ok(bareExec.includes('-it'));
    assert.equal(bareExec.at(-1), 'p-cli');

    const cli = createSupervisorHarness({ ...fixture, stdoutIsTTY: true });
    assert.equal(await cli.supervisor.run(['cli']), 0);
    const cliExec = runCalls(cli, 'exec').at(-1).args;
    assert.deepEqual(cliExec.slice(-2), ['ploinky', 'cli']);
});

test('parameterless cli fails locally without a TTY', async () => {
    const harness = createSupervisorHarness();
    assert.equal(await harness.supervisor.run(['cli']), 1);
    assert.match(harness.stderr, /interactive terminal/);
    assert.equal(harness.calls.length, 0);
});

test('authoritative publication plan produces the core coverage contract', () => {
    const invocation = invocationFor();
    const plan = {
        schemaVersion: 2,
        operation: 'start',
        explicitPublishes: [],
        generatedPublishes: ['127.0.0.1:9000:9000/udp', '9100-9102:9100-9102'],
        publishes: ['127.0.0.1:9000:9000/udp', '9100-9102:9100-9102'],
    };
    applyAuthoritativePublicationPlan(invocation, plan);
    assert.deepEqual(invocation._generatedPublishes, plan.generatedPublishes);
    assert.deepEqual(publicationContractForPlan(plan), {
        schemaVersion: 2,
        targets: [
            { start: 9000, end: 9000, protocol: 'udp' },
            { start: 9100, end: 9102, protocol: 'tcp' },
        ],
        publishes: plan.publishes,
    });
    assert.throws(
        () => applyAuthoritativePublicationPlan({}, { schemaVersion: 1 }),
        /schemaVersion/,
    );

    const forged = {
        ...plan,
        outerPublicationContract: {
            schemaVersion: 2,
            targets: [{ start: 65535, end: 65535, protocol: 'tcp' }],
            publishes: ['65535:65535'],
        },
    };
    assert.deepEqual(publicationContractForPlan(forged), publicationContractForPlan(plan));
});

test('core forwarding includes the authoritative publication contract environment', () => {
    const fake = createFakeEngine();
    const invocation = invocationFor();
    invocation._outerPublicationContract = {
        schemaVersion: 2,
        targets: [{ start: 9000, end: 9000, protocol: 'tcp' }],
        publishes: ['9000:9000'],
    };
    assert.equal(forwardCoreCommand({
        invocation,
        runtime: { instance: invocation.instance },
        engine: fake.engineClient,
        stdin: { isTTY: false },
        stdout: { isTTY: false },
    }, ['start', 'agent']), 0);
    const exec = mutationCalls(fake).at(-1).args;
    assert.ok(exec.includes(
        `PLOINKY_OUTER_PUBLICATION_CONTRACT=${JSON.stringify(invocation._outerPublicationContract)}`,
    ));
});

test('injected start planner result is merged before create and forwarded to core', async () => {
    const requests = [];
    const harness = createSupervisorHarness({
        preparePublicationPlan: async request => {
            requests.push(request);
            return {
                schemaVersion: 2,
                operation: 'start',
                explicitPublishes: [],
                generatedPublishes: ['127.0.0.1:9000:9000'],
                publishes: ['127.0.0.1:9000:9000'],
            };
        },
        fetchResponse: { ok: true },
    });
    assert.equal(await harness.supervisor.run(['start', 'explorer']), 0);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].operation, 'start');
    const create = runCalls(harness, 'run')[0].args;
    assert.ok(create.includes('127.0.0.1:9000:9000'));
    const exec = runCalls(harness, 'exec').at(-1).args;
    assert.ok(exec.some(value => value.startsWith('PLOINKY_OUTER_PUBLICATION_CONTRACT=')));
});

test('production planner executes in a compatible running box without pull or temporary container', async () => {
    const fixture = contract2RuntimeFixture();
    const harness = createSupervisorHarness({
        ...fixture,
        useProductionPlanner: true,
        fetchResponse: { ok: true },
    });
    assert.equal(await harness.supervisor.run(['start', 'explorer']), 0);
    const captures = harness.calls.filter(call => call.kind === 'capture');
    assert.equal(captures.length, 1);
    assert.deepEqual(captures[0].args.slice(0, 6), [
        'exec', '-i', '-w', '/workspace', fixture.identity.instance, 'node',
    ]);
    assert.equal(captures[0].args.at(-1), '/opt/ploinky/container/box-start-publish-plan.mjs');
    assert.equal(runCalls(harness, 'pull').length, 0);
    assert.equal(runCalls(harness, 'rm').length, 0);
    assert.equal(harness.state.temporaryContainers.size, 0);
});

test('production planner uses and cleans a short-lived container for a stopped box without starting it first', async () => {
    const fixture = contract2RuntimeFixture({ state: 'exited' });
    const harness = createSupervisorHarness({
        ...fixture,
        useProductionPlanner: true,
        fetchResponse: { ok: true },
    });
    assert.equal(await harness.supervisor.run(['start', 'explorer']), 0);
    const captureIndex = harness.calls.findIndex(call => call.kind === 'capture');
    const startIndex = harness.calls.findIndex(call => call.kind === 'run' && call.args[0] === 'start');
    assert.ok(captureIndex >= 0 && startIndex > captureIndex);
    const capture = harness.calls[captureIndex];
    assert.equal(capture.args[0], 'run');
    assert.equal(capture.args[1], '-i');
    assert.ok(capture.args.includes(fixture.container.inspect.Image));
    assert.match(capture.args[capture.args.indexOf('--name') + 1], /-planner-/);
    assert.equal(runCalls(harness, 'pull').length, 0);
    assert.equal(runCalls(harness, 'rm').length, 1);
    assert.equal(harness.state.temporaryContainers.size, 0);
});

test('first-use production planning pulls once, pins one image ID, and retains deterministic volumes', async () => {
    const harness = createSupervisorHarness({
        useProductionPlanner: true,
        fetchResponse: { ok: true },
    });
    assert.equal(await harness.supervisor.run(['start', 'explorer']), 0);
    const pullCalls = runCalls(harness, 'pull');
    const captures = harness.calls.filter(call => call.kind === 'capture');
    const creates = runCalls(harness, 'run');
    assert.equal(pullCalls.length, 1);
    assert.equal(captures.length, 1);
    assert.equal(captures[0].args[0], 'run');
    assert.equal(captures[0].args[1], '-i');
    assert.ok(captures[0].args.includes('sha256:runtime-2'));
    assert.equal(creates.length, 1);
    assert.equal(creates[0].args.at(-1), 'sha256:runtime-2');
    assert.equal(harness.state.temporaryContainers.size, 0);
    for (const name of Object.values(runtimeVolumeNames(identityFor().instance))) {
        assert.equal(harness.state.volumes.has(name), true, name);
    }
    const pullIndex = harness.calls.indexOf(pullCalls[0]);
    const plannerIndex = harness.calls.indexOf(captures[0]);
    const createIndex = harness.calls.indexOf(creates[0]);
    assert.ok(pullIndex < plannerIndex && plannerIndex < createIndex);
});

test('planner failure cleans its temporary container, preserves named state, and starts no runtime', async () => {
    const identity = identityFor();
    const names = runtimeVolumeNames(identity.instance);
    const harness = createSupervisorHarness({
        useProductionPlanner: true,
        failures: { 'capture planner': 23 },
    });
    assert.equal(await harness.supervisor.run(['start', 'explorer']), 1);
    assert.match(harness.stderr, /publication planner.*failed/);
    assert.equal(harness.state.container, null);
    assert.equal(harness.state.temporaryContainers.size, 0);
    assert.equal(runCalls(harness, 'run').length, 0);
    assert.deepEqual([...harness.state.volumes.keys()], [names.workspace]);
});

test('planner timeout preserves running, stopped, and missing managed-box state and cleans temporary containers', async t => {
    const cases = [
        { name: 'running', fixture: contract2RuntimeFixture() },
        { name: 'stopped', fixture: contract2RuntimeFixture({ state: 'exited' }) },
        { name: 'missing', fixture: {} },
    ];
    for (const entry of cases) {
        await t.test(entry.name, async () => {
            const harness = createSupervisorHarness({
                ...entry.fixture,
                useProductionPlanner: true,
                plannerCapture: async () => ({
                    ok: false,
                    status: 137,
                    stdout: '',
                    stderr: '',
                    error: null,
                    signal: 'SIGKILL',
                    timedOut: true,
                    overflow: false,
                }),
            });
            const before = harness.state.container
                ? structuredClone(harness.state.container.inspect)
                : null;
            assert.equal(await harness.supervisor.run(['start', 'explorer']), 1);
            assert.match(harness.stderr, /timed out/);
            assert.deepEqual(harness.state.container?.inspect || null, before);
            assert.equal(harness.state.temporaryContainers.size, 0);
            assert.equal(runCalls(harness, 'run').length, 0);
            assert.equal(runCalls(harness, 'start').length, 0);
            assert.equal(runCalls(harness, 'stop').length, 0);
            assert.equal(runCalls(harness, 'pull').length, entry.name === 'missing' ? 1 : 0);
            if (entry.name === 'missing') {
                assert.deepEqual(
                    [...harness.state.volumes.keys()],
                    [runtimeVolumeNames(identityFor().instance).workspace],
                );
            }
        });
    }
});

test('signal-terminated planner execution still cleans its temporary container and preserves the stopped box', async () => {
    const fixture = contract2RuntimeFixture({ state: 'exited' });
    const harness = createSupervisorHarness({
        ...fixture,
        useProductionPlanner: true,
        plannerCapture: async () => ({
            ok: false,
            status: 143,
            stdout: '',
            stderr: '',
            error: null,
            signal: 'SIGTERM',
            timedOut: false,
            overflow: false,
        }),
    });
    assert.equal(await harness.supervisor.run(['start', 'explorer']), 1);
    assert.match(harness.stderr, /SIGTERM|exit 143/);
    assert.equal(harness.state.container.inspect.State.Status, 'exited');
    assert.equal(harness.state.temporaryContainers.size, 0);
    assert.equal(runCalls(harness, 'start').length, 0);
    assert.equal(runCalls(harness, 'pull').length, 0);
});

test('temporary planner cleanup failure is fatal and does not create the managed box', async () => {
    const harness = createSupervisorHarness({
        useProductionPlanner: true,
        failures: { 'rm planner': 19 },
    });
    assert.equal(await harness.supervisor.run(['start', 'explorer']), 1);
    assert.match(harness.stderr, /failed to remove temporary publication planner/);
    assert.equal(runCalls(harness, 'run').length, 0);
    assert.equal(harness.state.container, null);
    assert.equal(harness.state.temporaryContainers.size, 1);
});

test('planned replacement retains exact explicit provenance and replaces stale generated publications', async () => {
    const oldExplicit = '127.0.0.1:19000:9000/udp';
    const oldGenerated = '127.0.0.1:19100:9100';
    const nextGenerated = '127.0.0.1:19200:9200';
    const fixture = contract2RuntimeFixture({
        labels: {
            [EXPLICIT_PUBLISHES_LABEL]: JSON.stringify([oldExplicit]),
            [GENERATED_PUBLISHES_LABEL]: JSON.stringify([oldGenerated]),
        },
        publishes: {
            '9000/udp': [{ HostIp: '127.0.0.1', HostPort: '19000' }],
            '9100/tcp': [{ HostIp: '127.0.0.1', HostPort: '19100' }],
        },
    });
    const requests = [];
    const harness = createSupervisorHarness({
        ...fixture,
        preparePublicationPlan: async request => {
            requests.push(request);
            return {
                schemaVersion: 2,
                operation: request.operation,
                explicitPublishes: request.explicitPublishes,
                generatedPublishes: [nextGenerated],
                publishes: [...request.explicitPublishes, nextGenerated],
            };
        },
    });
    assert.equal(await harness.supervisor.run(['enable', 'explorer']), 0);
    assert.deepEqual(requests[0].explicitPublishes, [oldExplicit]);
    const replacement = runCalls(harness, 'run').at(-1).args;
    assert.ok(replacement.includes(oldExplicit));
    assert.ok(replacement.includes(nextGenerated));
    assert.equal(replacement.includes(oldGenerated), false);
    assert.ok(replacement.includes(
        `${EXPLICIT_PUBLISHES_LABEL}=${JSON.stringify([oldExplicit])}`,
    ));
    assert.ok(replacement.includes(
        `${GENERATED_PUBLISHES_LABEL}=${JSON.stringify([nextGenerated])}`,
    ));
});

test('inspect-expanded, reordered, wildcard, and ephemeral bindings do not cause perpetual replacement', async () => {
    const explicit = [
        '9100:9100',
        '9000:9000',
        '127.0.0.1::9200/udp',
    ];
    const generated = [
        '127.0.0.1:20000-20002:20000-20002/udp',
        '127.0.0.1:20000-20002:20000-20002/tcp',
    ];
    const publishes = {
        '9000/tcp': [{ HostIp: '', HostPort: '9000' }],
        '9100/tcp': [{ HostIp: '0.0.0.0', HostPort: '9100' }],
        '9200/udp': [{ HostIp: '127.0.0.1', HostPort: '49152' }],
    };
    for (const protocol of ['udp', 'tcp']) {
        for (let port = 20000; port <= 20002; port += 1) {
            publishes[`${port}/${protocol}`] = [{
                HostIp: '127.0.0.1',
                HostPort: String(port),
            }];
        }
    }
    const fixture = contract2RuntimeFixture({
        labels: {
            [EXPLICIT_PUBLISHES_LABEL]: JSON.stringify(explicit),
            [GENERATED_PUBLISHES_LABEL]: JSON.stringify(generated),
        },
        publishes,
    });
    const harness = createSupervisorHarness(fixture);
    assert.equal(await harness.supervisor.run(['list', 'agents']), 0);
    assert.equal(runCalls(harness, 'pull').length, 0);
    assert.equal(runCalls(harness, 'run').length, 0);
    assert.equal(runCalls(harness, 'stop').length, 0);
});

test('contract-3 boxes fail on the runtime contract before publication provenance or mutation', async () => {
    const fixture = contract2RuntimeFixture({ imageId: 'sha256:runtime-legacy-3' });
    const legacyImage = contract2Image('sha256:runtime-legacy-3');
    legacyImage.Config.Labels[RUNTIME_CONTRACT_LABEL] = '3';
    fixture.images = { [legacyImage.Id]: legacyImage };
    delete fixture.container.inspect.Config.Labels[PUBLISH_PLAN_VERSION_LABEL];
    let plannerCalls = 0;
    const harness = createSupervisorHarness({
        ...fixture,
        preparePublicationPlan: async () => { plannerCalls += 1; },
    });
    assert.equal(await harness.supervisor.run(['start', 'explorer']), 1);
    assert.match(harness.stderr, /runtime-contract.*destroy/);
    assert.equal(plannerCalls, 0);
    assert.equal(mutationCalls(harness).length, 0);
});

test('every host route capable of starting an agent invokes the planner before forwarding', async t => {
    const cases = [
        { argv: ['start', 'explorer'], operation: 'start', root: 'explorer' },
        { argv: ['start'], operation: 'start', root: undefined },
        { argv: ['enable', 'explorer'], operation: 'enable', root: 'explorer' },
        { argv: ['cli', 'explorer'], operation: 'cli', root: 'explorer' },
        { argv: ['shell', 'explorer'], operation: 'shell', root: 'explorer' },
        { argv: ['restart', 'explorer'], operation: 'restart', root: 'explorer' },
        { argv: ['restart', 'router'], operation: 'restart', root: undefined },
        { argv: ['reinstall', 'agent', 'explorer'], operation: 'reinstall', root: 'explorer' },
    ];
    for (const entry of cases) {
        await t.test(entry.argv.join(' '), async () => {
            const fixture = contract2RuntimeFixture();
            const requests = [];
            let harness;
            harness = createSupervisorHarness({
                ...fixture,
                fetchResponse: { ok: true },
                preparePublicationPlan: async request => {
                    requests.push(request);
                    harness.calls.push({ kind: 'planner', args: [], options: {} });
                    return {
                        schemaVersion: 2,
                        operation: request.operation,
                        explicitPublishes: request.explicitPublishes,
                        generatedPublishes: [],
                        publishes: request.explicitPublishes,
                    };
                },
            });
            assert.equal(await harness.supervisor.run(entry.argv), 0);
            assert.equal(requests.length, 1);
            assert.equal(requests[0].operation, entry.operation);
            assert.equal(requests[0].root, entry.root);
            const plannerIndex = harness.calls.findIndex(call => call.kind === 'planner');
            const forwardIndex = harness.calls.findIndex(call =>
                call.kind === 'run' && call.args.includes('ploinky')
            );
            assert.ok(plannerIndex >= 0 && forwardIndex > plannerIndex);
        });
    }
});

test('master key is inherited only by in-box execs and never persisted or placed in argv', async () => {
    const secret = 'test-master-key-never-log-this';
    const harness = createSupervisorHarness({ env: { PLOINKY_MASTER_KEY: secret } });
    assert.equal(await harness.supervisor.run(['list', 'agents']), 0);
    const exec = runCalls(harness, 'exec').at(-1);
    assert.ok(exec.args.includes('PLOINKY_MASTER_KEY'));
    assert.equal(exec.args.some(value => String(value).includes(secret)), false);
    assert.equal(exec.options.env.PLOINKY_MASTER_KEY, secret);
    assert.equal(
        harness.state.container.inspect.Config.Env.some(value => value.includes('PLOINKY_MASTER_KEY')),
        false,
    );
    assert.equal(JSON.stringify(harness.state.container.inspect).includes(secret), false);
    assert.equal(harness.stdout.includes(secret), false);
    assert.equal(harness.stderr.includes(secret), false);
});

test('the host walked-up .env master key preserves core resolution without entering argv', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-master-env-'));
    const child = path.join(root, 'nested', 'workspace');
    const secret = 'walked-up-master-key';
    fs.mkdirSync(child, { recursive: true });
    fs.writeFileSync(path.join(root, '.env'), `PLOINKY_MASTER_KEY=${secret}\n`);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const harness = createSupervisorHarness({ cwd: child });
    assert.equal(await harness.supervisor.run(['list', 'agents']), 0);
    const exec = runCalls(harness, 'exec').at(-1);
    assert.ok(exec.args.includes('PLOINKY_MASTER_KEY'));
    assert.equal(exec.args.some(value => String(value).includes(secret)), false);
    assert.equal(exec.options.env.PLOINKY_MASTER_KEY, secret);
    assert.equal(JSON.stringify(harness.state.container.inspect).includes(secret), false);
});

test('status, stop, and replacement shutdown inherit the master key without exposing its value in argv', async t => {
    for (const argv of [['status'], ['stop'], ['--port', '9192', 'list']]) {
        await t.test(argv.join(' '), async () => {
            const secret = `secret-${argv.at(-1)}`;
            const fixture = contract2RuntimeFixture();
            const harness = createSupervisorHarness({
                ...fixture,
                env: { PLOINKY_MASTER_KEY: secret },
            });
            await harness.supervisor.run(argv);
            const relevant = runCalls(harness, 'exec').filter(call =>
                call.args.includes('status') || call.args.includes('stop')
            );
            assert.ok(relevant.length >= 1);
            for (const call of relevant) {
                assert.ok(call.args.includes('PLOINKY_MASTER_KEY'));
                assert.equal(call.args.some(value => String(value).includes(secret)), false);
                assert.equal(call.options.env.PLOINKY_MASTER_KEY, secret);
            }
        });
    }
});

test('engine query and run seams pass planner stdin and environment', () => {
    const calls = [];
    const client = createEngineClient({
        name: 'podman',
        spawnSyncImpl(command, args, options) {
            calls.push({ command, args, options });
            return { status: 0, stdout: '{}', stderr: '' };
        },
    });
    assert.equal(client.query(['exec', 'planner'], {
        input: '{"schemaVersion":1}',
        env: { TEST_ENV: 'query' },
    }).ok, true);
    assert.equal(client.run(['run', 'planner'], {
        input: '{"schemaVersion":1}',
        env: { TEST_ENV: 'run' },
        silence: 'all',
    }), 0);
    assert.equal(calls[0].options.input, '{"schemaVersion":1}');
    assert.deepEqual(calls[0].options.env, { TEST_ENV: 'query' });
    assert.equal(calls[1].options.input, '{"schemaVersion":1}');
    assert.deepEqual(calls[1].options.env, { TEST_ENV: 'run' });
});

test('engine capture bounds planner stdin, output, and execution time', async () => {
    const client = createEngineClient({ name: process.execPath });
    const success = await client.capture([
        '--input-type=module',
        '-e',
        "let value=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => value += chunk); process.stdin.on('end', () => process.stdout.write(process.env.CAPTURE_TOKEN + ':' + value));",
    ], {
        input: 'request-json',
        env: { ...process.env, CAPTURE_TOKEN: 'inherited' },
        timeoutMs: 1000,
        maxBuffer: 1024,
    });
    assert.equal(success.ok, true);
    assert.equal(success.stdout, 'inherited:request-json');

    const overflow = await client.capture([
        '-e',
        "process.stdout.write('x'.repeat(4096));",
    ], { timeoutMs: 1000, maxBuffer: 64 });
    assert.equal(overflow.ok, false);
    assert.equal(overflow.overflow, true);
    assert.ok(Buffer.byteLength(overflow.stdout) <= 64);

    const timeout = await client.capture([
        '-e',
        'setInterval(() => {}, 1000);',
    ], { timeoutMs: 20, maxBuffer: 1024 });
    assert.equal(timeout.ok, false);
    assert.equal(timeout.timedOut, true);
});

test('host launcher and aliases route through the supervisor, including symlinks', async t => {
    const cases = [
        { name: 'ploinky', executable: PLOINKY, args: ['status', '--dry-run'], expected: [SUPERVISOR, 'status', '--dry-run'] },
        { name: 'p-cli', executable: PCLI, args: ['status'], expected: [SUPERVISOR, 'status'] },
        { name: 'psh', executable: PSH, args: ['--trace'], expected: [SUPERVISOR, 'sh', '--trace'] },
    ];
    for (const scenario of cases) {
        await t.test(scenario.name, () => {
            const fake = makeFakeNodeCapture();
            const links = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-launch-link-'));
            const link = path.join(links, scenario.name);
            try {
                fs.symlinkSync(scenario.executable, link);
                const result = spawnSync(link, scenario.args, {
                    encoding: 'utf8',
                    env: {
                        ...process.env,
                        PATH: `${fake.dir}:${process.env.PATH || ''}`,
                        CAPTURE_FILE: fake.capture,
                    },
                });
                assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
                assert.deepEqual(capturedArgv(fake.capture), scenario.expected);
            } finally {
                fs.rmSync(fake.dir, { recursive: true, force: true });
                fs.rmSync(links, { recursive: true, force: true });
            }
        });
    }
});

test('wrapper marker and source mount contracts remain explicit', () => {
    const launcher = fs.readFileSync(PLOINKY, 'utf8');
    assert.match(launcher, /-f \/etc\/ploinky-box/);
    assert.match(launcher, /PLOINKY_WORKSPACE_ROOT.*\/workspace/);
    assert.match(launcher, /exec node "\$ROOT_DIR\/container\/runtime-supervisor\.mjs"/);

    const invocation = invocationFor();
    const config = createDefaultRuntimeConfig(invocation);
    config.imageId = 'sha256:validated';
    const args = buildRuntimeRunArgs(config, { engine: 'podman' });
    assert.ok(args.includes(`${invocation.sourceDirResolved}:/opt/ploinky:ro`));
    assert.equal(args.some(value => value.includes('/etc/ploinky-box')), false);
    assert.equal(args.some(value => value.startsWith('PLOINKY_BOX=')), false);
});

test('dependency installer remains syntactically valid and read-only-source safe', () => {
    const result = spawnSync('bash', ['-n', INSTALL_DEPS], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const source = fs.readFileSync(INSTALL_DEPS, 'utf8');
    assert.match(source, /--no-package-lock/);
    assert.match(source, /--no-audit/);
    assert.match(source, /--no-fund/);
    assert.match(source, /still missing after npm install/);
});

test('dependency consent honors environment opt-in and TTY confirmation only', () => {
    assert.equal(shouldInstallDeps({ PLOINKY_BOX_INSTALL_DEPS: '1' }, false, null), true);
    assert.equal(shouldInstallDeps({}, true, 'y'), true);
    assert.equal(shouldInstallDeps({}, true, 'Y'), true);
    assert.equal(shouldInstallDeps({}, true, 'n'), false);
    assert.equal(shouldInstallDeps({}, false, 'y'), false);
});

test('missing dependencies fail noninteractive commands before core exec', async () => {
    const fixture = contract2RuntimeFixture();
    fixture.container.depsInstalled = false;
    const harness = createSupervisorHarness(fixture);
    assert.equal(await harness.supervisor.run(['list', 'agents']), 1);
    assert.match(harness.stderr, /until dependencies are installed/i);
    assert.equal(runCalls(harness, 'exec').length, 0);
});

test('dependency environment opt-in and TTY approval run the in-box installer', async t => {
    for (const scenario of [
        { name: 'environment', env: { PLOINKY_BOX_INSTALL_DEPS: '1' }, stdoutIsTTY: false },
        { name: 'TTY prompt', env: {}, stdoutIsTTY: true, answer: 'y' },
    ]) {
        await t.test(scenario.name, async () => {
            const fixture = contract2RuntimeFixture();
            fixture.container.depsInstalled = false;
            const harness = createSupervisorHarness({ ...fixture, ...scenario });
            assert.equal(await harness.supervisor.run(['list']), 0);
            const install = runCalls(harness, 'exec').find(call =>
                call.args.includes('/opt/ploinky/bin/ploinky-install-deps')
            );
            assert.ok(install);
            if (scenario.stdoutIsTTY) assert.match(harness.prompt, /Install them now/);
        });
    }
});

test('contract-4 rejects Docker while rootless Podman relies on :U', async () => {
    const dockerFixture = contract2RuntimeFixture({ engine: 'docker' });
    const docker = createSupervisorHarness({ ...dockerFixture, engine: 'docker' });
    assert.equal(await docker.supervisor.run(['list']), 1);
    assert.match(docker.stderr, /requires rootless Podman/);
    assert.equal(runCalls(docker, 'exec').length, 0);

    const podmanFixture = contract2RuntimeFixture({ engine: 'podman' });
    const podman = createSupervisorHarness({ ...podmanFixture, engine: 'podman' });
    assert.equal(await podman.supervisor.run(['list']), 0);
    assert.equal(runCalls(podman, 'exec').some(call => call.args.includes('chown')), false);
    const config = createDefaultRuntimeConfig(invocationFor());
    assert.ok(buildRuntimeRunArgs(config, { engine: 'podman' })
        .includes(`${config.volumes.deps}:/opt/ploinky/node_modules:U`));
    assert.ok(buildRuntimeRunArgs(config, { engine: 'docker' })
        .includes(`${config.volumes.deps}:/opt/ploinky/node_modules`));
});

test('nested rootless maps require exactly 65535 contiguous UID and GID identities', () => {
    const exact = '0 1000 1\n1 100000 65534\n';
    assert.equal(validateNestedUidMap(exact).length, 2);
    assert.equal(validateNestedGidMap(exact).length, 2);
    assert.throws(() => validateNestedUidMap('0 1000 1\n1 100000 65533\n'), /exactly 65534/);
    assert.throws(() => validateNestedGidMap('0 1000 1\n1 100000 65535\n'), /exactly 65534/);
    assert.throws(() => validateNestedGidMap('0 1000 1\n2 100000 65533\n'), /not contiguous/);
    assert.throws(() => validateNestedUidMap('0 100000 1\n1 100000 65534\n'), /overlapping host identities/);
});

test('outer capability drift is captured and cleared while SELinux desired state converges', () => {
    const fixture = contract2RuntimeFixture();
    fixture.container.inspect.HostConfig.CapAdd = ['SYS_ADMIN'];
    const normalized = normalizeContainerInspect('podman', JSON.stringify([fixture.container.inspect]));
    assert.deepEqual(normalized.capAdds, ['SYS_ADMIN']);

    const invocation = invocationFor();
    invocation._selinuxEnabled = true;
    const desired = mergeDesiredRuntimeConfig(invocation, normalized);
    assert.deepEqual(desired.capAdds, []);
    assert.ok(desired.securityOpts.includes('label=disable'));
    desired.running = true;
    const converged = mergeDesiredRuntimeConfig(invocation, desired);
    assert.equal(planReconciliation({ existing: desired, desired: converged, contractMatches: true }).action, 'reuse');
    desired.capAdds = ['SYS_ADMIN'];
    assert.throws(() => buildRuntimeRunArgs(desired, { engine: 'podman' }), /forbids added/);
});

test('Podman-normalized outer devices and security options converge without replacement', () => {
    const fixture = contract2RuntimeFixture();
    fixture.container.inspect.HostConfig.Devices = [];
    fixture.container.inspect.HostConfig.SecurityOpt = ['label=disable', 'unmask=all'];
    fixture.container.inspect.Config.CreateCommand = [
        'podman', 'run',
        '--device', '/dev/fuse:/dev/fuse:rwm',
        '--device=/dev/net/tun:/dev/net/tun:rwm',
        '--security-opt', 'unmask=ALL',
        '--security-opt', 'label=disable',
    ];
    const actual = normalizeContainerInspect('podman', JSON.stringify([fixture.container.inspect]));
    const invocation = invocationFor();
    invocation._selinuxEnabled = true;
    const desired = mergeDesiredRuntimeConfig(invocation, actual);
    assert.deepEqual(actual.devices, desired.devices);
    assert.deepEqual(actual.securityOpts, desired.securityOpts);
    assert.equal(diffRuntimeConfig(actual, desired).includes('devices'), false);
    assert.equal(diffRuntimeConfig(actual, desired).includes('securityOpts'), false);
});

test('interactive exec preserves TTY and non-TTY behavior for cli and shell routes', async () => {
    const fixture = contract2RuntimeFixture();
    const tty = createSupervisorHarness({ ...fixture, stdoutIsTTY: true });
    assert.equal(await tty.supervisor.run(['cli', 'agent', '--field', 'value']), 0);
    const ttyExec = runCalls(tty, 'exec').at(-1).args;
    assert.ok(ttyExec.includes('-it'));
    assert.equal(ttyExec.includes('PLOINKY_NO_TTY=1'), false);

    const nonTty = createSupervisorHarness(fixture);
    assert.equal(await nonTty.supervisor.run(['cli', 'agent']), 0);
    const nonTtyExec = runCalls(nonTty, 'exec').at(-1).args;
    assert.ok(nonTtyExec.includes('-i'));
    assert.ok(nonTtyExec.includes('PLOINKY_NO_TTY=1'));

    const shell = createSupervisorHarness(fixture);
    assert.equal(await shell.supervisor.run(['sh']), 0);
    assert.ok(runCalls(shell, 'exec').at(-1).args.includes('-i'));

    const agentShell = createSupervisorHarness(fixture);
    assert.equal(await agentShell.supervisor.run(['shell', 'agent']), 0);
    const agentShellExec = runCalls(agentShell, 'exec').at(-1).args;
    assert.ok(agentShellExec.includes('-i'));
    assert.ok(agentShellExec.includes('PLOINKY_NO_TTY=1'));
});

test('compatible and stopped status preserve streaming health/core behavior without mutation', async () => {
    const runningFixture = contract2RuntimeFixture({
        publishes: { '9000/udp': [{ HostIp: '127.0.0.1', HostPort: '19000' }] },
    });
    const running = createSupervisorHarness(runningFixture);
    assert.equal(await running.supervisor.run(['status']), 0);
    assert.match(running.stdout, new RegExp(`runtime: ${runningFixture.identity.instance} \\(running\\)`));
    assert.match(running.stdout, /contract: compatible \(expected 4, observed 4\)/);
    assert.match(running.stdout, /health: healthy/);
    assert.match(running.stdout, /core: running/);
    assert.match(running.stdout, /19000 -> 9000\/udp/);
    assert.equal(running.calls.some(call => call.kind === 'streamContains'), true);
    assert.equal(runCalls(running, 'pull').length, 0);

    const stopped = createSupervisorHarness(contract2RuntimeFixture({ state: 'exited' }));
    assert.equal(await stopped.supervisor.run(['status']), 1);
    assert.equal(runCalls(stopped, 'exec').length, 0);
    assert.equal(stopped.calls.some(call => call.kind === 'streamContains'), false);
});

test('stop attempts the outer stop after a core shutdown failure and stays pull-free', async () => {
    const fixture = contract2RuntimeFixture();
    const harness = createSupervisorHarness({
        ...fixture,
        failures: { 'exec ploinky stop': 9 },
    });
    assert.equal(await harness.supervisor.run(['stop']), 1);
    assert.deepEqual(
        harness.calls.filter(call => call.kind === 'run').map(call => call.args[0]),
        ['exec', 'stop'],
    );
    assert.match(harness.stderr, /core shutdown: failed \(exit 9\)/);
    assert.match(harness.stdout, /outer runtime stop: succeeded/);
    assert.equal(runCalls(harness, 'pull').length, 0);
});

test('managed start probes the selected router port only after core start succeeds', async () => {
    const plannerRequests = [];
    const plan = async request => {
        plannerRequests.push(request);
        return {
            schemaVersion: 2,
            operation: 'start',
            explicitPublishes: [],
            generatedPublishes: [],
            publishes: [],
        };
    };
    const success = createSupervisorHarness({
        preparePublicationPlan: plan,
        fetchResponse: { ok: true },
    });
    assert.equal(await success.supervisor.run(['--port', '19192', 'start', 'explorer']), 0);
    const coreIndex = success.calls.findIndex(call =>
        call.kind === 'run' && call.args.includes('ploinky') && call.args.includes('start')
    );
    const fetchIndex = success.calls.findIndex(call => call.kind === 'fetch');
    assert.ok(coreIndex >= 0 && fetchIndex > coreIndex);
    assert.equal(success.calls[fetchIndex].url, 'http://127.0.0.1:19192/status');
    assert.equal(plannerRequests[0].routerPort, BOX_ROUTER_PORT);

    const failed = createSupervisorHarness({
        preparePublicationPlan: plan,
        failures: { exec: 7 },
        fetchResponse: { ok: true },
    });
    assert.equal(await failed.supervisor.run(['--port', '19193', 'start', 'explorer']), 7);
    assert.equal(failed.calls.some(call => call.kind === 'fetch'), false);
});

test('a positional start port replaces an existing box and publishes the selected router socket', async () => {
    const fixture = contract2RuntimeFixture();
    const harness = createSupervisorHarness({
        ...fixture,
        fetchResponse: { ok: true },
    });
    assert.equal(await harness.supervisor.run(['start', 'explorer', '19194']), 0);
    const replacements = runCalls(harness, 'run');
    assert.equal(replacements.length, 1);
    assert.ok(replacements[0].args.includes('127.0.0.1:19194:8080'));
    const forwarded = runCalls(harness, 'exec').at(-1).args;
    assert.deepEqual(
        forwarded.slice(-6),
        ['ploinky', 'start', 'explorer', '8080', '--profile', 'default'],
    );
});

test('run args preserve mounts, required devices, rootless security, raw publishes, and image-last ordering', () => {
    const invocation = invocationFor();
    invocation.mountDirResolved = '/host/mounted';
    invocation.publish = ['127.0.0.1::9000/udp'];
    invocation.explicit.add('--mount');
    invocation.explicit.add('--publish');
    const config = createDefaultRuntimeConfig(invocation);
    config.imageId = 'sha256:validated';
    const plain = buildRuntimeRunArgs(config, { engine: 'podman', selinux: false });
    const selinux = buildRuntimeRunArgs(config, { engine: 'podman', selinux: true });
    assert.equal(plain.at(-1), 'sha256:validated');
    assert.equal(plain.includes('--privileged'), false);
    assert.ok(plain.includes('/dev/fuse:/dev/fuse:rwm'));
    assert.ok(plain.includes('/dev/net/tun:/dev/net/tun:rwm'));
    assert.ok(plain.includes('unmask=ALL'));
    assert.equal(plain.includes('seccomp=unconfined'), false);
    assert.ok(plain.includes('/host/mounted:/workspace/mounted'));
    assert.ok(plain.includes('127.0.0.1::9000/udp'));
    assert.equal(plain.includes('label=disable'), false);
    assert.ok(selinux.includes('label=disable'));
});

test('runtime config requires an explicitly selected host port and never supplies a lower-layer default', () => {
    const invocation = invocationFor();
    delete invocation.port;
    assert.throws(
        () => createDefaultRuntimeConfig(invocation),
        (error) => error.code === 'PLOINKY_ROUTER_PORT_INVALID',
    );
    const existing = normalizeContainerInspect(
        'podman',
        contract2RuntimeFixture().container.inspect,
    );
    assert.throws(
        () => mergeDesiredRuntimeConfig(invocation, existing),
        (error) => error.code === 'PLOINKY_ROUTER_PORT_INVALID',
    );
});

test('mount, publish, and host-port preflight failures occur before pull or volume mutation', async t => {
    await t.test('missing mount', async () => {
        const harness = createSupervisorHarness();
        assert.equal(await harness.supervisor.run(['--mount', '/definitely/missing/ploinky', 'list']), 1);
        assert.equal(mutationCalls(harness).length, 0);
    });
    await t.test('invalid publish', async () => {
        const harness = createSupervisorHarness();
        assert.equal(await harness.supervisor.run(['--publish', '70000:70000', 'list']), 1);
        assert.match(harness.stderr, /invalid --publish/);
        assert.equal(mutationCalls(harness).length, 0);
    });
    await t.test('busy router port', async () => {
        const stderr = writableBuffer();
        const fake = createFakeEngine();
        const supervisor = createRuntimeSupervisor({
            stdout: writableBuffer().stream,
            stderr: stderr.stream,
            stdin: { isTTY: false },
            cwd: '/workspace/demo',
            realpath: value => path.resolve(value),
            env: { PLOINKY_BOX_SOURCE: REPO_ROOT },
            engineClient: fake.engineClient,
            portInUse: async () => true,
        });
        assert.equal(await runSupervisorWithBoundary(supervisor, ['--port', '19194', 'list'], stderr.stream), 1);
        assert.equal(mutationCalls(fake).length, 0);
    });
});

test('publish merging rejects fixed host collisions but permits ephemeral host allocation', () => {
    assert.throws(() => mergeAndValidatePublishes([
        { hostIp: '0.0.0.0', hostPort: '9000', containerPort: '8000', protocol: 'tcp' },
        { hostIp: '127.0.0.1', hostPort: '9000', containerPort: '8001', protocol: 'tcp' },
    ]), /overlapping runtime publish host socket/);
    assert.equal(mergeAndValidatePublishes([
        { hostIp: '', hostPort: '', containerPort: '8000', protocol: 'tcp' },
        { hostIp: '', hostPort: '', containerPort: '8001', protocol: 'tcp' },
    ]).length, 2);
});

test('inspect normalization and reconciliation helpers preserve engine parity and explicit-only changes', () => {
    const podmanRaw = contract2Container({ engine: 'podman' }).inspect;
    const dockerRaw = contract2Container({ engine: 'docker' }).inspect;
    const podman = normalizeContainerInspect('podman', [podmanRaw]);
    const docker = normalizeContainerInspect('docker', [dockerRaw]);
    assert.deepEqual(docker, podman);

    podman.contract = '2';
    const omitted = mergeDesiredRuntimeConfig(invocationFor(), podman, []);
    assert.equal(planReconciliation({ existing: podman, desired: omitted, contractMatches: true }).action, 'reuse');
    const changedInvocation = invocationFor();
    changedInvocation.port = '9192';
    changedInvocation.explicit.add('--port');
    const changed = mergeDesiredRuntimeConfig(changedInvocation, podman, []);
    const plan = planReconciliation({ existing: podman, desired: changed, contractMatches: true });
    assert.equal(plan.action, 'replace');
    assert.deepEqual(plan.reasons, ['routerPublish']);
});

test('source resolution and branch inference retain existing behavior', () => {
    assert.equal(resolveHostPloinkySource({}), REPO_ROOT);
    const source = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-source-'));
    try {
        fs.mkdirSync(path.join(source, 'bin'));
        fs.mkdirSync(path.join(source, 'cli'));
        fs.mkdirSync(path.join(source, 'globalDeps'));
        fs.writeFileSync(path.join(source, 'bin', 'ploinky'), '#!/bin/sh\n');
        fs.writeFileSync(path.join(source, 'cli', 'index.js'), '// test\n');
        fs.writeFileSync(path.join(source, 'globalDeps', 'package.json'), '{}\n');
        assert.equal(resolveHostPloinkySource({ PLOINKY_BOX_SOURCE: source }), path.resolve(source));
    } finally {
        fs.rmSync(source, { recursive: true, force: true });
    }
    assert.deepEqual(
        inferPublicStartBranchArgs(['agent'], { PLOINKY_BOX_BRANCH: 'feature' }, REPO_ROOT),
        ['--branch', 'feature'],
    );
    assert.deepEqual(
        inferPublicStartBranchArgs(['agent', '--branch', 'manual'], { PLOINKY_BOX_BRANCH: 'feature' }, REPO_ROOT),
        [],
    );
});

test('engine and supervisor boundaries preserve nonzero and signal exit details', async () => {
    const exited = createEngineClient({
        name: 'podman',
        spawnSyncImpl: () => ({ status: 23, stdout: '', stderr: '' }),
    });
    assert.throws(() => exited.run(['run', 'x']), error => error.exitCode === 23);
    const signalled = createEngineClient({
        name: 'podman',
        spawnSyncImpl: () => ({ status: null, signal: 'SIGTERM', stdout: '', stderr: '' }),
    });
    assert.throws(
        () => signalled.run(['run', 'x']),
        error => error.exitCode === 143 && error.signal === 'SIGTERM',
    );
    const stderr = writableBuffer();
    const error = new Error('preserved failure');
    error.exitCode = 23;
    assert.equal(await runSupervisorWithBoundary({ run() { throw error; } }, [], stderr.stream), 23);
    assert.match(stderr.text(), /preserved failure/);
});

test('host help describes automatic identity and direct volume-preserving destroy', () => {
    assert.match(publicUsageText(), /Contract-4 runtime image/);
    const help = publicUsageText();
    assert.match(help, /canonical current directory/);
    assert.match(help, /retain named volumes/);
    assert.match(help, /options \(must precede the command\)/i);
    assert.doesNotMatch(help, /^\s+--name\s/m);
    assert.doesNotMatch(help, /^\s+--engine\s/m);
    assert.doesNotMatch(help, /PLOINKY_BOX_ENGINE=/);
});
