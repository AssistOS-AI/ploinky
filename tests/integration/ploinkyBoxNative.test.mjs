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
import {
    createPodmanHarness,
    execInBox,
    requirePodmanCandidate,
} from '../e2e/ploinkyBox/nativeHelpers.mjs';

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
    for (const name of Object.values(harness.identity.volumes)) {
        assert.equal(exactResourceExists(harness, 'volume', name), false);
    }
    const claimed = harness.runner.query('podman', [
        'container', 'ls', '--all', '--quiet', '--filter',
        `label=io.assistos.ploinky-box.path-hash=${harness.identity.pathHash}`,
    ]);
    assert.equal(claimed.ok, true, claimed.stderr);
    assert.equal(String(claimed.stdout || '').trim(), '');
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

function readDependencyVolumeFile(harness, relativePath) {
    const result = harness.runner.query('podman', [
        'run', '--rm', '--network=none',
        '--entrypoint', '/bin/cat',
        '--volume', `${harness.identity.volumes.dependencies}:/deps:ro`,
        harness.candidateReference,
        `/deps/${relativePath}`,
    ], { timeoutMs: 120_000 });
    assert.equal(result.ok, true, result.stderr);
    return String(result.stdout || '').trim();
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
    assert.deepEqual(fs.readdirSync(path.join(harness.workspace, '.ploinky')), [],
        'the host identity anchor must remain empty');
    assert.equal(fs.existsSync(path.join(harness.child, '.ploinky')), false);
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
        ['achillesAgentLib', '42894def87b4fd2d59a8ce01fea7e25cdc7881ba'],
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
    const nestedVolume = `ploinky-box-t26-${harness.identity.pathHash.slice(0, 12)}`;
    writeNestedVolumeCanary(harness, started.containerId, nestedVolume, 'nested-retained');
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

    await harness.supervisor.runStopTransaction();
    assert.equal(harness.supervisor.inspectBoxStatus().state, 'stopped');
    const stoppedContainer = harness.supervisor.inspectBoxStatus().ownership.handles.container.id;
    assert.equal(readDependencyVolumeFile(
        harness,
        '.ploinky-box-dependencies.json',
    ), 'corrupt');
    await harness.supervisor.runDestroyTransaction(stoppedContainer);
    assert.equal(harness.supervisor.inspectBoxStatus().state, 'absent-retained-volumes');
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
    assert.equal(readNestedVolumeCanary(
        harness, recreated.containerId, nestedVolume,
    ), 'nested-retained');
    assert.equal(queryInBox(harness, recreated.containerId, [
        'podman', 'image', 'inspect', nestedImageId,
    ]).ok, true);
    for (const volume of Object.values(harness.identity.volumes)) {
        assert.equal(exactResourceExists(harness, 'volume', volume), true);
    }
    await harness.supervisor.runDestroyTransaction(recreated.containerId);

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
        assert.equal(harness.supervisor.inspectBoxStatus().state, 'absent-retained-volumes');
    } finally {
        await new Promise((resolve) => selectedUdp.close(resolve));
    }

    await harness.cleanup();
    const foreignResources = [
        ['container', harness.identity.instance],
        ...Object.values(harness.identity.volumes).map((name) => ['volume', name]),
    ];
    for (const [kind, name] of foreignResources) {
        const created = kind === 'container'
            ? harness.runner.query('podman', [
                'container', 'create', '--name', name, '--entrypoint', '/bin/true',
                candidateReference,
            ])
            : harness.runner.query('podman', ['volume', 'create', name]);
        assert.equal(created.ok, true, created.stderr);
        await assert.rejects(
            harness.supervisor.prepareBoxForCommand({ imageRef: candidateReference }),
            /exact-name resource .* is not owned by this Box/,
        );
        if (kind === 'container') {
            const record = JSON.parse(harness.runner.query('podman', [
                'container', 'inspect', name,
            ]).stdout)[0];
            removeContainerById({ name: 'podman' }, record.Id, harness.runner);
        } else {
            harness.runner.run('podman', ['volume', 'rm', name]);
        }
    }
});

test('failed candidate create removes the container and every transaction-created volume', {
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
    const volumeFingerprints = Object.fromEntries(Object.entries(
        original.ownership.handles.volumes,
    ).map(([key, handle]) => [key, handle.fingerprint]));
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
    assert.deepEqual(Object.fromEntries(Object.entries(
        restored.ownership.handles.volumes,
    ).map(([key, handle]) => [key, handle.fingerprint])), volumeFingerprints);
    assert.equal(execInBox(harness.runner, restored.ownership.handles.container.id, [
        'cat', '/workspace/replacement-canary',
    ]), 'replacement-retained');
    const claimed = harness.runner.query('podman', [
        'container', 'ls', '--all', '--quiet', '--filter',
        `label=io.assistos.ploinky-box.path-hash=${harness.identity.pathHash}`,
    ]);
    assert.equal(String(claimed.stdout || '').trim().split(/\s+/).filter(Boolean).length, 1);
});

test('immutable-ID removal cleans an attached anonymous volume', {
    timeout: 5 * 60_000,
}, async (t) => {
    const candidateReference = requirePodmanCandidate(t);
    if (!candidateReference) return;
    const harness = createPodmanHarness(t, candidateReference);
    const created = harness.runner.query('podman', [
        'container', 'create', '--volume', '/anonymous', '--entrypoint', '/bin/true',
        candidateReference,
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
    assert.equal(exactResourceExists(harness, 'volume', volumeName), false);
});
