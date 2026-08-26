import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
    createPodmanHarness,
    execInBox,
    requirePodmanCandidate,
} from './nativeHelpers.mjs';

// Opt-in native regression. This host must provide rootless Podman plus the
// immutable Box candidate image; the probe image must be an immutable Linux
// reference with POSIX sh, /proc, cat, dd, grep, mkfifo, mv, rm, setsid, tr,
// and fractional sleep. A pinned BusyBox-based Alpine image is preferred.
// Exact command on a capable Linux/nested-Podman host, from the ploinky root:
//   PLOINKY_BOX_REQUIRE_PODMAN=1 \
//   PLOINKY_BOX_CANDIDATE_DIGEST=sha256:<ploinky-box image digest> \
//   PLOINKY_HEALTH_PROBE_NATIVE_IMAGE=docker.io/library/alpine@sha256:<digest> \
//   node --test tests/e2e/ploinkyBox/healthProbeCleanup.test.mjs

const repositoryRoot = path.resolve(import.meta.dirname, '../../..');

const WAIT_FOR_BROKER_SCRIPT = [
    "const f=require('node:fs');",
    'const ready=process.argv[1],deadline=Date.now()+30000;',
    'while(!f.existsSync(ready)&&Date.now()<deadline)',
    'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25);',
    "if(!f.existsSync(ready)){process.stderr.write('broker readiness timed out');process.exit(1)}",
].join('');

const SUBMIT_REQUEST_SCRIPT = [
    "const f=require('node:fs');",
    'const [root,token,script,timeout,killAfter,cancelMode]=process.argv.slice(1);',
    "const control=root+'/'+token;f.mkdirSync(control,{recursive:true,mode:0o700});",
    "if(cancelMode==='pre')f.mkdirSync(control+'/cancelled',{mode:0o700});",
    "const payload=['ploinky-health-probe/1',token,script,timeout,killAfter,''].join('\\n');",
    "f.writeFileSync(control+'/request-tmp',payload,{flag:'wx',mode:0o600});",
    "f.renameSync(control+'/request-tmp',control+'/request');",
    'let active=false;',
    "if(cancelMode==='active'){const activeDeadline=Date.now()+10000;while(Date.now()<activeDeadline){try{active=f.readdirSync(control+'/session').some(name=>name.startsWith('active-'))}catch{}if(active)break;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25)}if(active)f.mkdirSync(control+'/cancelled',{mode:0o700})}",
    "const resultPath=control+'/result',deadline=Date.now()+45000;",
    'while(!f.existsSync(resultPath)&&Date.now()<deadline)',
    'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25);',
    "const status=f.existsSync(resultPath)?Number(f.readFileSync(resultPath,'utf8').trim()):null;",
    "const read=name=>f.existsSync(control+'/'+name)?f.readFileSync(control+'/'+name,'utf8'):'';",
    "process.stdout.write(JSON.stringify({active,status,stdout:read('probe-stdout'),stderr:read('probe-stderr')+read('runner-stderr'),claimed:f.existsSync(control+'/claimed'),sessionExists:f.existsSync(control+'/session')}));",
].join('');

test('native mounted broker probes leave zero nested exec sessions and allow replacement', {
    timeout: 10 * 60_000,
}, async (t) => {
    const candidateReference = requirePodmanCandidate(t);
    if (!candidateReference) return;
    const probeImage = String(process.env.PLOINKY_HEALTH_PROBE_NATIVE_IMAGE || '');
    assert.match(
        probeImage,
        /^[a-z0-9][a-z0-9./_-]*@sha256:[a-f0-9]{64}$/i,
        'PLOINKY_HEALTH_PROBE_NATIVE_IMAGE must be an immutable Linux image with POSIX sh, /proc, setsid, grep, tr, and fractional sleep',
    );

    const harness = createPodmanHarness(t, candidateReference);
    const agentLibSource = path.resolve(
        process.env.PLOINKY_HEALTH_PROBE_AGENTLIB_SOURCE
            || path.join(repositoryRoot, 'node_modules', 'achillesAgentLib'),
    );
    assert.equal(
        fs.statSync(agentLibSource).isDirectory(),
        true,
        'native health gate requires a local validated achillesAgentLib checkout',
    );
    fs.cpSync(agentLibSource, path.join(harness.workspace, 'achillesAgentLib'), { recursive: true });
    const probeRoot = path.join(harness.workspace, 'health-probe-native');
    fs.mkdirSync(path.join(probeRoot, 'code'), { recursive: true });
    fs.mkdirSync(path.join(probeRoot, 'Agent', 'server'), { recursive: true });
    fs.mkdirSync(path.join(probeRoot, 'control'), { recursive: true });
    for (const fileName of ['HealthProbeRunner.sh', 'AgentEntrypoint.sh']) {
        fs.copyFileSync(
            path.join(repositoryRoot, 'Agent', 'server', fileName),
            path.join(probeRoot, 'Agent', 'server', fileName),
        );
        fs.chmodSync(path.join(probeRoot, 'Agent', 'server', fileName), 0o755);
    }
    fs.writeFileSync(path.join(probeRoot, 'code', 'hang.sh'), [
        '#!/bin/sh',
        "trap '' TERM",
        "sh -c \"trap '' TERM; while :; do sleep 60; done\" &",
        'while :; do sleep 60; done',
        '',
    ].join('\n'), { mode: 0o755 });
    fs.writeFileSync(path.join(probeRoot, 'code', 'ok.sh'), [
        '#!/bin/sh',
        "printf '%s' healthy",
        'exit 0',
        '',
    ].join('\n'), { mode: 0o755 });
    fs.writeFileSync(path.join(probeRoot, 'code', 'main.sh'), [
        '#!/bin/sh',
        'sh /code/hang.sh &',
        'decoy_pid="$!"',
        "printf '%s' \"$decoy_pid\" > /run/ploinky-health-probes/decoy.pid",
        "trap 'kill -KILL \"$decoy_pid\" 2>/dev/null || true; exit 0' HUP INT TERM",
        'while kill -0 "$decoy_pid" 2>/dev/null; do sleep 60 & wait "$!"; done',
        'exit 1',
        '',
    ].join('\n'), { mode: 0o755 });
    fs.writeFileSync(path.join(probeRoot, 'code', 'unacknowledged.sh'), [
        '#!/bin/sh',
        'while :; do sleep 60 & wait "$!"; done',
        '',
    ].join('\n'), { mode: 0o755 });
    fs.writeFileSync(path.join(probeRoot, 'code', 'audit.sh'), [
        '#!/bin/sh',
        'decoy_pid="$(cat /run/ploinky-health-probes/decoy.pid)"',
        'kill -0 "$decoy_pid" 2>/dev/null || exit 30',
        'for p in /proc/[0-9]*; do',
        '  test -r "$p/environ" || continue',
        "  environment=\"$(tr '\\000' '\\n' < \"$p/environ\")\"",
        "  printf '%s\\n' \"$environment\" | grep -Eq '^PLOINKY_PROBE_TOKEN=native-(timeout|pre-cancel|mounted-cancel):$' && exit 31",
        'done',
        "zombies=''",
        'for p in /proc/[0-9]*/stat; do',
        '  test -r "$p" || continue',
        '  IFS= read -r stat < "$p" || continue',
        '  fields="${stat##*) }"',
        '  set -- $fields',
        '  test "$1" = Z && zombies="$zombies ${p%/stat}"',
        'done',
        'test -z "$zombies" || { echo "$zombies"; exit 32; }',
        "printf '%s' clean",
        '',
    ].join('\n'), { mode: 0o755 });

    const prepared = await harness.supervisor.prepareBoxForCommand({
        imageRef: candidateReference,
        explicitPort: 19098,
        explicitMediaPort: 17902,
    });
    execInBox(harness.runner, prepared.containerId, [
        'mkdir', '-p', '/workspace/health-probe-native',
    ]);
    const stagedProbe = harness.runner.query('podman', [
        'container', 'cp', `${probeRoot}/.`,
        `${prepared.containerId}:/workspace/health-probe-native`,
    ], { timeoutMs: 120_000 });
    assert.equal(
        stagedProbe.ok,
        true,
        `failed to stage native probe fixtures in the Box workspace bind: ${stagedProbe.stderr}`,
    );
    const containerName = `probe-cleanup-${process.pid}`;
    let targetExists = false;
    t.after(() => {
        if (!targetExists) return;
        try {
            execInBox(harness.runner, prepared.containerId, [
                'podman', 'container', 'rm', '-f', '--time', '0', containerName,
            ]);
        } catch {}
    });
    execInBox(harness.runner, prepared.containerId, ['podman', 'pull', probeImage], {
        timeoutMs: 5 * 60_000,
    });

    const startTarget = (mainScript = 'main.sh') => {
        execInBox(harness.runner, prepared.containerId, [
            'podman', 'run', '-d', '--init', '--name', containerName,
            '-v', '/workspace/health-probe-native/code:/code:ro',
            '-v', '/workspace/health-probe-native/Agent:/Agent:ro',
            '-v', '/workspace/health-probe-native/control:/run/ploinky-health-probes',
            '-e', 'PLOINKY_HEALTH_PROBE_BROKER=1',
            '--entrypoint', '/Agent/server/AgentEntrypoint.sh',
            probeImage,
            'sh', `/code/${mainScript}`,
        ]);
        targetExists = true;
        execInBox(harness.runner, prepared.containerId, [
            '/usr/local/bin/node', '-e', WAIT_FOR_BROKER_SCRIPT,
            '/workspace/health-probe-native/control/.broker-ready',
        ]);
    };
    const inspectTarget = () => JSON.parse(execInBox(harness.runner, prepared.containerId, [
        'podman', 'container', 'inspect', containerName,
    ]))[0];
    const assertNoTargetExecSessions = (stage) => {
        const inspection = inspectTarget();
        assert.equal(inspection.State?.Running, true, `${stage}: target must remain running`);
        assert.deepEqual(inspection.ExecIDs || [], [], `${stage}: target acquired an OCI exec session`);
        assert.deepEqual(
            inspection.Config?.Entrypoint,
            ['/Agent/server/AgentEntrypoint.sh'],
            `${stage}: target must be launched through the mounted broker entrypoint`,
        );
    };
    const submitRequest = ({ token, script, timeout, killAfter, cancelMode = 'none' }) => (
        JSON.parse(execInBox(harness.runner, prepared.containerId, [
            '/usr/local/bin/node', '-e', SUBMIT_REQUEST_SCRIPT,
            '/workspace/health-probe-native/control', token, script,
            String(timeout), String(killAfter), cancelMode,
        ], { timeoutMs: 60_000 }))
    );
    const removeTarget = () => {
        assertNoTargetExecSessions('before removal');
        execInBox(harness.runner, prepared.containerId, [
            'podman', 'container', 'rm', '-f', '--time', '0', containerName,
        ]);
        targetExists = false;
        execInBox(harness.runner, prepared.containerId, [
            'sh', '-c', 'podman container exists "$1"; test "$?" -ne 0',
            'sh', containerName,
        ]);
    };
    const stopTargetAndAssertExit = async (expectedExitCode) => {
        assertNoTargetExecSessions('before signaled stop');
        execInBox(harness.runner, prepared.containerId, [
            'podman', 'kill', '--signal', 'TERM', containerName,
        ]);
        const deadline = Date.now() + 35_000;
        let inspection = inspectTarget();
        while (inspection.State?.Running === true && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            inspection = inspectTarget();
        }
        assert.equal(inspection.State?.Running, false, 'graceful main process did not stop');
        assert.equal(
            inspection.State?.ExitCode,
            expectedExitCode,
            expectedExitCode === 0
                ? 'entrypoint replaced the main process drain acknowledgement'
                : 'entrypoint incorrectly manufactured a drain acknowledgement',
        );
        assert.deepEqual(inspection.ExecIDs || [], [], 'signaled stop acquired an OCI exec session');
    };

    startTarget();
    assertNoTargetExecSessions('after startup');
    const decoyPid = execInBox(harness.runner, prepared.containerId, [
        'cat', '/workspace/health-probe-native/control/decoy.pid',
    ]);
    assert.match(decoyPid, /^\d+$/, 'the unrelated same-named process must have started');

    const timedOut = submitRequest({
        token: 'native-timeout', script: 'hang.sh', timeout: 0.2, killAfter: 0.2,
    });
    assert.equal(timedOut.claimed, true, JSON.stringify(timedOut));
    assert.equal(timedOut.status, 124, JSON.stringify(timedOut));
    assert.equal(timedOut.sessionExists, false, JSON.stringify(timedOut));
    assertNoTargetExecSessions('after timeout');

    const preCancelled = submitRequest({
        token: 'native-pre-cancel', script: 'ok.sh', timeout: 5, killAfter: 1,
        cancelMode: 'pre',
    });
    assert.equal(preCancelled.claimed, true, JSON.stringify(preCancelled));
    assert.equal(preCancelled.status, 125, JSON.stringify(preCancelled));
    assert.equal(preCancelled.sessionExists, false, JSON.stringify(preCancelled));
    assertNoTargetExecSessions('after pre-cancellation');

    const mountedCancellation = submitRequest({
        token: 'native-mounted-cancel', script: 'hang.sh', timeout: 30, killAfter: 0.2,
        cancelMode: 'active',
    });
    assert.equal(mountedCancellation.active, true, JSON.stringify(mountedCancellation));
    assert.equal(mountedCancellation.claimed, true, JSON.stringify(mountedCancellation));
    assert.equal(mountedCancellation.status, 125, JSON.stringify(mountedCancellation));
    assert.equal(mountedCancellation.sessionExists, false, JSON.stringify(mountedCancellation));
    assertNoTargetExecSessions('after mounted cancellation');

    const audit = submitRequest({
        token: 'native-audit', script: 'audit.sh', timeout: 5, killAfter: 1,
    });
    assert.equal(audit.status, 0, audit.stderr);
    assert.equal(audit.stdout.trim(), 'clean');
    assertNoTargetExecSessions('after process audit');

    const recovery = submitRequest({
        token: 'native-recovery', script: 'ok.sh', timeout: 5, killAfter: 1,
    });
    assert.equal(recovery.status, 0, recovery.stderr);
    assert.equal(recovery.stdout.trim(), 'healthy');
    assert.equal(recovery.sessionExists, false, JSON.stringify(recovery));
    assertNoTargetExecSessions('after recovery');

    await stopTargetAndAssertExit(0);
    execInBox(harness.runner, prepared.containerId, [
        'podman', 'container', 'rm', containerName,
    ]);
    targetExists = false;

    // Reuse the same name and persistent control bind to prove a managed
    // replacement can start after the predecessor without stale exec state.
    startTarget();
    assertNoTargetExecSessions('after replacement');
    removeTarget();

    // A main process without a graceful drain handler must retain its
    // signal-style failure; the wrapper may not manufacture exit zero.
    startTarget('unacknowledged.sh');
    await stopTargetAndAssertExit(143);
    execInBox(harness.runner, prepared.containerId, [
        'podman', 'container', 'rm', containerName,
    ]);
    targetExists = false;
});
