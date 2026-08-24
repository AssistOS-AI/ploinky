import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { parseOuterArguments } from '../../ploinky-box/command/parse.mjs';
import { routeOuterCommand } from '../../ploinky-box/command/route.mjs';
import { readSmokeGraphInputs, stageSmokeGraph } from '../../ploinky-box/smoke/graph.mjs';
import {
    createPodmanHarness,
    execInBox,
    requirePodmanCandidate,
    waitForRouterHealth,
} from '../e2e/ploinkyBox/nativeHelpers.mjs';

// The dependency cache is a host directory now, so its tree hash is computed
// directly on the host rather than through a borrowed container.
function hashTree(root, hash = crypto.createHash('sha256'), relative = '') {
    for (const name of fs.readdirSync(root).sort()) {
        const absolute = path.join(root, name);
        const key = path.join(relative, name);
        const stat = fs.lstatSync(absolute);
        hash.update(`${key}\0${stat.mode}\0`);
        if (stat.isDirectory()) hashTree(absolute, hash, key);
        else if (stat.isFile()) hash.update(fs.readFileSync(absolute));
    }
    return hash;
}

function dependencyTreeHash(harness) {
    const digest = hashTree(harness.identity.dataPaths.dependencies).digest('hex');
    assert.match(digest, /^[a-f0-9]{64}$/);
    return digest;
}

function nestedResourceExists(harness, containerId, kind, name) {
    return harness.runner.query('podman', [
        'container', 'exec', '--user', 'podman', '--workdir', '/workspace',
        containerId, 'podman', kind, 'inspect', name,
    ], { timeoutMs: 120_000 }).ok;
}

test('pinned seven-repository graph starts through one immutable Box candidate', {
    timeout: 25 * 60_000,
}, async (t) => {
    const candidateReference = requirePodmanCandidate(t);
    if (!candidateReference) return;
    const harness = createPodmanHarness(t, candidateReference);
    const graph = readSmokeGraphInputs(process.env, { runner: harness.runner });
    const parsed = parseOuterArguments(graph.args);
    const route = routeOuterCommand(parsed);
    assert.equal(route.kind, 'start');
    assert.ok(route.hostPort && route.hostPort !== 8080,
        'smoke graph start must use a custom public host port');

    const prepared = await harness.supervisor.prepareBoxForCommand({ imageRef: candidateReference });
    stageSmokeGraph({
        graph,
        containerId: prepared.containerId,
        runner: harness.runner,
    });
    const keyHash = execInBox(harness.runner, prepared.containerId, [
        'sha256sum', '/workspace/.ploinky/master-key',
    ]).split(/\s/)[0];
    const keyValue = execInBox(harness.runner, prepared.containerId, [
        '/usr/local/bin/node', '-e',
        "process.stdout.write(require('node:fs').readFileSync('/workspace/.ploinky/master-key','utf8').trim())",
    ]);
    assert.match(keyValue, /^[a-f0-9]{64}$/);
    harness.useChild();
    const started = await harness.supervisor.runStartTransaction(route.coreArgv, {
        explicitPort: route.hostPort,
        imageRef: candidateReference,
    });
    assert.equal(started.identity.instance, harness.identity.instance);
    assert.match(harness.output.bytes,
        new RegExp(`\\[start\\] Router: http://127\\.0\\.0\\.1:${route.hostPort}`));
    assert.doesNotMatch(harness.output.bytes,
        /\[start\] Router: http:\/\/127\.0\.0\.1:8080(?:\s|$)/);
    assert.equal(harness.output.bytes.includes(keyHash), false);
    assert.equal(harness.output.bytes.includes(keyValue), false);

    const publications = started.ownership.handles.container.runtime.publications;
    assert.equal(publications.some((entry) => (
        entry.protocol === 'tcp'
        && entry.hostPort === String(route.hostPort)
        && entry.containerPort === '8080'
    )), true);
    assert.equal(publications.some((entry) => entry.containerPort === '8081'), false);

    const transport = JSON.parse(execInBox(harness.runner, started.containerId, [
        'cat', '/run/ploinky/box-transport.json',
    ]));
    assert.match(transport.address, /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/);
    const containersConf = execInBox(harness.runner, started.containerId, [
        'cat', '/home/podman/.config/containers/containers.conf',
    ]);
    assert.equal(containersConf, [
        '[containers]',
        'default_sysctls=[]',
    ].join('\n'));
    const agent = JSON.parse(execInBox(harness.runner, started.containerId, [
        '/usr/local/bin/node', '-e', [
            "const f=require('node:fs');",
            "const a=JSON.parse(f.readFileSync('/workspace/.ploinky/agents.json'));",
            "const e=Object.entries(a).find(([,v])=>v&&v.runtime==='podman'&&/^[a-f0-9]{64}$/.test(v.containerId||''));",
            "if(!e)process.exit(4);process.stdout.write(JSON.stringify({name:e[0],id:e[1].containerId}));",
        ].join(''),
    ]));
    const hosts = execInBox(harness.runner, started.containerId, [
        'podman', 'container', 'exec', agent.id, 'cat', '/etc/hosts',
    ]);
    const hostMappings = hosts.split(/\n/).filter((line) => line.includes('host.containers.internal'));
    assert.equal(hostMappings.length, 1);
    assert.notEqual(hostMappings[0].trim().split(/\s+/)[0], transport.address);
    const routerEnvironment = execInBox(harness.runner, started.containerId, [
        'podman', 'container', 'exec', agent.id, 'env',
    ]);
    assert.match(routerEnvironment, /^PLOINKY_ROUTER_HOST=host\.containers\.internal$/m);
    assert.match(routerEnvironment, /^PLOINKY_ROUTER_URL=http:\/\/host\.containers\.internal:8080$/m);
    assert.match(routerEnvironment,
        new RegExp(`^PLOINKY_ROUTER_AUTHORITY=127\\.0\\.0\\.1:${route.hostPort}$`, 'm'));
    const nestedPidMode = execInBox(harness.runner, started.containerId, [
        'podman', 'container', 'inspect', '--format', '{{.HostConfig.PidMode}}', agent.id,
    ]);
    assert.equal(nestedPidMode, 'private');
    const nestedProcfs = JSON.parse(execInBox(harness.runner, started.containerId, [
        'podman', 'container', 'exec', agent.id,
        '/usr/local/bin/node', '-e', [
            "const f=require('node:fs');",
            "const p=process.pid;",
            "const s=Number(f.readlinkSync('/proc/self'));",
            "const n=f.existsSync('/proc/'+p+'/ns/pid');",
            "process.stdout.write(JSON.stringify({pid:p,procSelf:s,pidNamespaceVisible:n}));",
        ].join(''),
    ]));
    assert.equal(nestedProcfs.procSelf, nestedProcfs.pid,
        'nested procfs must represent the nested container PID namespace');
    assert.equal(nestedProcfs.pidNamespaceVisible, true,
        'the nested process namespace handle must be visible through its own procfs');
    waitForRouterHealth(harness.runner, started.containerId, {
        nestedContainerId: agent.id,
    });

    const nestedImageId = execInBox(harness.runner, started.containerId, [
        'podman', 'container', 'inspect', '--format', '{{.Image}}', agent.id,
    ]);
    assert.match(nestedImageId, /^(?:sha256:)?[a-f0-9]{64}$/);
    const nestedVolume = `ploinky-box-t27-${harness.identity.pathHash.slice(0, 12)}`;
    execInBox(harness.runner, started.containerId, [
        'podman', 'volume', 'create', nestedVolume,
    ]);
    execInBox(harness.runner, started.containerId, [
        'bash', '-lc',
        'mountpoint="$(podman volume inspect --format "{{.Mountpoint}}" "$1")"; printf nested-store-retained > "$mountpoint/canary"',
        'bash', nestedVolume,
    ]);
    execInBox(harness.runner, started.containerId, [
        'bash', '-c', [
            'printf workspace-retained > /workspace/t27-workspace-canary',
            'printf dependencies-retained > /opt/ploinky/node_modules/t27-dependencies-canary',
        ].join('; '),
    ]);

    waitForRouterHealth(harness.runner, started.containerId, {
        hostname: '127.0.0.1',
        port: 8080,
        authority: `127.0.0.1:${route.hostPort}`,
    });

    execInBox(harness.runner, started.containerId, [
        '/usr/local/bin/node', '-e', [
            "const f=require('node:fs');",
            "f.unlinkSync('/opt/ploinky/node_modules/.ploinky-box-dependencies.json');",
            "f.chmodSync('/opt/ploinky/node_modules/achillesAgentLib',0o500);",
        ].join(''),
    ]);
    const corruptedHash = dependencyTreeHash(harness);
    await harness.supervisor.runStopTransaction();
    assert.equal(dependencyTreeHash(harness), corruptedHash,
        'relayed ploinky-local stop must not repair or rewrite dependency state');
    assert.equal(harness.supervisor.inspectBoxStatus().state, 'stopped');
    await harness.supervisor.runDestroyTransaction(started.containerId);
    const recreated = await harness.supervisor.prepareBoxForCommand({ imageRef: candidateReference });
    const recreatedKeyHash = execInBox(harness.runner, recreated.containerId, [
        'sha256sum', '/workspace/.ploinky/master-key',
    ]).split(/\s/)[0];
    assert.equal(recreatedKeyHash, keyHash);
    assert.equal(execInBox(harness.runner, recreated.containerId, [
        'cat', '/workspace/t27-workspace-canary',
    ]), 'workspace-retained');
    assert.equal(execInBox(harness.runner, recreated.containerId, [
        'cat', '/opt/ploinky/node_modules/t27-dependencies-canary',
    ]), 'dependencies-retained');
    // Inner Podman named volumes live under the disposable graphroot, so they
    // must NOT survive outer recreation; only image content and Box
    // dependencies do.
    assert.equal(nestedResourceExists(
        harness, recreated.containerId, 'volume', nestedVolume,
    ), false);
    const nestedImage = harness.runner.query('podman', [
        'container', 'exec', '--user', 'podman', recreated.containerId,
        'podman', 'image', 'inspect', nestedImageId,
    ]);
    assert.equal(nestedImage.ok, true, nestedImage.stderr);
    for (const target of Object.values(harness.identity.dataPaths)) {
        assert.equal(fs.statSync(target).isDirectory(), true, target);
    }
    const labelledVolumes = harness.runner.query('podman', [
        'volume', 'ls', '--quiet', '--filter',
        `label=io.assistos.ploinky-box.path-hash=${harness.identity.pathHash}`,
    ]);
    assert.equal(labelledVolumes.ok, true, labelledVolumes.stderr);
    assert.equal(String(labelledVolumes.stdout || '').trim(), '');
});
