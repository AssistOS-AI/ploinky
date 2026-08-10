import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { parseOuterArguments } from '../../../ploinky-box/command/parse.mjs';
import { routeOuterCommand } from '../../../ploinky-box/command/route.mjs';
import { readSmokeGraphInputs, stageSmokeGraph } from '../../../ploinky-box/smoke/graph.mjs';
import {
    readProxyTrace,
    writeCandidatePodmanProxy,
} from './candidatePodmanProxy.mjs';
import { captureCandidateEvidence } from './candidateEvidence.mjs';
import {
    createPodmanHarness,
    execInBox,
    requirePodmanCandidate,
    waitForRouterHealth,
} from './nativeHelpers.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
const PUBLIC_COMMAND_TIMEOUT_MS = 16 * 60_000;

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        encoding: 'utf8',
        timeout: PUBLIC_COMMAND_TIMEOUT_MS,
        ...options,
    });
    assert.equal(result.error, undefined, result.error?.message);
    return result;
}

function treeHash(root) {
    const hash = crypto.createHash('sha256');
    function walk(directory, relative = '') {
        for (const name of fs.readdirSync(directory).sort()) {
            const target = path.join(directory, name);
            const next = path.join(relative, name);
            const stat = fs.lstatSync(target);
            hash.update(`${next}\0${stat.mode}\0`);
            if (stat.isDirectory()) walk(target, next);
            else if (stat.isFile()) hash.update(fs.readFileSync(target));
            else if (stat.isSymbolicLink()) hash.update(fs.readlinkSync(target));
        }
    }
    walk(root);
    return hash.digest('hex');
}

function treeContainsBytes(root, needle, { skip = new Set() } = {}) {
    const expected = Buffer.from(needle);
    function walk(directory) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            if (skip.has(entry.name)) continue;
            const target = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                if (walk(target)) return true;
            } else if (entry.isFile() && fs.readFileSync(target).includes(expected)) {
                return true;
            }
        }
        return false;
    }
    return walk(root);
}

function inBoxStateHash(containerId, harness) {
    return execInBox(harness.runner, containerId, [
        '/usr/local/bin/node', '-e', [
            "const c=require('node:crypto'),f=require('node:fs'),p=require('node:path');",
            "const h=c.createHash('sha256');",
            "function w(root,d=root){for(const n of f.readdirSync(d).sort()){const x=p.join(d,n),s=f.lstatSync(x);h.update(p.relative(root,x)+'\\0'+s.mode+'\\0');if(s.isDirectory())w(root,x);else if(s.isFile())h.update(f.readFileSync(x));else if(s.isSymbolicLink())h.update(f.readlinkSync(x));}}",
            "for(const root of ['/workspace','/opt/ploinky/node_modules','/home/podman/.local/share/containers']){h.update(root+'\\0');w(root)}",
            "process.stdout.write(h.digest('hex'));",
        ].join(''),
    ]);
}

function nestedAgent(containerId, harness) {
    return JSON.parse(execInBox(harness.runner, containerId, [
        '/usr/local/bin/node', '-e', [
            "const f=require('node:fs');",
            "const a=JSON.parse(f.readFileSync('/workspace/.ploinky/agents.json'));",
            "const e=Object.entries(a).find(([,v])=>v&&v.runtime==='podman'&&/^[a-f0-9]{64}$/.test(v.containerId||''));",
            "if(!e)process.exit(4);process.stdout.write(JSON.stringify({name:e[0],id:e[1].containerId}));",
        ].join(''),
    ]));
}

function assertNestedRoutingAndSecretBoundary(containerId, harness) {
    const agent = nestedAgent(containerId, harness);
    const environment = execInBox(harness.runner, containerId, [
        'podman', 'container', 'exec', agent.id, 'env',
    ]);
    assert.match(environment, /^PLOINKY_ROUTER_HOST=host\.containers\.internal$/m);
    assert.match(environment, /^PLOINKY_ROUTER_URL=http:\/\/host\.containers\.internal:8080$/m);
    assert.match(environment, /^PLOINKY_ROUTER_AUTHORITY=127\.0\.0\.1:\d+$/m);
    assert.equal(environment.includes('HOST_MASTER_KEY_CANARY'), false);
    assert.doesNotMatch(environment, /^PLOINKY_MASTER_KEY=/m);
    waitForRouterHealth(harness.runner, containerId, {
        nestedContainerId: agent.id,
    });
    return agent;
}

test('installed public shims honor only the environment image override through the candidate proxy', {
    timeout: 30 * 60_000,
}, async (t) => {
    const candidateReference = requirePodmanCandidate(t);
    if (!candidateReference) return;
    const harness = createPodmanHarness(t, candidateReference);
    const graph = readSmokeGraphInputs(process.env, { runner: harness.runner });
    const publicGraphArgs = ['--udp-port', '17892', ...graph.args];
    const startRoute = routeOuterCommand(parseOuterArguments(publicGraphArgs));
    assert.equal(startRoute.kind, 'start');

    const prepared = await harness.supervisor.prepareBoxForCommand({
        imageRef: candidateReference,
        explicitPort: startRoute.hostPort,
        explicitMediaPort: startRoute.mediaHostPort,
    });
    const initialKeyHash = execInBox(harness.runner, prepared.containerId, [
        'sha256sum', '/workspace/.ploinky/master-key',
    ]).split(/\s/)[0];
    const initialKeyFile = execInBox(harness.runner, prepared.containerId, [
        'cat', '/workspace/.ploinky/master-key',
    ]);
    assert.match(initialKeyFile, /^[a-f0-9]{64}$/);
    assert.equal(initialKeyFile.includes('HOST_MASTER_KEY_CANARY'), false);

    const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-public-artifact-'));
    t.after(() => fs.rmSync(artifactRoot, { recursive: true, force: true }));
    const packed = run('npm', [
        'pack', '--ignore-scripts', '--json', '--pack-destination', artifactRoot,
    ], { cwd: repositoryRoot });
    assert.equal(packed.status, 0, packed.stderr);
    const archive = path.join(artifactRoot, JSON.parse(packed.stdout)[0].filename);
    const extracted = run('tar', ['-xzf', archive, '-C', artifactRoot]);
    assert.equal(extracted.status, 0, extracted.stderr);
    const packageRoot = path.join(artifactRoot, 'package');
    const installedPloinky = path.join(packageRoot, 'bin/ploinky');
    const installedPCli = path.join(packageRoot, 'bin/p-cli');

    const podmanLookup = run('which', ['podman']);
    assert.equal(podmanLookup.status, 0, podmanLookup.stderr);
    const realPodmanInput = String(
        process.env.PLOINKY_BOX_REAL_PODMAN || podmanLookup.stdout.trim(),
    );
    assert.equal(path.isAbsolute(realPodmanInput), true);
    const realPodman = fs.realpathSync(realPodmanInput);
    const logicalReference = 'docker.io/assistos/ploinky-box:e2e-override';
    const proxyDirectory = path.join(artifactRoot, 'candidate-proxy');
    const tracePath = path.join(artifactRoot, 'candidate-proxy.trace');
    const proxy = writeCandidatePodmanProxy({
        directory: proxyDirectory,
        realPodman,
        candidateReference,
        logicalReference,
        localCandidate: true,
        tracePath,
    });
    const publicEnvironment = {
        ...process.env,
        HOME: harness.lockHome,
        ...(harness.engineEnvironment.XDG_CONFIG_HOME
            ? { XDG_CONFIG_HOME: harness.engineEnvironment.XDG_CONFIG_HOME }
            : {}),
        PATH: `${proxy.directory}:${process.env.PATH}`,
        PLOINKY_MASTER_KEY: 'HOST_MASTER_KEY_CANARY',
        PLOINKY_PROD: 'true',
        PLOINKY_BOX_IMAGE: logicalReference,
        PLOINKY_BOX_ENGINE: 'attacker-engine',
        PLOINKY_BOX_INSTANCE: 'attacker-instance',
    };
    delete publicEnvironment.PLOINKY_BOX_CANDIDATE_DIGEST;
    delete publicEnvironment.PLOINKY_BOX_CANDIDATE_REF;
    delete publicEnvironment.PLOINKY_BOX_REAL_PODMAN;
    delete publicEnvironment.PLOINKY_BOX_PROXY_TRACE_ARTIFACT;
    function publicCommand(argv, { input } = {}) {
        return run(installedPloinky, argv, {
            cwd: harness.child,
            env: publicEnvironment,
            input,
        });
    }

    const help = publicCommand(['help']);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /managed outer Box/);
    assert.equal(fs.existsSync(tracePath), false, 'help must not discover or invoke Podman');
    const pCliHelp = run(installedPCli, ['help'], {
        cwd: harness.child,
        env: publicEnvironment,
    });
    assert.equal(pCliHelp.status, 0, pCliHelp.stderr);
    assert.equal(pCliHelp.stdout, help.stdout);
    assert.equal(fs.existsSync(tracePath), false, 'p-cli help must remain engine-pure');

    const beforeStatus = treeHash(harness.workspace);
    const beforeBoxStatus = inBoxStateHash(prepared.containerId, harness);
    const statusBefore = publicCommand(['status']);
    assert.notEqual(statusBefore.status, 0);
    assert.match(statusBefore.stdout, /Ploinky Box: incompatible/);
    assert.match(statusBefore.stdout, /Owned Box mount \/opt\/ploinky is incompatible/);
    assert.equal(treeHash(harness.workspace), beforeStatus);
    assert.equal(inBoxStateHash(prepared.containerId, harness), beforeBoxStatus);
    assert.equal(statusBefore.stdout.includes('HOST_MASTER_KEY_CANARY'), false);

    for (const argv of [
        ['--image', 'docker.io/attacker/image:latest', 'status'],
        ['--engine', 'docker', 'status'],
        ['--name', 'foreign', 'status'],
        ['--rotate-master-key', 'status'],
    ]) {
        const rejected = publicCommand(argv);
        assert.notEqual(rejected.status, 0, argv.join(' '));
        assert.match(rejected.stderr, /not a supported public Box option/);
    }

    stageSmokeGraph({ graph, containerId: prepared.containerId, runner: harness.runner });
    const markerProbe = execInBox(harness.runner, prepared.containerId, [
        '/usr/local/bin/node', '--input-type=module', '-e',
        "import { isInsideBox } from '/opt/ploinky/ploinky-box/lib/boxMarker.mjs'; process.stdout.write(isInsideBox() ? 'inside' : 'outside');",
    ]);
    assert.equal(markerProbe, 'inside');
    const innerHelp = execInBox(harness.runner, prepared.containerId, [
        '/opt/ploinky/bin/ploinky', 'help',
    ]);
    assert.notEqual(innerHelp.trim(), '');
    assert.doesNotMatch(innerHelp, /managed outer Box/);

    // The staging Box is mounted from this source checkout. Hand the retained
    // workspace-backed cache directories to the packed CLI so its Box is
    // mounted from the installed tree and the exact /opt/ploinky source
    // invariant remains fail-closed.
    const stagingDestroyed = publicCommand(['destroy'], { input: 'yes\n' });
    assert.equal(stagingDestroyed.status, 0, stagingDestroyed.stderr);
    const retained = publicCommand(['status']);
    assert.equal(retained.status, 0, retained.stderr);
    assert.match(retained.stdout, /Ploinky Box: absent/);
    for (const target of Object.values(harness.identity.dataPaths)) {
        assert.equal(fs.statSync(target).isDirectory(), true, target);
    }

    const started = publicCommand(['--debug', ...publicGraphArgs]);
    assert.equal(started.status, 0, started.stderr);
    assert.equal(started.stdout.match(/Debug mode enabled/g)?.length, 1);
    assert.match(started.stdout,
        new RegExp(`Dashboard: http://127\\.0\\.0\\.1:${startRoute.hostPort}/dashboard`));
    assert.doesNotMatch(started.stdout, /Dashboard: http:\/\/127\.0\.0\.1:8080\/dashboard/);
    assert.equal(started.stdout.includes('HOST_MASTER_KEY_CANARY'), false);
    assert.equal(started.stderr.includes('HOST_MASTER_KEY_CANARY'), false);

    const running = publicCommand(['status']);
    assert.equal(running.status, 0, running.stderr);
    assert.match(running.stdout, /Workspace status:/);
    assert.match(running.stdout, /Agent runtimes:/);
    const runningIdentity = harness.resolveIdentity();
    const runningInspection = harness.runner.query('podman', [
        'container', 'inspect', runningIdentity.instance,
    ]);
    assert.equal(runningInspection.ok, true, runningInspection.stderr);
    const runningRecord = JSON.parse(runningInspection.stdout)[0];
    const runningId = String(runningRecord?.Id || '');
    assert.match(runningId, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(runningRecord.Config?.Env || []).includes('HOST_MASTER_KEY_CANARY'), false);
    assert.equal((runningRecord.Config?.Env || []).some((value) => (
        String(value).startsWith('PLOINKY_MASTER_KEY=')
    )), false);
    const agent = assertNestedRoutingAndSecretBoundary(runningId, harness);
    const nestedImageId = execInBox(harness.runner, runningId, [
        'podman', 'container', 'inspect', '--format', '{{.Image}}', agent.id,
    ]);
    assert.match(nestedImageId, /^(?:sha256:)?[a-f0-9]{64}$/);
    const nestedContainerId = execInBox(harness.runner, runningId, [
        'podman', 'container', 'inspect', '--format', '{{.Id}}', agent.id,
    ]);
    assert.match(nestedContainerId, /^[a-f0-9]{64}$/);
    const nestedVolume = `ploinky-box-t28-${harness.identity.pathHash.slice(0, 12)}`;
    execInBox(harness.runner, runningId, ['podman', 'volume', 'create', nestedVolume]);
    execInBox(harness.runner, runningId, [
        'bash', '-lc',
        'mountpoint="$(podman volume inspect --format "{{.Mountpoint}}" "$1")"; printf nested-retained > "$mountpoint/canary"',
        'bash', nestedVolume,
    ]);
    execInBox(harness.runner, runningId, [
        'bash', '-c', [
            'printf workspace-retained > /workspace/t28-workspace-canary',
            'printf dependencies-retained > /opt/ploinky/node_modules/t28-dependencies-canary',
        ].join('; '),
    ]);
    // Exercise the public running-destroy path: it must stop the nested graph
    // itself before removing the outer Box.
    const destroyed = publicCommand(['--debug', 'destroy'], { input: 'yes\n' });
    assert.equal(destroyed.status, 0, destroyed.stderr);
    assert.equal(destroyed.stdout.match(/Debug mode enabled/g)?.length, 1);

    const recreated = publicCommand(publicGraphArgs);
    assert.equal(recreated.status, 0, recreated.stderr);
    const currentIdentity = harness.resolveIdentity();
    const inspected = harness.runner.query('podman', ['container', 'inspect', currentIdentity.instance]);
    assert.equal(inspected.ok, true, inspected.stderr);
    const currentId = String(JSON.parse(inspected.stdout)[0]?.Id || '');
    assert.match(currentId, /^[a-f0-9]{64}$/);
    const recreatedKeyHash = execInBox(harness.runner, currentId, [
        'sha256sum', '/workspace/.ploinky/master-key',
    ]).split(/\s/)[0];
    assert.equal(recreatedKeyHash, initialKeyHash);
    assert.equal(execInBox(harness.runner, currentId, [
        'cat', '/workspace/t28-workspace-canary',
    ]), 'workspace-retained');
    assert.equal(execInBox(harness.runner, currentId, [
        'cat', '/opt/ploinky/node_modules/t28-dependencies-canary',
    ]), 'dependencies-retained');
    // Generation-specific nested state must not survive outer replacement.
    for (const [kind, name] of [
        ['volume', nestedVolume],
        ['container', nestedContainerId],
    ]) {
        const survivor = harness.runner.query('podman', [
            'container', 'exec', '--user', 'podman', currentId,
            'podman', kind, 'inspect', name,
        ]);
        assert.equal(survivor.ok, false, `nested ${kind} ${name} must not survive recreate`);
    }
    // Reusable image content is exactly what does survive.
    const retainedImage = harness.runner.query('podman', [
        'container', 'exec', '--user', 'podman', currentId,
        'podman', 'image', 'inspect', nestedImageId,
    ]);
    assert.equal(retainedImage.ok, true, retainedImage.stderr);
    const effectiveStore = JSON.parse(execInBox(harness.runner, currentId, [
        'podman', 'info', '--format', 'json',
    ])).store;
    assert.equal(effectiveStore.configFile, '/home/podman/.config/containers/storage.conf');
    assert.equal(effectiveStore.graphRoot, '/home/podman/.local/share/containers/storage');
    assert.equal(effectiveStore.runRoot, '/tmp/storage-run-1000');
    assert.equal(
        effectiveStore.volumePath,
        '/home/podman/.local/share/containers/storage/volumes',
    );
    assert.equal(effectiveStore.transientStore, true);
    assertNestedRoutingAndSecretBoundary(currentId, harness);

    const restartTraceStart = readProxyTrace(tracePath).length;
    const stoppedForReuse = publicCommand(['stop']);
    assert.equal(stoppedForReuse.status, 0, stoppedForReuse.stderr);
    const stoppedInspection = harness.runner.query('podman', [
        'container', 'inspect', currentIdentity.instance,
    ]);
    assert.equal(stoppedInspection.ok, true, stoppedInspection.stderr);
    const stoppedRecord = JSON.parse(stoppedInspection.stdout)[0];
    assert.equal(String(stoppedRecord?.Id || ''), currentId);
    assert.equal(stoppedRecord?.State?.Running, false);

    const restarted = publicCommand(publicGraphArgs);
    assert.equal(restarted.status, 0, restarted.stderr);
    const restartedInspection = harness.runner.query('podman', [
        'container', 'inspect', currentIdentity.instance,
    ]);
    assert.equal(restartedInspection.ok, true, restartedInspection.stderr);
    const restartedRecord = JSON.parse(restartedInspection.stdout)[0];
    assert.equal(String(restartedRecord?.Id || ''), currentId);
    assert.equal(restartedRecord?.State?.Running, true);
    assertNestedRoutingAndSecretBoundary(currentId, harness);
    const restartTrace = readProxyTrace(tracePath).slice(restartTraceStart);
    const restartArgv = restartTrace.filter((record) => record[0] === 'argv')
        .map((record) => record.slice(1));
    assert.equal(restartArgv.some((argv) => argv[0] === 'pull'), false);
    assert.equal(restartArgv.some((argv) => (
        argv[0] === 'container' && ['create', 'rm', 'remove'].includes(argv[1])
    )), false);
    captureCandidateEvidence({
        runner: harness.runner,
        diagnostic: (message) => t.diagnostic(message),
        name: 'public-cli-stop-start',
        candidateReference,
        beforeContainerId: currentId,
        afterContainerId: String(restartedRecord?.Id || ''),
        inspected: restartedRecord,
        restartTrace,
        verified: {
            healthConfirmed: true,
            sameContainerId: true,
            secretBoundaryConfirmed: true,
        },
    });

    const trace = readProxyTrace(tracePath);
    const argvTrace = trace.filter((record) => record[0] === 'argv')
        .map((record) => record.slice(1));
    const rewrites = trace.filter((record) => record[0] === 'rewrite');
    assert.ok(rewrites.length >= 2);
    for (const rewrite of rewrites) {
        assert.deepEqual(rewrite, ['rewrite', logicalReference, candidateReference]);
    }
    assert.equal(trace.some((record) => record[0] === 'reject'), false);
    // The outer supervisor owns no engine volume: no volume subcommand may
    // ever reach the candidate engine from the host side.
    assert.equal(argvTrace.some((argv) => argv[0] === 'volume'), false);
    assert.equal(argvTrace.some((argv) => (
        argv.includes('--volumes') || argv.some((value) => String(value).endsWith(':U'))
    )), false);
    const logicalCalls = argvTrace.filter((argv) => argv.includes(logicalReference));
    assert.ok(logicalCalls.length >= 2);
    for (const argv of logicalCalls) {
        const allowed = (
            argv.length === 2 && argv[0] === 'pull' && argv[1] === logicalReference
        ) || (
            argv.length === 3 && argv[0] === 'image' && argv[1] === 'inspect'
            && argv[2] === logicalReference
        );
        assert.equal(allowed, true, `unexpected logical-ref call: ${argv.join(' ')}`);
    }
    const creates = argvTrace.filter((argv) => argv[0] === 'container' && argv[1] === 'create');
    assert.ok(creates.length >= 1);
    assert.match(creates.at(-1).at(-1), /^(?:sha256:)?[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(trace).includes('docker.io/attacker'), false);
    assert.equal(JSON.stringify(trace).includes('attacker-engine'), false);
    assert.equal(JSON.stringify(trace).includes('attacker-instance'), false);

    const traceArtifact = process.env.PLOINKY_BOX_PROXY_TRACE_ARTIFACT;
    if (traceArtifact) {
        assert.equal(path.isAbsolute(traceArtifact), true,
            'PLOINKY_BOX_PROXY_TRACE_ARTIFACT must be absolute');
        fs.mkdirSync(path.dirname(traceArtifact), { recursive: true });
        fs.copyFileSync(tracePath, traceArtifact, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(traceArtifact, 0o600);
    }

    publicCommand(['stop']);
    publicCommand(['destroy'], { input: 'yes\n' });
    fs.rmSync(proxy.directory, { recursive: true, force: true });
    assert.equal(fs.existsSync(proxy.directory), false);
    assert.equal(treeContainsBytes(packageRoot, candidateReference), false);
    assert.equal(treeContainsBytes(repositoryRoot, candidateReference, {
        skip: new Set(['.git', 'node_modules']),
    }), false);
    assert.equal(fs.readFileSync(archive).includes(Buffer.from(candidateReference)), false);
});
