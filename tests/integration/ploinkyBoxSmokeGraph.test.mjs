import assert from 'node:assert/strict';
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

const TREE_HASH_SCRIPT = `
const c=require('node:crypto');const f=require('node:fs');const p=require('node:path');
const h=c.createHash('sha256');function w(d,r=''){for(const n of f.readdirSync(d).sort()){
const x=p.join(d,n),q=p.join(r,n),s=f.lstatSync(x);h.update(q+'\\0'+s.mode+'\\0');
if(s.isDirectory())w(x,q);else if(s.isFile())h.update(f.readFileSync(x));}}
w('/deps');process.stdout.write(h.digest('hex'));
`;

function dependencyTreeHash(harness) {
    const result = harness.runner.query('podman', [
        'run', '--rm', '--network=none', '--entrypoint', '/usr/local/bin/node',
        '--volume', `${harness.identity.volumes.dependencies}:/deps`,
        harness.candidateReference, '-e', TREE_HASH_SCRIPT,
    ], { timeoutMs: 120_000 });
    assert.equal(result.ok, true, result.stderr);
    assert.match(String(result.stdout).trim(), /^[a-f0-9]{64}$/);
    return String(result.stdout).trim();
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
        new RegExp(`\\[start\\] Dashboard: http://127\\.0\\.0\\.1:${route.hostPort}/dashboard`));
    assert.doesNotMatch(harness.output.bytes,
        /\[start\] Dashboard: http:\/\/127\.0\.0\.1:8080\/dashboard/);
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
    assert.equal(execInBox(harness.runner, recreated.containerId, [
        'bash', '-lc',
        'mountpoint="$(podman volume inspect --format "{{.Mountpoint}}" "$1")"; cat "$mountpoint/canary"',
        'bash', nestedVolume,
    ]), 'nested-store-retained');
    const nestedImage = harness.runner.query('podman', [
        'container', 'exec', '--user', 'podman', recreated.containerId,
        'podman', 'image', 'inspect', nestedImageId,
    ]);
    assert.equal(nestedImage.ok, true, nestedImage.stderr);
    for (const volume of Object.values(harness.identity.volumes)) {
        assert.equal(harness.runner.query('podman', ['volume', 'inspect', volume]).ok, true);
    }
});
