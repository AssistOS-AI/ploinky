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
// reference with POSIX sh, /proc, setsid, grep, tr, and fractional sleep. A
// pinned BusyBox-based Alpine image is preferred because it exercises the
// production runner without GNU-only setsid or timeout flags.
// Exact command on a capable Linux/nested-Podman host, from the ploinky root:
//   PLOINKY_BOX_REQUIRE_PODMAN=1 \
//   PLOINKY_BOX_CANDIDATE_DIGEST=sha256:<ploinky-box image digest> \
//   PLOINKY_HEALTH_PROBE_NATIVE_IMAGE=docker.io/library/alpine@sha256:<digest> \
//   node --test tests/e2e/ploinkyBox/healthProbeCleanup.test.mjs

const repositoryRoot = path.resolve(import.meta.dirname, '../../..');

test('native nested Podman probe timeout leaves no descendants, zombies, or exec conmon', {
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
    const probeRoot = path.join(harness.workspace, 'health-probe-native');
    fs.mkdirSync(path.join(probeRoot, 'code'), { recursive: true });
    fs.mkdirSync(path.join(probeRoot, 'Agent', 'server'), { recursive: true });
    fs.copyFileSync(
        path.join(repositoryRoot, 'Agent', 'server', 'HealthProbeRunner.sh'),
        path.join(probeRoot, 'Agent', 'server', 'HealthProbeRunner.sh'),
    );
    fs.chmodSync(path.join(probeRoot, 'Agent', 'server', 'HealthProbeRunner.sh'), 0o755);
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

    const prepared = await harness.supervisor.prepareBoxForCommand({ imageRef: candidateReference });
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
    t.after(() => {
        try {
            execInBox(harness.runner, prepared.containerId, [
                'podman', 'container', 'rm', '-f', '--time', '0', containerName,
            ]);
        } catch {}
    });
    execInBox(harness.runner, prepared.containerId, ['podman', 'pull', probeImage], {
        timeoutMs: 5 * 60_000,
    });
    execInBox(harness.runner, prepared.containerId, [
        'podman', 'run', '-d', '--init', '--name', containerName,
        '-v', '/workspace/health-probe-native/code:/code:ro',
        '-v', '/workspace/health-probe-native/Agent:/Agent:ro',
        probeImage,
        'sh', '-c', 'while :; do sleep 3600; done',
    ]);

    // An unrelated in-container process running the exact same script name must
    // survive probe cleanup: cleanup is scoped by session + token, not by name.
    execInBox(harness.runner, prepared.containerId, [
        'podman', 'exec', '-d', containerName,
        'sh', '-c', 'echo "$$" > /tmp/decoy.pid && exec sh /code/hang.sh',
    ]);
    const decoyPid = execInBox(harness.runner, prepared.containerId, [
        'podman', 'exec', containerName, 'sh', '-c',
        'i=0; while [ ! -s /tmp/decoy.pid ] && [ "$i" -lt 100 ]; do sleep 0.1; i=$((i + 1)); done; cat /tmp/decoy.pid',
    ]);
    assert.match(decoyPid, /^\d+$/, 'the unrelated decoy process must have started');

    const result = JSON.parse(execInBox(harness.runner, prepared.containerId, [
        '/usr/local/bin/node', '-e', [
            "const f=require('node:fs'),c=require('node:child_process');",
            "const countConmon=()=>f.readdirSync('/proc').filter(x=>/^\\d+$/.test(x)).filter(x=>{try{return f.readFileSync('/proc/'+x+'/comm','utf8').trim()==='conmon'}catch{return false}}).length;",
            'const before=countConmon();',
            "const r=c.spawnSync('podman',['exec',process.argv[1],'sh','/Agent/server/HealthProbeRunner.sh','run','/tmp/.ploinky-health-probe-native-timeout','native-timeout','hang.sh','0.2','0.2'],{encoding:'utf8',timeout:30000});",
            "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,500);",
            'const after=countConmon();',
            "process.stdout.write(JSON.stringify({status:r.status,error:r.error?.code||null,stdout:r.stdout,stderr:r.stderr,before,after}));",
        ].join(''),
        containerName,
    ]));
    assert.equal(result.error, null, JSON.stringify(result));
    assert.equal(result.status, 124, result.stderr);
    assert.equal(result.after, result.before, 'the timed-out exec must not leave a conmon process');

    const preCancelled = JSON.parse(execInBox(harness.runner, prepared.containerId, [
        '/usr/local/bin/node', '-e', [
            "const c=require('node:child_process');",
            "const marker='/tmp/.ploinky-health-probe-native-pre-cancel';",
            "const cleanup=c.spawnSync('podman',['exec',process.argv[1],'sh','/Agent/server/HealthProbeRunner.sh','cleanup',marker,'native-pre-cancel'],{encoding:'utf8',timeout:30000});",
            "const run=c.spawnSync('podman',['exec',process.argv[1],'sh','/Agent/server/HealthProbeRunner.sh','run',marker,'native-pre-cancel','ok.sh','5','1'],{encoding:'utf8',timeout:30000});",
            "process.stdout.write(JSON.stringify({cleanupStatus:cleanup.status,cleanupError:cleanup.error?.code||null,status:run.status,error:run.error?.code||null,stdout:run.stdout,stderr:run.stderr}));",
        ].join(''),
        containerName,
    ]));
    assert.equal(preCancelled.cleanupError, null, JSON.stringify(preCancelled));
    assert.equal(preCancelled.cleanupStatus, 0, JSON.stringify(preCancelled));
    assert.equal(preCancelled.error, null, JSON.stringify(preCancelled));
    assert.equal(preCancelled.status, 125, 'a cancellation that wins before session setup must prevent execution');

    const killedClient = JSON.parse(execInBox(harness.runner, prepared.containerId, [
        '/usr/local/bin/node', '-e', [
            "const f=require('node:fs'),c=require('node:child_process');",
            "const countConmon=()=>f.readdirSync('/proc').filter(x=>/^\\d+$/.test(x)).filter(x=>{try{return f.readFileSync('/proc/'+x+'/comm','utf8').trim()==='conmon'}catch{return false}}).length;",
            "(async()=>{",
            "const marker='/tmp/.ploinky-health-probe-native-client-kill',token='native-client-kill';",
            "const before=countConmon();",
            "const child=c.spawn('podman',['exec',process.argv[1],'sh','/Agent/server/HealthProbeRunner.sh','run',marker,token,'hang.sh','30','1'],{stdio:['ignore','pipe','pipe']});",
            "let active=false;const deadline=Date.now()+10000;",
            "while(Date.now()<deadline){const seen=c.spawnSync('podman',['exec',process.argv[1],'sh','-c','test -d \"$1\" && find \"$1\" -maxdepth 1 -type d -name \"active-*\" | grep -q .','sh',marker],{stdio:'ignore',timeout:5000});if(seen.status===0){active=true;break}Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50)}",
            "if(!active){child.kill('SIGKILL');throw new Error('probe session did not publish an active identity')}",
            "child.kill('SIGKILL');",
            "const close=await new Promise(resolve=>child.once('close',(status,signal)=>resolve({status,signal})));",
            "const cleanup=c.spawnSync('podman',['exec',process.argv[1],'sh','/Agent/server/HealthProbeRunner.sh','cleanup',marker,token],{encoding:'utf8',timeout:30000});",
            "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,500);",
            "const after=countConmon();",
            "process.stdout.write(JSON.stringify({active,close,cleanupStatus:cleanup.status,cleanupError:cleanup.error?.code||null,cleanupStdout:cleanup.stdout,cleanupStderr:cleanup.stderr,before,after}));",
            "})().catch(error=>{process.stderr.write(error.stack||String(error));process.exit(1)});",
        ].join(''),
        containerName,
    ], { timeoutMs: 60_000 }));
    assert.equal(killedClient.active, true, JSON.stringify(killedClient));
    assert.deepEqual(killedClient.close, { status: null, signal: 'SIGKILL' });
    assert.equal(killedClient.cleanupError, null, JSON.stringify(killedClient));
    assert.equal(killedClient.cleanupStatus, 0, killedClient.cleanupStderr);
    assert.equal(
        killedClient.after,
        killedClient.before,
        'external client death plus exact cleanup must not strand exec conmon',
    );

    const inspection = JSON.parse(execInBox(harness.runner, prepared.containerId, [
        'podman', 'container', 'inspect', containerName,
    ]))[0];
    assert.equal(inspection.HostConfig?.Init, true);

    const processAudit = execInBox(harness.runner, prepared.containerId, [
        'podman', 'exec', containerName, 'sh', '-c', [
            'test ! -e /tmp/.ploinky-health-probe-native-timeout',
            'test ! -e /tmp/.ploinky-health-probe-native-pre-cancel',
            'test ! -e /tmp/.ploinky-health-probe-native-client-kill',
            "for p in /proc/[0-9]*; do",
            "  test -r \"$p/environ\" || continue",
            "  environment=\"$(tr '\\000' '\\n' < \"$p/environ\")\"",
            "  printf '%s\\n' \"$environment\" | grep -Fqx 'PLOINKY_PROBE_TOKEN=native-timeout:' && exit 20",
            "  printf '%s\\n' \"$environment\" | grep -Fqx 'PLOINKY_PROBE_TOKEN=native-pre-cancel:' && exit 22",
            "  printf '%s\\n' \"$environment\" | grep -Fqx 'PLOINKY_PROBE_TOKEN=native-client-kill:' && exit 23",
            'done',
            "zombies=''",
            "for p in /proc/[0-9]*/stat; do",
            "  test -r \"$p\" || continue",
            "  IFS= read -r stat < \"$p\" || continue",
            "  fields=\"${stat##*) }\"",
            '  set -- $fields',
            '  state="$1"',
            "  test \"$state\" = Z && zombies=\"$zombies ${p%/stat}\"",
            'done',
            'test -z "$zombies" || { echo "$zombies"; exit 21; }',
            "printf '%s' clean",
        ].join('\n'),
    ]);
    assert.equal(processAudit, 'clean');

    const decoySurvival = execInBox(harness.runner, prepared.containerId, [
        'podman', 'exec', containerName, 'sh', '-c',
        `kill -0 "${decoyPid}" 2>/dev/null && printf '%s' alive`,
    ]);
    assert.equal(decoySurvival, 'alive', 'probe cleanup must not kill the unrelated same-named process');

    // A subsequent probe on the same container must run normally end to end.
    const recovery = JSON.parse(execInBox(harness.runner, prepared.containerId, [
        '/usr/local/bin/node', '-e', [
            "const c=require('node:child_process');",
            "const r=c.spawnSync('podman',['exec',process.argv[1],'sh','/Agent/server/HealthProbeRunner.sh','run','/tmp/.ploinky-health-probe-native-recovery','native-recovery','ok.sh','5','1'],{encoding:'utf8',timeout:30000});",
            "process.stdout.write(JSON.stringify({status:r.status,error:r.error?.code||null,stdout:r.stdout,stderr:r.stderr}));",
        ].join(''),
        containerName,
    ]));
    assert.equal(recovery.error, null, recovery.stderr);
    assert.equal(recovery.status, 0, recovery.stderr);
    assert.equal(recovery.stdout.trim(), 'healthy');
    const recoveryAudit = execInBox(harness.runner, prepared.containerId, [
        'podman', 'exec', containerName, 'sh', '-c',
        'test ! -e /tmp/.ploinky-health-probe-native-recovery && printf \'%s\' clean',
    ]);
    assert.equal(recoveryAudit, 'clean', 'a successful probe must remove its own marker');
});
