import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
    createPodmanHarness,
    execInBox,
    requirePodmanCandidate,
} from './nativeHelpers.mjs';

// Opt-in native regression for the production Router-to-agent transport.
// Exact command on a capable Linux/nested-Podman host, from the ploinky root:
//   PLOINKY_BOX_REQUIRE_PODMAN=1 \
//   PLOINKY_BOX_CANDIDATE_DIGEST=sha256:<ploinky-box index digest> \
//   PLOINKY_RUNTIME_RELAY_NATIVE_IMAGE=docker.io/assistos/ploinky-node@sha256:<digest> \
//   node --test tests/e2e/ploinkyBox/runtimeRelaySocket.test.mjs

const repositoryRoot = path.resolve(import.meta.dirname, '../../..');

const WAIT_FOR_SOCKET_SCRIPT = [
    "const f=require('node:fs');",
    'const p=process.argv[1],prior=process.argv[2]||"",deadline=Date.now()+30000;',
    'let ready=false;',
    'while(Date.now()<deadline){',
    'try{const s=f.lstatSync(p),m=s.mode&0o777,id=`${s.dev}:${s.ino}`;ready=s.isSocket()&&!s.isSymbolicLink()&&(m===0o600||m===0o755)&&(!prior||id!==prior)}catch{}',
    'if(ready)break;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25)}',
    "if(!ready){process.stderr.write('runtime relay socket readiness timed out');process.exit(1)}",
].join('');

const READ_SOCKET_IDENTITY_SCRIPT = [
    "const s=require('node:fs').lstatSync(process.argv[1]);",
    "if(!s.isSocket()||s.isSymbolicLink())process.exit(1);",
    'process.stdout.write(`${s.dev}:${s.ino}`);',
].join('');

const TARGET_SERVER_SCRIPT = [
    "const n=require('node:net');",
    "const s=n.createServer(c=>setTimeout(()=>c.end('native-relay-ok'),100));",
    "s.listen(Number(process.argv[1]),'127.0.0.1');",
    "process.on('SIGTERM',()=>s.close(()=>process.exit(0)));",
].join('');

function countBoxReadyLines(output) {
    return (String(output || '').match(/^PLOINKY_BOX_READY$/gm) || []).length;
}

async function abruptlyRestartBox(harness, containerId) {
    const before = harness.runner.query('podman', ['container', 'logs', containerId]);
    assert.equal(before.ok, true, before.stderr);
    const priorReadyCount = countBoxReadyLines(`${before.stdout}\n${before.stderr}`);
    assert.ok(priorReadyCount >= 1, 'initial Box boot did not publish readiness');

    const restarted = harness.runner.query('podman', [
        'container', 'restart', '--time', '0', containerId,
    ], { timeoutMs: 120_000 });
    assert.equal(restarted.ok, true, restarted.stderr);

    const deadline = Date.now() + 120_000;
    let latest = '';
    while (Date.now() < deadline) {
        const logs = harness.runner.query('podman', ['container', 'logs', containerId]);
        if (logs.ok) {
            latest = `${logs.stdout}\n${logs.stderr}`;
            if (countBoxReadyLines(latest) > priorReadyCount) return;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail(`restarted Box did not publish a new readiness line: ${latest.slice(-2000)}`);
}

const EXERCISE_RELAY_SCRIPT = String.raw`
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { RuntimeRelayManager } from '/opt/ploinky/cli/server/runtimeRelay/RuntimeRelayManager.js';
import { RelayRequestMinter } from '/opt/ploinky/cli/server/runtimeRelay/relayRequestMinter.js';

const [containerName, effectiveInstanceId, enableGeneration, portText] = process.argv.slice(1);
const inspection = JSON.parse(execFileSync('podman', ['container', 'inspect', containerName], {
    encoding: 'utf8',
}));
const containerId = String(inspection[0]?.Id || '');
assert.match(containerId, /^[a-f0-9]{64}$/);
const targetAgentId = 'agent:native/runtime-relay';
const minter = new RelayRequestMinter({
    resolveAgentSecret: async () => { throw new Error('reusable agent secret must not be resolved'); },
});
const manager = new RuntimeRelayManager({ minter, channelIdleTimeoutMs: 100 });
const plan = {
    owner: { effectiveInstanceId, enableGeneration },
    relay: {
        kind: 'container-control-socket',
        runtime: 'podman',
        containerId,
        containerName,
        targetAgentId,
        effectiveInstanceId,
        enableGeneration,
        networkMode: '',
    },
    generationDigest: 'native-relay-generation',
    deniedPorts: [22, 8080, 8081],
    method: 'GET',
    port: Number(portText),
    targetPath: '/',
    query: '',
    transport: 'http',
    limits: {
        connectTimeoutMs: 5000,
        headerTimeoutMs: 5000,
        idleTimeoutMs: 5000,
        webSocketHandshakeTimeoutMs: 5000,
        streamedBodyBytes: 65536,
        bufferedBodyBytes: 65536,
        requestHeaderBytes: 8192,
        responseHeaderBytes: 8192,
        concurrentStreamsPerAgent: 4,
        concurrentStreamsTotal: 8,
    },
};
const checkout = await manager.checkout({
    authorized: true,
    lease: { commit: () => true },
    plan,
});
const stream = await checkout.openRequest({ plan });
const chunks = [];
await new Promise((resolve, reject) => {
    stream.on('data', chunk => chunks.push(Buffer.from(chunk)));
    stream.once('end', resolve);
    stream.once('error', reject);
});
assert.equal(Buffer.concat(chunks).toString(), 'native-relay-ok');
checkout.close();
manager.close();
await new Promise(resolve => setTimeout(resolve, 150));
process.stdout.write(JSON.stringify({ containerId, response: 'native-relay-ok' }));
`;

test('native mounted relay serves through the exact control socket with zero OCI exec sessions', {
    timeout: 10 * 60_000,
}, async (t) => {
    const candidateReference = requirePodmanCandidate(t);
    if (!candidateReference) return;
    const runtimeImage = String(process.env.PLOINKY_RUNTIME_RELAY_NATIVE_IMAGE || '');
    assert.match(
        runtimeImage,
        /^[a-z0-9][a-z0-9./_-]*@sha256:[a-f0-9]{64}$/i,
        'PLOINKY_RUNTIME_RELAY_NATIVE_IMAGE must be an immutable Linux Node.js image',
    );

    const harness = createPodmanHarness(t, candidateReference);
    const agentLibSource = path.resolve(
        process.env.PLOINKY_RUNTIME_RELAY_AGENTLIB_SOURCE
            || path.join(repositoryRoot, 'node_modules', 'achillesAgentLib'),
    );
    assert.equal(
        fs.statSync(agentLibSource).isDirectory(),
        true,
        'native relay gate requires a local validated achillesAgentLib checkout',
    );
    // Select the workspace-present source deliberately. Besides avoiding a
    // network dependency in this transport regression, this proves the public
    // Box path forwards that exact local selection into ploinky-local.
    fs.cpSync(agentLibSource, path.join(harness.workspace, 'achillesAgentLib'), { recursive: true });
    const fixtureRoot = path.join(harness.workspace, 'runtime-relay-native');
    const stagedAgent = path.join(fixtureRoot, 'Agent');
    fs.mkdirSync(fixtureRoot, { recursive: true });
    fs.cpSync(path.join(repositoryRoot, 'Agent'), stagedAgent, { recursive: true });

    const containerName = `relay-native-${process.pid}`;
    const effectiveInstanceId = 'native-instance';
    const enableGeneration = 'native-enable-generation';
    const targetPort = 19123;
    const prepared = await harness.supervisor.prepareBoxForCommand({
        imageRef: candidateReference,
        explicitPort: 19097,
        explicitMediaPort: 17901,
    });
    execInBox(harness.runner, prepared.containerId, ['podman', 'pull', runtimeImage], {
        timeoutMs: 5 * 60_000,
    });
    let targetExists = false;
    t.after(() => {
        if (!targetExists) return;
        try {
            execInBox(harness.runner, prepared.containerId, [
                'podman', 'container', 'rm', '-f', '--time', '0', containerName,
            ]);
        } catch {}
    });

    const controlRoot = '/tmp/ploinky-health-probes';
    const controlDir = `${controlRoot}/${containerName}`;
    const controlSocketPath = `${controlDir}/runtime-relay.sock`;
    const ensureControlDir = () => {
        execInBox(harness.runner, prepared.containerId, [
            'mkdir', '-p', '--mode=0700', controlDir,
        ]);
        execInBox(harness.runner, prepared.containerId, ['chmod', '0700', controlDir]);
    };
    const startTarget = (priorSocketIdentity = '') => {
        ensureControlDir();
        execInBox(harness.runner, prepared.containerId, [
            'podman', 'run', '-d', '--init', '--name', containerName,
            '--userns=keep-id:uid=1000,gid=1000',
            '--label', 'io.assistos.ploinky.managed=1',
            '--label', 'io.assistos.ploinky.resource=agent',
            '--label', `io.assistos.ploinky.instance-id=${effectiveInstanceId}`,
            '--label', `io.assistos.ploinky.enable-generation=${enableGeneration}`,
            '-v', '/workspace/runtime-relay-native/Agent:/Agent:ro',
            '-v', `${controlDir}:/run/ploinky-health-probes`,
            '-e', 'PLOINKY_HEALTH_PROBE_BROKER=0',
            '-e', 'PLOINKY_AGENT_ID=agent:native/runtime-relay',
            '--entrypoint', '/Agent/server/AgentEntrypoint.sh',
            runtimeImage,
            'node', '-e', TARGET_SERVER_SCRIPT, String(targetPort),
        ]);
        targetExists = true;
        try {
            execInBox(harness.runner, prepared.containerId, [
                '/usr/local/bin/node', '-e', WAIT_FOR_SOCKET_SCRIPT,
                controlSocketPath, priorSocketIdentity,
            ]);
        } catch (error) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000);
            const runtimeInspection = execInBox(harness.runner, prepared.containerId, [
                'podman', 'container', 'inspect', containerName,
            ]);
            const runtimeLogTail = execInBox(harness.runner, prepared.containerId, [
                'podman', 'container', 'logs', '--tail', '40', containerName,
            ]);
            const outerControlIdentity = execInBox(harness.runner, prepared.containerId, [
                '/usr/local/bin/node', '-e',
                "const f=require('node:fs');for(const p of process.argv.slice(1)){try{const s=f.lstatSync(p);console.log(p,JSON.stringify({directory:s.isDirectory(),socket:s.isSocket(),mode:(s.mode&511).toString(8),uid:s.uid}))}catch(e){console.log(p,e.code,e.message)}}",
                controlDir, controlSocketPath,
            ]);
            throw new Error(
                `runtime relay socket did not become ready; nested inspection:\n${runtimeInspection}`
                + `\nouter control identity:\n${outerControlIdentity}`
                + `\nnested log tail:\n${runtimeLogTail}`,
                { cause: error },
            );
        }
    };
    const readSocketIdentity = () => execInBox(harness.runner, prepared.containerId, [
        '/usr/local/bin/node', '-e', READ_SOCKET_IDENTITY_SCRIPT, controlSocketPath,
    ]);
    const inspectTarget = () => JSON.parse(execInBox(harness.runner, prepared.containerId, [
        'podman', 'container', 'inspect', containerName,
    ]))[0];
    const assertExecFree = (stage) => {
        const inspection = inspectTarget();
        assert.equal(inspection.State?.Running, true, `${stage}: target must remain running`);
        assert.deepEqual(inspection.ExecIDs || [], [], `${stage}: target acquired an OCI exec session`);
        assert.deepEqual(
            inspection.Config?.Entrypoint,
            ['/Agent/server/AgentEntrypoint.sh'],
            `${stage}: target bypassed the managed control entrypoint`,
        );
    };
    const exerciseRelay = () => {
        const exercised = JSON.parse(execInBox(harness.runner, prepared.containerId, [
            '/usr/local/bin/node', '--input-type=module', '-e', EXERCISE_RELAY_SCRIPT,
            containerName, effectiveInstanceId, enableGeneration, String(targetPort),
        ]));
        assert.match(exercised.containerId, /^[a-f0-9]{64}$/);
        assert.equal(exercised.response, 'native-relay-ok');
        return exercised.containerId;
    };
    const removeTarget = () => {
        assertExecFree('before removal');
        execInBox(harness.runner, prepared.containerId, [
            'podman', 'container', 'rm', '-f', '--time', '0', containerName,
        ]);
        targetExists = false;
    };

    startTarget();
    assertExecFree('after startup');
    const firstContainerId = exerciseRelay();
    const firstSocketIdentity = readSocketIdentity();
    assert.match(firstSocketIdentity, /^\d+:\d+$/);
    assertExecFree('after relayed traffic');
    removeTarget();

    // Abrupt removal may leave the socket inode in the private control bind.
    // A replacement with the exact same name must safely retire it and start a
    // new broker without manufacturing an OCI exec session.
    startTarget(firstSocketIdentity);
    assertExecFree('after replacement');
    const replacementContainerId = exerciseRelay();
    assert.notEqual(replacementContainerId, firstContainerId);
    assertExecFree('after replacement relayed traffic');
    removeTarget();

    // This is the production failure boundary: an abrupt outer restart changes
    // the Linux kernel that owned every nested Unix socket. The control root is
    // on the Box's boot-scoped tmpfs, so the stale socket must disappear with
    // that boot instead of being projected back from the durable macOS
    // workspace bind as an ENOTSUP object.
    await abruptlyRestartBox(harness, prepared.containerId);
    assert.equal(execInBox(harness.runner, prepared.containerId, [
        '/usr/local/bin/node', '-e',
        `process.stdout.write(String(require('node:fs').existsSync(${JSON.stringify(controlRoot)})))`,
    ]), 'false');
    execInBox(harness.runner, prepared.containerId, [
        'podman', 'image', 'exists', runtimeImage,
    ]);

    startTarget();
    assertExecFree('after outer Box restart');
    const postRestartContainerId = exerciseRelay();
    assert.notEqual(postRestartContainerId, replacementContainerId);
    assertExecFree('after post-restart relayed traffic');
    removeTarget();
});
