import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { parseOuterArguments } from '../../ploinky-box/command/parse.mjs';
import { buildContainerExecArgs } from '../../ploinky-box/command/execute.mjs';
import { routeOuterCommand } from '../../ploinky-box/command/route.mjs';
import { BOX_MEDIA_PORT } from '../../ploinky-box/constants.mjs';
import { resolveWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import {
    removeContainerById,
    waitForReadyLine,
} from '../../ploinky-box/lifecycle/container.mjs';
import { reconcileBoxContainer } from '../../ploinky-box/lifecycle/transactions.mjs';
import { readSmokeGraphInputs, stageSmokeGraph } from '../../ploinky-box/smoke/graph.mjs';
import { checkBoxHealth } from '../../ploinky-box/supervisor.mjs';
import { inspectWorkspaceDataPaths } from '../../ploinky-box/workspace-data.mjs';
import {
    createPodmanHarness,
    execInBox,
    requirePodmanCandidate,
} from '../e2e/ploinkyBox/nativeHelpers.mjs';

// The supervisor defaults its read-only source bind to the repository root.
const repositoryRoot = path.resolve(import.meta.dirname, '../..');

function queryInBox(harness, containerId, argv) {
    return harness.runner.query('podman', [
        'container', 'exec', '--user', 'podman', '--workdir', '/workspace',
        containerId, ...argv,
    ], { timeoutMs: 120_000 });
}

function findNestedExplorer(harness, containerId) {
    return JSON.parse(execInBox(harness.runner, containerId, [
        '/usr/local/bin/node', '-e', [
            "const f=require('node:fs');",
            "const a=JSON.parse(f.readFileSync('/workspace/.ploinky/agents.json'));",
            "const r=JSON.parse(f.readFileSync('/workspace/.ploinky/routing.json'));",
            "const name=r.static&&r.static.container;const v=name&&a[name];",
            "if(!v||v.repoName!=='AchillesIDE'||v.agentName!=='explorer'||v.runtime!=='podman'||!(/^[a-f0-9]{64}$/.test(v.containerId||'')))process.exit(4);",
            "process.stdout.write(JSON.stringify({name,id:v.containerId,repoName:v.repoName,agentName:v.agentName}));",
        ].join(''),
    ]));
}

function exactResourceExists(harness, kind, name) {
    return harness.runner.query('podman', [kind, 'inspect', name]).ok;
}

function assertIdentityResourcesAbsent(harness) {
    assert.equal(exactResourceExists(harness, 'container', harness.identity.instance), false);
    const claimed = harness.runner.query('podman', [
        'container', 'ls', '--all', '--quiet', '--filter',
        `label=io.assistos.ploinky-box.path-hash=${harness.identity.pathHash}`,
    ]);
    assert.equal(claimed.ok, true, claimed.stderr);
    assert.equal(String(claimed.stdout || '').trim(), '');
}

// The workspace-backed design owns no engine volume at all, so any labelled
// volume for this identity would be a hard-cut regression.
function assertNoOwnedNamedVolume(harness) {
    const labelled = harness.runner.query('podman', [
        'volume', 'ls', '--quiet', '--filter',
        `label=io.assistos.ploinky-box.path-hash=${harness.identity.pathHash}`,
    ]);
    assert.equal(labelled.ok, true, labelled.stderr);
    assert.equal(String(labelled.stdout || '').trim(), '');
    for (const suffix of ['images', 'ploinky-deps', 'containers', 'workspace']) {
        assert.equal(
            exactResourceExists(harness, 'volume', `${harness.identity.instance}-${suffix}`),
            false,
        );
    }
}

function boxMounts(harness, containerId) {
    const inspected = harness.runner.query('podman', ['container', 'inspect', containerId]);
    assert.equal(inspected.ok, true, inspected.stderr);
    return JSON.parse(inspected.stdout)[0].Mounts;
}

function assertExactBindMounts(harness, containerId, repositoryRoot) {
    const observed = boxMounts(harness, containerId)
        .map((mount) => ({
            type: String(mount.Type || '').toLowerCase(),
            source: String(mount.Source || ''),
            destination: String(mount.Destination || ''),
            rw: mount.RW === true,
        }))
        .sort((left, right) => left.destination.localeCompare(right.destination));
    assert.deepEqual(observed, [
        {
            type: 'bind',
            source: harness.identity.dataPaths.images,
            destination: '/home/podman/.local/share/ploinky-images',
            rw: true,
        },
        { type: 'bind', source: repositoryRoot, destination: '/opt/ploinky', rw: false },
        {
            type: 'bind',
            source: harness.identity.dataPaths.dependencies,
            destination: '/opt/ploinky/node_modules',
            rw: true,
        },
        { type: 'bind', source: harness.identity.workspaceRoot, destination: '/workspace', rw: true },
    ]);
}

function assertBoxCacheDirectoriesExist(harness) {
    for (const target of Object.values(harness.identity.dataPaths)) {
        assert.equal(fs.statSync(target).isDirectory(), true, target);
    }
}

function writeNestedVolumeCanary(harness, containerId, volumeName, value) {
    execInBox(harness.runner, containerId, ['podman', 'volume', 'create', volumeName]);
    execInBox(harness.runner, containerId, [
        'bash', '-lc',
        'mountpoint="$(podman volume inspect --format "{{.Mountpoint}}" "$1")"; printf "%s" "$2" > "$mountpoint/canary"',
        'bash', volumeName, value,
    ]);
}

function readNestedVolumeCanary(harness, containerId, volumeName) {
    return execInBox(harness.runner, containerId, [
        'bash', '-lc',
        'mountpoint="$(podman volume inspect --format "{{.Mountpoint}}" "$1")"; cat "$mountpoint/canary"',
        'bash', volumeName,
    ]);
}

function nestedResourceExists(harness, containerId, kind, name) {
    return queryInBox(harness, containerId, ['podman', kind, 'inspect', name]).ok;
}

function effectiveNestedStorage(harness, containerId) {
    const raw = execInBox(harness.runner, containerId, [
        'podman', 'info', '--format', 'json',
    ]);
    const store = JSON.parse(raw).store;
    return {
        configFile: String(store.configFile || ''),
        driver: String(store.graphDriverName || ''),
        graphRoot: String(store.graphRoot || ''),
        runRoot: String(store.runRoot || ''),
        volumePath: String(store.volumePath || ''),
        transientStore: store.transientStore === true,
    };
}

function assertIntendedNestedStorage(harness, containerId) {
    assert.deepEqual(effectiveNestedStorage(harness, containerId), {
        configFile: '/home/podman/.config/containers/storage.conf',
        driver: 'overlay',
        graphRoot: '/home/podman/.local/share/containers/storage',
        runRoot: '/tmp/storage-run-1000',
        volumePath: '/home/podman/.local/share/containers/storage/volumes',
        transientStore: true,
    });
    // The durable cache must be the imagestore, proven on disk because
    // podman info reports store.imageStore as an image count, not a path.
    assert.equal(execInBox(harness.runner, containerId, [
        'test', '-d', '/home/podman/.local/share/ploinky-images/overlay-images',
    ]), '');
}

// The dependency cache is a plain host directory now, so the host can read it
// directly without borrowing a container.
function readDependencyCacheFile(harness, relativePath) {
    return fs.readFileSync(
        path.join(harness.identity.dataPaths.dependencies, relativePath),
        'utf8',
    ).trim();
}

test('rootless Podman exercises the complete public lifecycle on one workspace identity', {
    timeout: 30 * 60_000,
}, async (t) => {
    const candidateReference = requirePodmanCandidate(t);
    if (!candidateReference) return;
    const harness = createPodmanHarness(t, candidateReference);
    fs.writeFileSync(path.join(harness.workspace, 'host-visible.txt'), 'host-visible');
    fs.mkdirSync(path.join(harness.workspace, 'host-visible-folder'));
    fs.writeFileSync(path.join(harness.child, 'host-visible-child.txt'), 'host-visible-child');
    const graph = readSmokeGraphInputs(process.env, { runner: harness.runner });
    const selectedMediaHostPort = 17891;
    const startRoute = routeOuterCommand(parseOuterArguments([
        '--udp-port', String(selectedMediaHostPort), ...graph.args,
    ]));
    assert.equal(startRoute.kind, 'start');
    assert.ok(startRoute.hostPort && startRoute.hostPort !== 8080,
        'candidate lifecycle start must exercise a custom public port');
    assert.equal(startRoute.mediaHostPort, selectedMediaHostPort);

    const prepared = await harness.supervisor.prepareBoxForCommand({ imageRef: candidateReference });
    assert.equal(fs.existsSync(path.join(harness.workspace, '.ploinky')), true);
    assert.deepEqual(fs.readdirSync(path.join(harness.workspace, '.ploinky')).sort(),
        ['box', 'master-key'],
        'the host identity anchor must retain only the Box master key and cache root');
    assert.equal(fs.existsSync(path.join(harness.child, '.ploinky')), false);
    // Workspace-backed persistence: both cache directories exist on the real
    // host, back the Box through exact bind mounts, and no named volume exists.
    assertBoxCacheDirectoriesExist(harness);
    assert.deepEqual(
        fs.readdirSync(harness.identity.boxDataRoot).sort(),
        ['dependencies', 'images'],
    );
    assertExactBindMounts(harness, prepared.containerId, repositoryRoot);
    assertNoOwnedNamedVolume(harness);
    assert.equal(prepared.ownership.handles.container.runtime.running, true);
    assert.deepEqual(prepared.ownership.handles.container.runtime.publications, [
        { containerPort: '7882', protocol: 'udp', hostIp: '0.0.0.0', hostPort: '7882' },
        { containerPort: '8080', protocol: 'tcp', hostIp: '127.0.0.1', hostPort: '8080' },
    ]);
    assert.equal(prepared.ownership.handles.container.runtime.publications
        .some((entry) => entry.containerPort === '8081'), false);
    assert.equal(execInBox(harness.runner, prepared.containerId, [
        'cat', '/workspace/host-visible.txt',
    ]), 'host-visible');
    assert.equal(execInBox(harness.runner, prepared.containerId, [
        'test', '-d', '/workspace/host-visible-folder',
    ]), '');
    stageSmokeGraph({ graph, containerId: prepared.containerId, runner: harness.runner });

    harness.useChild();
    const childIdentity = harness.resolveIdentity();
    assert.equal(childIdentity.instance, harness.identity.instance);
    assert.equal(childIdentity.workspaceRoot, harness.workspace);
    const explicitChild = resolveWorkspaceIdentity({ env: {}, cwd: () => harness.child });
    assert.equal(explicitChild.instance, harness.identity.instance);
    assert.match(harness.supervisor.inspectBoxStatus().state, /^running-/);

    const generic = routeOuterCommand(parseOuterArguments(['list', 'agents']));
    assert.equal(generic.kind, 'generic');
    const genericPrepared = await harness.supervisor.prepareBoxForCommand({
        imageRef: candidateReference,
    });
    const genericResult = harness.runner.query('podman', buildContainerExecArgs(
        genericPrepared.containerId,
        generic.coreArgv,
        {
            hostPort: genericPrepared.hostPort,
            mediaHostPort: genericPrepared.mediaHostPort,
        },
    ), { timeoutMs: 120_000 });
    assert.equal(genericResult.ok, true, genericResult.stderr);

    const repl = routeOuterCommand(parseOuterArguments([]));
    assert.equal(repl.kind, 'repl');
    const replPrepared = await harness.supervisor.prepareBoxForCommand({
        imageRef: candidateReference,
    });
    const replArgs = buildContainerExecArgs(replPrepared.containerId, repl.coreArgv, {
        hostPort: replPrepared.hostPort,
        mediaHostPort: replPrepared.mediaHostPort,
        interactive: true,
        inputIsTty: false,
        outputIsTty: false,
    });
    assert.deepEqual(replArgs.slice(-2), [replPrepared.containerId, '/opt/ploinky/bin/ploinky-local']);
    assert.equal(replArgs.includes('--tty'), false);

    const directExternal = queryInBox(harness, replPrepared.containerId, [
        'bash', '-c', [
            'mkdir -p /tmp/ploinky-repl-no-which-path',
            'ln -sf /usr/bin/ls /tmp/ploinky-repl-no-which-path/ls',
            "PATH=/tmp/ploinky-repl-no-which-path /usr/local/bin/node --input-type=module -e \"const m=await import('/opt/ploinky/cli/commands/llmSystemCommands.js');const ok=await m.handleSystemCommand('ls',['/workspace/host-visible.txt']);if(!ok)process.exit(42)\"",
        ].join(' && '),
    ]);
    assert.equal(directExternal.ok, true, directExternal.stderr);
    assert.match(directExternal.stdout, /host-visible\.txt/);

    const keyEvidence = execInBox(harness.runner, prepared.containerId, [
        'bash', '-c', 'stat -c %a /workspace/.ploinky/master-key; sha256sum /workspace/.ploinky/master-key',
    ]).split(/\n/);
    assert.equal(keyEvidence[0], '600');
    assert.match(keyEvidence[1], /^[a-f0-9]{64}\s/);
    for (const [repository, revision] of [
        ['mcp-sdk', '7efe9d17f52a625743e411089d3a6879f6f89156'],
        ['achillesAgentLib', '975e7a318e1c8c8d1792ec96fe7b820fc465d1f5'],
    ]) {
        assert.equal(execInBox(harness.runner, prepared.containerId, [
            'git', '-C', `/opt/ploinky/node_modules/${repository}`, 'rev-parse', 'HEAD',
        ]), revision);
    }
    const innerInfo = JSON.parse(execInBox(harness.runner, prepared.containerId, [
        'podman', 'info', '--format', 'json',
    ]));
    assert.equal(innerInfo.host?.security?.rootless ?? innerInfo.Host?.Security?.Rootless, true);

    const concurrent = await Promise.all([
        harness.supervisor.prepareBoxForCommand({ imageRef: candidateReference }),
        harness.supervisor.prepareBoxForCommand({ imageRef: candidateReference }),
    ]);
    assert.equal(concurrent[0].containerId, concurrent[1].containerId);

    const started = await harness.supervisor.runStartTransaction(startRoute.coreArgv, {
        explicitPort: startRoute.hostPort,
        explicitMediaPort: startRoute.mediaHostPort,
        imageRef: candidateReference,
    });
    await checkBoxHealth(startRoute.hostPort);
    assert.match(harness.output.bytes,
        new RegExp(`Dashboard: http://127\\.0\\.0\\.1:${startRoute.hostPort}/dashboard`));
    assert.doesNotMatch(harness.output.bytes,
        /Dashboard: http:\/\/127\.0\.0\.1:8080\/dashboard/);
    assert.equal(started.ownership.handles.container.runtime.publications.some((entry) => (
        entry.protocol === 'tcp'
        && entry.hostPort === String(startRoute.hostPort)
        && entry.containerPort === '8080'
    )), true);
    assert.equal(started.ownership.handles.container.runtime.publications.some((entry) => (
        entry.protocol === 'udp'
        && entry.hostPort === String(selectedMediaHostPort)
        && entry.containerPort === String(BOX_MEDIA_PORT)
    )), true);
    assert.equal(started.ownership.handles.container.runtime.publications
        .some((entry) => entry.containerPort === '8081'), false);

    const watchdogOptions = JSON.parse(execInBox(harness.runner, started.containerId, [
        '/usr/bin/env',
        'PLOINKY_WATCHDOG_TEST_MODE=1',
        'PORT=8080',
        `PLOINKY_PUBLIC_AUTHORITY=127.0.0.1:${startRoute.hostPort}`,
        '/usr/local/bin/node', '--input-type=module', '-e', [
            "const m=await import('/opt/ploinky/cli/server/Watchdog.js');",
            'process.stdout.write(JSON.stringify(m.buildHealthCheckRequestOptions()));',
        ].join(''),
    ]));
    assert.equal(watchdogOptions.hostname, '127.0.0.1');
    assert.equal(Number(watchdogOptions.port), 8080);
    assert.equal(watchdogOptions.headers.Host, `127.0.0.1:${startRoute.hostPort}`);

    const agent = findNestedExplorer(harness, started.containerId);
    assert.equal(agent.repoName, 'AchillesIDE');
    assert.equal(agent.agentName, 'explorer');
    assert.equal(execInBox(harness.runner, started.containerId, [
        'podman', 'container', 'exec', agent.id,
        'cat', '/workspace/host-visible.txt',
    ]), 'host-visible');
    assert.equal(execInBox(harness.runner, started.containerId, [
        'podman', 'container', 'exec', agent.id,
        'cat', '/workspace/child/host-visible-child.txt',
    ]), 'host-visible-child');
    execInBox(harness.runner, started.containerId, [
        'podman', 'container', 'exec', agent.id,
        '/bin/sh', '-c', [
            'mkdir -p /workspace/agent-created-folder',
            'printf agent-created > /workspace/agent-created-folder/from-agent.txt',
            'mkdir -p /workspace/child/agent-created-nested',
            'printf nested-agent-created > /workspace/child/agent-created-nested/from-agent.txt',
            'printf persisted > /workspace/.ploinky/from-agent.txt',
        ].join('; '),
    ]);
    assert.equal(fs.readFileSync(
        path.join(harness.workspace, 'agent-created-folder', 'from-agent.txt'),
        'utf8',
    ), 'agent-created');
    assert.equal(fs.readFileSync(
        path.join(harness.child, 'agent-created-nested', 'from-agent.txt'),
        'utf8',
    ), 'nested-agent-created');
    assert.equal(fs.readFileSync(
        path.join(harness.workspace, '.ploinky', 'from-agent.txt'),
        'utf8',
    ), 'persisted');
    for (const createdPath of [
        path.join(harness.workspace, 'agent-created-folder'),
        path.join(harness.workspace, 'agent-created-folder', 'from-agent.txt'),
        path.join(harness.child, 'agent-created-nested'),
        path.join(harness.child, 'agent-created-nested', 'from-agent.txt'),
        path.join(harness.workspace, '.ploinky', 'from-agent.txt'),
    ]) {
        assert.equal(fs.statSync(createdPath).uid, process.getuid());
    }
    const nestedImageId = execInBox(harness.runner, started.containerId, [
        'podman', 'container', 'inspect', '--format', '{{.Image}}', agent.id,
    ]);
    assert.match(nestedImageId, /^(?:sha256:)?[a-f0-9]{64}$/);
    assertIntendedNestedStorage(harness, started.containerId);
    const nestedContainerId = execInBox(harness.runner, started.containerId, [
        'podman', 'container', 'inspect', '--format', '{{.Id}}', agent.id,
    ]);
    assert.match(nestedContainerId, /^[a-f0-9]{64}$/);
    const nestedVolume = `ploinky-box-t26-${harness.identity.pathHash.slice(0, 12)}`;
    writeNestedVolumeCanary(harness, started.containerId, nestedVolume, 'nested-retained');
    assert.equal(readNestedVolumeCanary(
        harness, started.containerId, nestedVolume,
    ), 'nested-retained');
    execInBox(harness.runner, started.containerId, [
        'bash', '-c', [
            "printf workspace-retained > /workspace/t26-workspace-canary",
            "printf dependencies-retained > /opt/ploinky/node_modules/t26-dependencies-canary",
            "printf 'corrupt\\n' > /opt/ploinky/node_modules/.ploinky-box-dependencies.json",
            'chmod 500 /opt/ploinky/node_modules/achillesAgentLib',
        ].join('; '),
    ]);
    assert.equal(fs.readFileSync(
        path.join(harness.workspace, 't26-workspace-canary'),
        'utf8',
    ), 'workspace-retained');

    assert.equal(readDependencyCacheFile(
        harness,
        '.ploinky-box-dependencies.json',
    ), 'corrupt');
    // Destroy the live Box directly. The supervisor must stop the nested graph
    // before stopping and removing the outer container.
    const destroyed = await harness.supervisor.runDestroyTransaction(started.containerId);
    assert.equal(destroyed.deletedCache, false);
    assert.equal(harness.supervisor.inspectBoxStatus().state, 'absent');
    // Default destroy retains every byte of workspace-backed cache data.
    assertBoxCacheDirectoriesExist(harness);
    assertNoOwnedNamedVolume(harness);
    assert.equal(
        fs.readFileSync(path.join(
            harness.identity.dataPaths.dependencies, 't26-dependencies-canary',
        ), 'utf8'),
        'dependencies-retained',
    );
    assert.ok(fs.readdirSync(harness.identity.dataPaths.images).length > 0,
        'the workspace-backed image store must retain content across destroy');
    const recreated = await harness.supervisor.prepareBoxForCommand({ imageRef: candidateReference });
    const recreatedKeyEvidence = execInBox(harness.runner, recreated.containerId, [
        'sha256sum', '/workspace/.ploinky/master-key',
    ]);
    assert.equal(recreatedKeyEvidence.split(/\s/)[0], keyEvidence[1].split(/\s/)[0]);
    assert.equal(execInBox(harness.runner, recreated.containerId, [
        'cat', '/workspace/t26-workspace-canary',
    ]), 'workspace-retained');
    assert.equal(execInBox(harness.runner, recreated.containerId, [
        'cat', '/opt/ploinky/node_modules/t26-dependencies-canary',
    ]), 'dependencies-retained');
    // Generation-specific nested state must not cross the outer Box boundary.
    assert.equal(nestedResourceExists(
        harness, recreated.containerId, 'volume', nestedVolume,
    ), false);
    assert.equal(nestedResourceExists(
        harness, recreated.containerId, 'container', nestedContainerId,
    ), false);
    // Reusable image content is exactly what does survive.
    assert.equal(queryInBox(harness, recreated.containerId, [
        'podman', 'image', 'inspect', nestedImageId,
    ]).ok, true);
    assertIntendedNestedStorage(harness, recreated.containerId);
    assertExactBindMounts(harness, recreated.containerId, repositoryRoot);
    assertNoOwnedNamedVolume(harness);

    // Explicit cache reset deletes exactly the two Box directories and leaves
    // every other workspace and .ploinky file untouched.
    fs.writeFileSync(path.join(harness.workspace, '.ploinky', 'unrelated.json'), '{"kept":true}');
    const reset = await harness.supervisor.runDestroyTransaction(recreated.containerId, {
        deleteCache: true,
    });
    assert.equal(reset.deletedCache, true);
    assert.deepEqual(reset.deletedPaths, [
        harness.identity.dataPaths.dependencies,
        harness.identity.dataPaths.images,
    ]);
    assert.equal(fs.existsSync(harness.identity.boxDataRoot), false);
    // Only `box` disappears. The anchor holds workspace state written by the
    // graph and by nested agents, so assert the property rather than an exact
    // listing: `box` is gone and every other named entry survives.
    const anchorEntries = fs.readdirSync(path.join(harness.workspace, '.ploinky'));
    assert.equal(anchorEntries.includes('box'), false);
    for (const kept of ['master-key', 'unrelated.json', 'from-agent.txt']) {
        assert.equal(anchorEntries.includes(kept), true, `.ploinky/${kept} must survive`);
    }
    assert.equal(fs.readFileSync(
        path.join(harness.workspace, 't26-workspace-canary'), 'utf8',
    ), 'workspace-retained');
    assertNoOwnedNamedVolume(harness);

    // A clean rebuild recreates both cache directories and reinstalls the
    // pinned dependencies from scratch.
    const rebuilt = await harness.supervisor.prepareBoxForCommand({ imageRef: candidateReference });
    assertBoxCacheDirectoriesExist(harness);
    assertExactBindMounts(harness, rebuilt.containerId, repositoryRoot);
    assert.equal(fs.existsSync(path.join(
        harness.identity.dataPaths.dependencies, 't26-dependencies-canary',
    )), false);
    assert.match(readDependencyCacheFile(harness, '.ploinky-box-dependencies.json'), /^\{/);
    assert.equal(execInBox(harness.runner, rebuilt.containerId, [
        'test', '-d', '/opt/ploinky/node_modules/achillesAgentLib',
    ]), '');
    await harness.supervisor.runDestroyTransaction(rebuilt.containerId);

    const udp = dgram.createSocket('udp4');
    await new Promise((resolve, reject) => {
        udp.once('error', reject);
        udp.bind(BOX_MEDIA_PORT, '0.0.0.0', resolve);
    });
    try {
        const remapped = await harness.supervisor.prepareBoxForCommand({
            explicitMediaPort: selectedMediaHostPort,
            imageRef: candidateReference,
        });
        assert.equal(remapped.mediaHostPort, selectedMediaHostPort);
        assert.equal(remapped.ownership.handles.container.runtime.publications.some((entry) => (
            entry.protocol === 'udp'
            && entry.hostPort === String(selectedMediaHostPort)
            && entry.containerPort === String(BOX_MEDIA_PORT)
        )), true);
        await harness.supervisor.runDestroyTransaction(remapped.containerId);
    } finally {
        await new Promise((resolve) => udp.close(resolve));
    }

    const selectedUdp = dgram.createSocket('udp4');
    await new Promise((resolve, reject) => {
        selectedUdp.once('error', reject);
        selectedUdp.bind(selectedMediaHostPort, '0.0.0.0', resolve);
    });
    try {
        await assert.rejects(
            harness.supervisor.prepareBoxForCommand({
                explicitMediaPort: selectedMediaHostPort,
                imageRef: candidateReference,
            }),
            new RegExp(`UDP|${selectedMediaHostPort}|already reserved`, 'i'),
        );
        assert.equal(harness.supervisor.inspectBoxStatus().state, 'absent');
    } finally {
        await new Promise((resolve) => selectedUdp.close(resolve));
    }

    await harness.cleanup();
    // A foreign exact-name container still fails closed.
    const foreignName = harness.identity.instance;
    const createdForeign = harness.runner.query('podman', [
        'container', 'create', '--name', foreignName, '--entrypoint', '/bin/true',
        candidateReference,
    ]);
    assert.equal(createdForeign.ok, true, createdForeign.stderr);
    await assert.rejects(
        harness.supervisor.prepareBoxForCommand({ imageRef: candidateReference }),
        /exact-name resource .* is not owned by this Box/,
    );
    const foreignRecord = JSON.parse(harness.runner.query('podman', [
        'container', 'inspect', foreignName,
    ]).stdout)[0];
    removeContainerById({ name: 'podman' }, foreignRecord.Id, harness.runner);

    // Retired labelled named volumes are inert: they neither claim ownership
    // nor block a new Box, and nothing removes them automatically.
    const retiredVolume = `${harness.identity.instance}-ploinky-deps`;
    const createdRetired = harness.runner.query('podman', [
        'volume', 'create',
        '--label', `io.assistos.ploinky-box.path-hash=${harness.identity.pathHash}`,
        '--label', 'io.assistos.ploinky-box.role=ploinky-deps',
        retiredVolume,
    ]);
    assert.equal(createdRetired.ok, true, createdRetired.stderr);
    try {
        const ignoring = await harness.supervisor.prepareBoxForCommand({
            imageRef: candidateReference,
        });
        assertExactBindMounts(harness, ignoring.containerId, repositoryRoot);
        await harness.supervisor.runDestroyTransaction(ignoring.containerId, {
            deleteCache: true,
        });
        // Destroy never touches the retired volume either.
        assert.equal(exactResourceExists(harness, 'volume', retiredVolume), true);
    } finally {
        harness.runner.run('podman', ['volume', 'rm', retiredVolume]);
    }
});

// The discriminating constraint of workspace-backed persistence: the inner
// Podman store must be able to unpack image layers onto the physical host
// directory, including macOS Podman Machine's virtiofs bind. This gate needs no
// smoke-graph inputs, so it runs anywhere the candidate image is available.
test('the workspace-backed image store unpacks and reuses layers on the physical host', {
    timeout: 20 * 60_000,
}, async (t) => {
    const candidateReference = requirePodmanCandidate(t);
    if (!candidateReference) return;
    const nestedImageRef = String(
        process.env.PLOINKY_BOX_NESTED_PROBE_IMAGE || 'docker.io/library/alpine:latest',
    );
    const harness = createPodmanHarness(t, candidateReference);

    const prepared = await harness.supervisor.prepareBoxForCommand({ imageRef: candidateReference });
    assertExactBindMounts(harness, prepared.containerId, repositoryRoot);
    assertNoOwnedNamedVolume(harness);
    assertIntendedNestedStorage(harness, prepared.containerId);

    // Unpacking a layer is what fails on an unconfigured host bind.
    execInBox(harness.runner, prepared.containerId, [
        'podman', 'pull', nestedImageRef,
    ], { timeoutMs: 600_000 });
    const nestedImageId = execInBox(harness.runner, prepared.containerId, [
        'podman', 'image', 'inspect', '--format', '{{.Id}}', nestedImageRef,
    ]);
    assert.match(nestedImageId, /^(?:sha256:)?[a-f0-9]{64}$/);

    // The layer content is on the real host, not in engine-managed storage.
    const layerRoot = path.join(harness.identity.dataPaths.images, 'overlay');
    assert.equal(fs.statSync(layerRoot).isDirectory(), true);
    assert.ok(fs.readdirSync(layerRoot).some((entry) => /^[a-f0-9]{64}$/.test(entry)),
        'the workspace-backed image store must hold unpacked layer directories');

    // force_mask records the real mode in an xattr; fuse-overlayfs must restore
    // it, so an executable stays executable inside a nested container.
    const nestedRun = execInBox(harness.runner, prepared.containerId, [
        'podman', 'run', '--rm', '--network=none', nestedImageRef,
        'sh', '-c', 'test -x /bin/sh && echo NESTED_EXEC_OK',
    ], { timeoutMs: 300_000 });
    assert.equal(nestedRun, 'NESTED_EXEC_OK');

    await harness.supervisor.runDestroyTransaction(prepared.containerId);
    assertBoxCacheDirectoriesExist(harness);

    const recreated = await harness.supervisor.prepareBoxForCommand({ imageRef: candidateReference });
    // The image survives outer recreation and needs no second pull.
    assert.equal(execInBox(harness.runner, recreated.containerId, [
        'podman', 'image', 'inspect', '--format', '{{.Id}}', nestedImageId,
    ]), nestedImageId);
    assertIntendedNestedStorage(harness, recreated.containerId);
    assertNoOwnedNamedVolume(harness);

    // An explicit cache reset really empties the store.
    await harness.supervisor.runDestroyTransaction(recreated.containerId, { deleteCache: true });
    assert.equal(fs.existsSync(harness.identity.boxDataRoot), false);
    const rebuilt = await harness.supervisor.prepareBoxForCommand({ imageRef: candidateReference });
    assertBoxCacheDirectoriesExist(harness);
    assert.equal(queryInBox(harness, rebuilt.containerId, [
        'podman', 'image', 'inspect', nestedImageId,
    ]).ok, false, 'a reset image store must not still resolve the previous image');
});

test('a replaced live bind source recreates the outer Box before further writes', {
    timeout: 15 * 60_000,
}, async (t) => {
    const candidateReference = requirePodmanCandidate(t);
    if (!candidateReference) return;
    const harness = createPodmanHarness(t, candidateReference);
    const prepared = await harness.supervisor.prepareBoxForCommand({ imageRef: candidateReference });
    const originalState = inspectWorkspaceDataPaths({ identity: harness.identity });
    const displaced = path.join(harness.root, 'displaced-dependencies');

    // Renaming a live bind source preserves the old container's mount inode.
    // Recreate the canonical host path to reproduce the stale-bind condition.
    fs.renameSync(harness.identity.dataPaths.dependencies, displaced);
    fs.mkdirSync(harness.identity.dataPaths.dependencies);
    const replacementState = inspectWorkspaceDataPaths({ identity: harness.identity });
    assert.notEqual(
        replacementState.fingerprints.dependencies,
        originalState.fingerprints.dependencies,
    );
    const staleStatus = harness.supervisor.inspectBoxStatus();
    assert.equal(staleStatus.state, 'incompatible');
    assert.match(staleStatus.detail, /label set is incompatible/);

    const replaced = await harness.supervisor.prepareBoxForCommand({ imageRef: candidateReference });
    assert.equal(replaced.action, 'replaced');
    assert.notEqual(replaced.containerId, prepared.containerId);
    assertExactBindMounts(harness, replaced.containerId, repositoryRoot);
    const record = JSON.parse(harness.runner.query('podman', [
        'container', 'inspect', replaced.containerId,
    ]).stdout)[0];
    assert.equal(
        record.Config.Labels['io.assistos.ploinky-box.dependencies-fingerprint'],
        replacementState.fingerprints.dependencies,
    );

    execInBox(harness.runner, replaced.containerId, [
        'bash', '-c', 'printf canonical-write > /opt/ploinky/node_modules/live-bind-canary',
    ]);
    assert.equal(
        fs.readFileSync(path.join(
            harness.identity.dataPaths.dependencies,
            'live-bind-canary',
        ), 'utf8'),
        'canonical-write',
    );
    assert.equal(fs.existsSync(path.join(displaced, 'live-bind-canary')), false);
});

test('failed candidate create removes the container and retains workspace cache data', {
    timeout: 10 * 60_000,
}, async (t) => {
    const candidateReference = requirePodmanCandidate(t);
    if (!candidateReference) return;
    let injected = false;
    const harness = createPodmanHarness(t, candidateReference, {
        reconcile: (options) => reconcileBoxContainer(options, {
            async waitReady(...args) {
                if (!injected) {
                    injected = true;
                    throw new Error('injected candidate create readiness failure');
                }
                return waitForReadyLine(...args);
            },
        }),
    });
    await assert.rejects(
        harness.supervisor.prepareBoxForCommand({ imageRef: candidateReference }),
        /transaction failed/i,
    );
    assert.equal(injected, true);
    assertIdentityResourcesAbsent(harness);
    assertNoOwnedNamedVolume(harness);
    // Durable workspace state survives a failed transaction.
    assertBoxCacheDirectoriesExist(harness);
});

test('failed candidate replacement restores the validated old Box', {
    timeout: 15 * 60_000,
}, async (t) => {
    const candidateReference = requirePodmanCandidate(t);
    if (!candidateReference) return;
    let armed = false;
    let injected = false;
    const harness = createPodmanHarness(t, candidateReference, {
        reconcile: (options) => reconcileBoxContainer(options, {
            async waitReady(...args) {
                if (armed && !injected) {
                    injected = true;
                    throw new Error('injected candidate replacement readiness failure');
                }
                return waitForReadyLine(...args);
            },
        }),
    });
    const original = await harness.supervisor.prepareBoxForCommand({ imageRef: candidateReference });
    execInBox(harness.runner, original.containerId, [
        'bash', '-c', 'printf replacement-retained > /workspace/replacement-canary',
    ]);
    execInBox(harness.runner, original.containerId, [
        'bash', '-c', 'printf cache-retained > /opt/ploinky/node_modules/replacement-cache-canary',
    ]);
    const cacheInodes = Object.fromEntries(Object.entries(harness.identity.dataPaths)
        .map(([key, target]) => [key, String(fs.statSync(target).ino)]));
    armed = true;
    await assert.rejects(
        harness.supervisor.prepareBoxForCommand({
            explicitPort: 19091,
            explicitMediaPort: 17892,
            imageRef: candidateReference,
        }),
        /transaction failed/i,
    );
    assert.equal(injected, true);
    const restored = harness.supervisor.inspectBoxStatus();
    assert.match(restored.state, /^running-/);
    assert.equal(restored.ownership.handles.container.runtime.publications.some((entry) => (
        entry.protocol === 'tcp' && entry.hostPort === '8080' && entry.containerPort === '8080'
    )), true);
    assert.equal(restored.ownership.handles.container.runtime.publications.some((entry) => (
        entry.protocol === 'udp' && entry.hostPort === '7882' && entry.containerPort === '7882'
    )), true);
    // The restored Box binds the very same cache directories; nothing about
    // the durable workspace state was rolled back.
    assert.deepEqual(Object.fromEntries(Object.entries(harness.identity.dataPaths)
        .map(([key, target]) => [key, String(fs.statSync(target).ino)])), cacheInodes);
    assertExactBindMounts(harness, restored.ownership.handles.container.id, repositoryRoot);
    assertNoOwnedNamedVolume(harness);
    assert.equal(execInBox(harness.runner, restored.ownership.handles.container.id, [
        'cat', '/workspace/replacement-canary',
    ]), 'replacement-retained');
    assert.equal(execInBox(harness.runner, restored.ownership.handles.container.id, [
        'cat', '/opt/ploinky/node_modules/replacement-cache-canary',
    ]), 'cache-retained');
    const claimed = harness.runner.query('podman', [
        'container', 'ls', '--all', '--quiet', '--filter',
        `label=io.assistos.ploinky-box.path-hash=${harness.identity.pathHash}`,
    ]);
    assert.equal(String(claimed.stdout || '').trim().split(/\s+/).filter(Boolean).length, 1);
});

test('immutable-ID removal removes only the container and never a volume', {
    timeout: 5 * 60_000,
}, async (t) => {
    const candidateReference = requirePodmanCandidate(t);
    if (!candidateReference) return;
    const harness = createPodmanHarness(t, candidateReference);
    const imageInspection = harness.runner.query('podman', [
        'image', 'inspect', candidateReference,
    ]);
    assert.equal(imageInspection.ok, true, imageInspection.stderr);
    const candidateImageId = String(JSON.parse(imageInspection.stdout)[0]?.Id || '');
    assert.match(candidateImageId, /^(?:sha256:)?[a-f0-9]{64}$/);
    // A deliberately volume-attached container proves removal is scoped to the
    // container record: Box removal no longer passes a volume flag, and the
    // Box image contract forbids anonymous volumes in the first place.
    const created = harness.runner.query('podman', [
        'container', 'create', '--volume', '/anonymous', '--entrypoint', '/bin/true',
        candidateImageId,
    ], { timeoutMs: 120_000 });
    assert.equal(created.ok, true, created.stderr);
    const containerId = String(created.stdout || '').trim();
    assert.match(containerId, /^[a-f0-9]{12,64}$/);
    const record = JSON.parse(harness.runner.query('podman', [
        'container', 'inspect', containerId,
    ]).stdout)[0];
    const mount = record.Mounts.find((entry) => entry.Destination === '/anonymous');
    assert.ok(mount, 'anonymous mount missing from native container inspection');
    const volumeName = String(mount.Name || path.basename(path.dirname(mount.Source || '')));
    assert.ok(volumeName);
    assert.equal(exactResourceExists(harness, 'volume', volumeName), true);
    removeContainerById({ name: 'podman' }, containerId, harness.runner);
    assert.equal(exactResourceExists(harness, 'container', containerId), false);
    assert.equal(exactResourceExists(harness, 'volume', volumeName), true);
    harness.runner.run('podman', ['volume', 'rm', volumeName]);
});
