#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const nodePty = require('/usr/local/lib/ploinky/webtty/node_modules/node-pty');
const PODMAN = '/usr/bin/podman';
const WAIT_MS = 10_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function runPodman(args, { ok = true, timeout = 120_000 } = {}) {
    const result = spawnSync(PODMAN, args, {
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
        timeout,
        env: process.env,
    });
    const record = {
        ok: result.status === 0,
        status: Number.isInteger(result.status) ? result.status : null,
        signal: result.signal || null,
        stdout: String(result.stdout || '').trim(),
        stderr: String(result.stderr || '').trim(),
    };
    if (ok) assert.equal(record.ok, true, `${args.join(' ')} failed: ${record.stderr}`);
    return record;
}

function podmanJson(args) {
    const result = runPodman(args);
    return JSON.parse(result.stdout);
}

async function waitFor(check, label, timeoutMs = WAIT_MS) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        try {
            last = await check();
            if (last) return last;
        } catch (error) {
            last = error;
        }
        await delay(40);
    }
    throw new Error(`${label} timed out: ${last instanceof Error ? last.message : String(last || '')}`);
}

function parseProcStat(raw, expectedPid) {
    const close = raw.lastIndexOf(')');
    assert.ok(close > 0);
    const pid = Number(raw.slice(0, raw.indexOf('(')).trim());
    assert.equal(pid, expectedPid);
    const fields = raw.slice(close + 1).trim().split(/\s+/);
    return {
        pid,
        state: fields[0],
        pgrp: Number(fields[2]),
        session: Number(fields[3]),
        startToken: `linux-proc:${fields[19]}`,
    };
}

function localProcessIdentity(pid) {
    return parseProcStat(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'), pid);
}

function sameLocalProcess(identity) {
    try {
        return localProcessIdentity(identity.pid).startToken === identity.startToken;
    } catch (error) {
        if (['ENOENT', 'ESRCH'].includes(error?.code)) return false;
        throw error;
    }
}

function inspectContainer(containerId) {
    const records = podmanJson(['container', 'inspect', containerId]);
    assert.equal(records.length, 1);
    assert.equal(records[0].Id, containerId);
    return records[0];
}

function currentExecIds(containerId) {
    const value = inspectContainer(containerId).ExecIDs;
    return Array.isArray(value) ? value.map(String) : [];
}

function markerProcesses(containerId, user, marker) {
    const script = [
        'set -eu',
        'for environ in /proc/[0-9]*/environ; do',
        '  pid=${environ#/proc/}; pid=${pid%/environ}',
        '  if tr "\\0" "\\n" < "$environ" 2>/dev/null | grep -Fxq "PLOINKY_WEBTTY_MARKER=$1"; then',
        '    stat=$(cat "/proc/$pid/stat")',
        '    printf "%s\\t%s\\n" "$pid" "$stat"',
        '  fi',
        'done',
    ].join('\n');
    const result = runPodman([
        'container', 'exec', '--user', user, containerId,
        '/bin/bash', '-c', script, 'phase0-marker-audit', marker,
    ]);
    if (!result.stdout) return [];
    return result.stdout.split(/\n/).filter(Boolean).map((line) => {
        const tab = line.indexOf('\t');
        const pid = Number(line.slice(0, tab));
        return parseProcStat(line.slice(tab + 1), pid);
    });
}

function sessionProcesses(containerId, user, sessionId) {
    const script = [
        'set -eu',
        'expected_sid=$1',
        'for statfile in /proc/[0-9]*/stat; do',
        '  stat=$(cat "$statfile" 2>/dev/null) || continue',
        '  tail=${stat##*) }',
        '  set -- $tail',
        '  test "$4" = "$expected_sid" || continue',
        '  pid=${statfile#/proc/}; pid=${pid%/stat}',
        '  printf "%s\\n" "$pid"',
        'done',
    ].join('\n');
    const result = runPodman([
        'container', 'exec', '--user', user, containerId,
        '/bin/bash', '-c', script, 'phase0-session-audit', String(sessionId),
    ]);
    return result.stdout ? result.stdout.split(/\n/).filter(Boolean).map(Number) : [];
}

function reclaimExactSession(containerId, user, marker, sessionId) {
    const script = [
        'set -eu',
        'marker=$1',
        'expected_sid=$2',
        'matched=0',
        'for environ in /proc/[0-9]*/environ; do',
        '  pid=${environ#/proc/}; pid=${pid%/environ}',
        '  if tr "\\0" "\\n" < "$environ" 2>/dev/null | grep -Fxq "PLOINKY_WEBTTY_MARKER=$marker"; then',
        '    stat=$(cat "/proc/$pid/stat")',
        '    tail=${stat##*) }',
        '    set -- $tail',
        '    test "$4" = "$expected_sid" || exit 91',
        '    matched=1',
        '  fi',
        'done',
        'test "$matched" -eq 1 || exit 0',
        'for signal in TERM KILL; do',
        '  for statfile in /proc/[0-9]*/stat; do',
        '    stat=$(cat "$statfile" 2>/dev/null) || continue',
        '    tail=${stat##*) }',
        '    set -- $tail',
        '    test "$4" = "$expected_sid" || continue',
        '    pid=${statfile#/proc/}; pid=${pid%/stat}',
        '    test "$pid" = "$$" || kill -s "$signal" "$pid" 2>/dev/null || true',
        '  done',
        '  sleep 0.2',
        'done',
    ].join('\n');
    runPodman([
        'container', 'exec', '--user', user, containerId,
        '/bin/bash', '-c', script, 'phase0-exact-reclaim', marker, String(sessionId),
    ]);
}

async function waitForTerminalOutput(session, needle, label) {
    return waitFor(() => session.output.includes(needle) && session.output, label);
}

function terminalExit(terminal) {
    return new Promise((resolve) => terminal.onExit(resolve));
}

async function openCliSession({ containerId, user, marker }) {
    assert.match(containerId, /^[a-f0-9]{64}$/);
    assert.match(marker, /^phase0-[a-z0-9-]{20,96}$/);
    const original = inspectContainer(containerId);
    assert.equal(original.State.Running, true);
    const session = { output: '', outputBytes: 0 };
    const terminal = nodePty.spawn(PODMAN, [
        'container', 'exec', '--interactive', '--tty',
        '--user', user,
        '--workdir', '/tmp',
        '--env', `PLOINKY_WEBTTY_MARKER=${marker}`,
        '--env', 'TERM=xterm-256color',
        containerId,
        '/bin/bash', '-c',
        'exec -a "$PLOINKY_WEBTTY_MARKER" /bin/bash --noprofile --norc',
    ], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: '/tmp',
        env: {
            HOME: '/home/podman',
            USER: 'podman',
            LOGNAME: 'podman',
            PATH: '/usr/local/bin:/usr/bin:/bin',
            TERM: 'xterm-256color',
            LANG: 'C.UTF-8',
            LC_ALL: 'C.UTF-8',
        },
    });
    terminal.onData((data) => {
        session.outputBytes += Buffer.byteLength(data);
        assert.ok(session.outputBytes <= MAX_OUTPUT_BYTES, 'terminal output exceeded bound');
        session.output += String(data);
    });
    const exit = terminalExit(terminal);
    const cliIdentity = await waitFor(() => {
        try { return localProcessIdentity(terminal.pid); } catch (_) { return null; }
    }, 'Box-side Podman client identity');
    const initialExecIds = await waitFor(() => {
        const values = currentExecIds(containerId);
        return values.length === 1 ? values : null;
    }, 'nested exec identity');
    const initialMarkerProcesses = await waitFor(() => {
        const values = markerProcesses(containerId, user, marker);
        return values.length > 0 ? values : null;
    }, 'marker-bearing inner shell');
    const readyPrefix = `__PLOINKY_READY__${marker}|`;
    terminal.write([
        `printf '${readyPrefix}%s|%s|%s|%s\\n' "$$" "$(ps -o pgid= -p $$ | tr -d ' ')" "$(ps -o sid= -p $$ | tr -d ' ')" "$(id -u)"`,
        'IFS= read -r phase0_value',
        `printf '__PLOINKY_IO__${marker}|%s\\n' "$phase0_value"`,
    ].join('; ') + '\r');
    const readyPattern = new RegExp(
        `${escapeRegExp(readyPrefix)}(\\d+)\\|(\\d+)\\|(\\d+)\\|(\\d+)`,
    );
    const readyMatch = await waitFor(() => session.output.match(readyPattern),
        'inner shell readiness');
    const inner = {
        pid: Number(readyMatch[1]),
        pgrp: Number(readyMatch[2]),
        session: Number(readyMatch[3]),
        uid: Number(readyMatch[4]),
    };
    const execIds = await waitFor(() => {
        const values = currentExecIds(containerId);
        return values.length === 1 ? values : null;
    }, 'nested exec identity after readiness');
    assert.deepEqual(execIds, initialExecIds);
    const activeMarkerProcesses = markerProcesses(containerId, user, marker);
    const markerDiagnostic = JSON.stringify({ marker, inner, initialMarkerProcesses, activeMarkerProcesses });
    assert.ok(activeMarkerProcesses.some((entry) => entry.pid === inner.pid), markerDiagnostic);
    assert.ok(activeMarkerProcesses.every((entry) => entry.session === inner.session), markerDiagnostic);
    terminal.resize(101, 33);
    terminal.write(`phase0-input-${marker}\r`);
    await waitForTerminalOutput(session, `__PLOINKY_IO__${marker}|phase0-input-${marker}`,
        'terminal input round trip');
    terminal.write(`printf '__PLOINKY_SIZE__${marker}|'; stty size\r`);
    await waitForTerminalOutput(session, `__PLOINKY_SIZE__${marker}|33 101`, 'terminal resize');
    assert.equal(inspectContainer(containerId).Id, original.Id);
    return {
        terminal,
        exit,
        session,
        cliIdentity,
        inner,
        execId: execIds[0],
        originalImage: original.Image,
        activeMarkerProcesses,
    };
}

async function auditClosedSession({ containerId, user, marker, execId, inner }) {
    await waitFor(() => markerProcesses(containerId, user, marker).length === 0, 'marker reclamation');
    await waitFor(() => sessionProcesses(containerId, user, inner.session).length === 0,
        'inner session reclamation');
    await waitFor(() => currentExecIds(containerId).length === 0, 'exec record drainage');
    const execInspect = runPodman(['inspect', '--type', 'exec', execId], { ok: false });
    assert.equal(execInspect.ok, false);
    return {
        markerProcesses: 0,
        sessionProcesses: 0,
        execIds: 0,
        execInspectAbsent: true,
    };
}

async function runNormalCliSession(target) {
    const opened = await openCliSession(target);
    opened.terminal.write('exit 7\r');
    const exit = await Promise.race([
        opened.exit,
        delay(WAIT_MS).then(() => { throw new Error('normal CLI terminal exit timed out'); }),
    ]);
    assert.equal(exit.exitCode, 7);
    await waitFor(() => !sameLocalProcess(opened.cliIdentity), 'Box Podman client reap');
    const audit = await auditClosedSession({ ...target, ...opened });
    return {
        uid: opened.inner.uid,
        dimensions: [101, 33],
        io: true,
        normalExitCode: exit.exitCode,
        markerInInnerProcess: true,
        boxClient: opened.cliIdentity,
        inner: opened.inner,
        execId: opened.execId,
        audit,
    };
}

async function runClientLoss(target, { foreground = false } = {}) {
    const opened = await openCliSession(target);
    let foregroundIdentity = null;
    if (foreground) {
        const childPrefix = `__PLOINKY_CHILD__${target.marker}|`;
        opened.terminal.write([
            'set -m',
            'sleep 300 & phase0_child=$!',
            `printf '${childPrefix}%s|%s\\n' "$phase0_child" "$(awk '{print $22}' /proc/$phase0_child/stat)"`,
            'fg %1',
        ].join('; ') + '\r');
        const childPattern = new RegExp(`${escapeRegExp(childPrefix)}(\\d+)\\|(\\d+)`);
        const match = await waitFor(() => opened.session.output.match(childPattern),
            'foreground child start');
        foregroundIdentity = { pid: Number(match[1]), startToken: `linux-proc:${match[2]}` };
    }
    assert.equal(sameLocalProcess(opened.cliIdentity), true);
    process.kill(opened.cliIdentity.pid, 'SIGKILL');
    await waitFor(() => !sameLocalProcess(opened.cliIdentity), 'killed Box Podman client reap');
    let autoReclaimed = false;
    try {
        await waitFor(() => markerProcesses(target.containerId, target.user, target.marker).length === 0,
            'automatic client-loss reclamation', 1_500);
        autoReclaimed = true;
    } catch (_) {
        reclaimExactSession(target.containerId, target.user, target.marker, opened.inner.session);
    }
    const audit = await auditClosedSession({ ...target, ...opened });
    if (foregroundIdentity) {
        const result = runPodman([
            'container', 'exec', '--user', target.user, target.containerId,
            '/bin/bash', '-c',
            'test ! -e "/proc/$1/stat" || test "$(awk \'{print $22}\' /proc/$1/stat)" != "$2"',
            'phase0-child-audit', String(foregroundIdentity.pid),
            foregroundIdentity.startToken.slice('linux-proc:'.length),
        ], { ok: false });
        assert.equal(result.ok, true, result.stderr);
    }
    return { autoReclaimed, foregroundIdentity, exactRecovery: !autoReclaimed, audit };
}

function createAgent({ imageId, name, root, runId }) {
    const args = [
        'container', 'create',
        '--name', name,
        '--label', `io.assistos.ploinky.phase0=${runId}`,
    ];
    if (root) args.push('--user', '0:0');
    args.push(imageId, '/bin/bash', '-c', 'trap "exit 0" TERM INT; while :; do sleep 300; done');
    const id = runPodman(args).stdout;
    assert.match(id, /^[a-f0-9]{64}$/);
    runPodman(['container', 'start', id]);
    assert.equal(inspectContainer(id).State.Running, true);
    return id;
}

function removeAgentExact(containerId) {
    const before = runPodman(['container', 'inspect', containerId], { ok: false });
    if (!before.ok) return;
    const [inspection] = JSON.parse(before.stdout);
    assert.equal(inspection.Id, containerId);
    if (inspection.State.Running) {
        runPodman(['container', 'stop', '--time', '1', containerId]);
    }
    const deadline = Date.now() + WAIT_MS;
    while (Date.now() < deadline && currentExecIds(containerId).length > 0) {
        spawnSync('/bin/sleep', ['0.04']);
    }
    assert.deepEqual(currentExecIds(containerId), [], 'exec records must drain before exact removal');
    runPodman(['container', 'rm', containerId]);
    assert.equal(runPodman(['container', 'inspect', containerId], { ok: false }).ok, false);
}

async function runStopRemove(imageId, runId) {
    const name = `phase0-stop-${runId}`;
    const id = createAgent({ imageId, name, root: false, runId });
    const marker = `phase0-${runId}-stop-remove`;
    try {
        const opened = await openCliSession({ containerId: id, user: '1000:1000', marker });
        runPodman(['container', 'stop', '--time', '1', id]);
        await Promise.race([
            opened.exit,
            delay(WAIT_MS).then(() => { throw new Error('target stop did not end terminal'); }),
        ]);
        assert.equal(inspectContainer(id).State.Running, false);
        runPodman(['container', 'rm', id]);
        assert.equal(runPodman(['container', 'inspect', id], { ok: false }).ok, false);
        return { exactContainerId: id, terminalExited: true, containerAbsent: true };
    } finally {
        removeAgentExact(id);
    }
}

async function runSameNameReplacement(imageId, runId) {
    const name = `phase0-replace-${runId}`;
    const oldId = createAgent({ imageId, name, root: false, runId });
    const marker = `phase0-${runId}-same-name`;
    let replacementId = '';
    try {
        const opened = await openCliSession({ containerId: oldId, user: '1000:1000', marker });
        removeAgentExact(oldId);
        await Promise.race([
            opened.exit,
            delay(WAIT_MS).then(() => { throw new Error('target removal did not end terminal'); }),
        ]);
        replacementId = createAgent({ imageId, name, root: false, runId });
        assert.notEqual(replacementId, oldId);
        const staleExec = runPodman(['container', 'exec', oldId, '/bin/true'], { ok: false });
        assert.equal(staleExec.ok, false);
        assert.equal(markerProcesses(replacementId, '1000:1000', marker).length, 0);
        return {
            oldId,
            replacementId,
            staleExactIdRefused: true,
            replacementMarkerProcesses: 0,
        };
    } finally {
        removeAgentExact(replacementId);
        removeAgentExact(oldId);
    }
}

function readOneJsonLine(stream, prefix, timeoutMs = WAIT_MS) {
    return new Promise((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => reject(new Error(`${prefix} timed out: ${output}`)), timeoutMs);
        stream.setEncoding('utf8');
        stream.on('data', (chunk) => {
            output += chunk;
            const line = output.split(/\n/).find((entry) => entry.startsWith(prefix));
            if (!line) return;
            clearTimeout(timer);
            resolve(JSON.parse(Buffer.from(line.slice(prefix.length), 'base64url').toString('utf8')));
        });
    });
}

async function runWorkerCrash(target, recordPath) {
    const worker = spawn('/usr/local/bin/node', [process.argv[1], '--worker'], {
        env: {
            ...process.env,
            PHASE0_WORKER_CONFIG: Buffer.from(JSON.stringify({ ...target, recordPath })).toString('base64url'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const ready = await readOneJsonLine(worker.stdout, '__PLOINKY_WORKER_READY__');
    const workerIdentity = localProcessIdentity(worker.pid);
    assert.equal(ready.containerId, target.containerId);
    assert.equal(fs.existsSync(recordPath), true);
    process.kill(workerIdentity.pid, 'SIGKILL');
    await waitFor(() => !sameLocalProcess(workerIdentity), 'killed worker reap');
    const recovery = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    assert.equal(recovery.containerId, target.containerId);
    assert.equal(recovery.marker, target.marker);
    assert.equal(inspectContainer(recovery.containerId).Id, recovery.containerId);
    let autoReclaimed = false;
    try {
        await waitFor(() => markerProcesses(target.containerId, target.user, target.marker).length === 0,
            'worker-crash automatic reclamation', 1_500);
        autoReclaimed = true;
    } catch (_) {
        reclaimExactSession(target.containerId, target.user, target.marker, recovery.inner.session);
    }
    const audit = await auditClosedSession({ ...target, ...recovery });
    fs.unlinkSync(recordPath);
    assert.equal(fs.existsSync(recordPath), false);
    const recoveredSession = await runNormalCliSession({
        ...target,
        marker: `${target.marker}-recovered`,
    });
    return {
        workerIdentity,
        recovery,
        autoReclaimed,
        exactRecovery: !autoReclaimed,
        audit,
        nextWorkerSession: recoveredSession.audit,
        recoveryRecordRemovedAfterProof: true,
    };
}

function request({ socketPath, method, requestPath, body = null }) {
    return new Promise((resolve, reject) => {
        const payload = body === null ? '' : JSON.stringify(body);
        const req = http.request({
            socketPath,
            method,
            path: requestPath,
            headers: {
                ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
            },
        }, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body: data }));
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

function requestUpgrade({ socketPath, requestPath, body }) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const req = http.request({
            socketPath,
            method: 'POST',
            path: requestPath,
            headers: {
                connection: 'Upgrade',
                upgrade: 'tcp',
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload),
            },
        });
        req.on('upgrade', (res, socket, head) => resolve({ status: res.statusCode, socket, head }));
        req.on('response', (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => reject(new Error(`exec start returned ${res.statusCode}: ${data}`)));
        });
        req.on('error', reject);
        req.end(payload);
    });
}

async function runRestCandidate({ containerId, user, marker, runId }) {
    const directory = `/tmp/phase0-rest-${runId}`;
    const socketPath = path.join(directory, 'podman.sock');
    fs.mkdirSync(directory, { mode: 0o700 });
    const service = spawn(PODMAN, ['system', 'service', '--time=0', `unix://${socketPath}`], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
    });
    const serviceIdentity = localProcessIdentity(service.pid);
    let attachedSocket = null;
    try {
        await waitFor(() => fs.existsSync(socketPath), 'Podman REST socket');
        assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
        assert.equal(fs.statSync(socketPath).mode & 0o077, 0);
        const ping = await request({ socketPath, method: 'GET', requestPath: '/_ping' });
        assert.equal(ping.status, 200);
        const version = await request({ socketPath, method: 'GET', requestPath: '/version' });
        assert.equal(version.status, 200);
        const created = await request({
            socketPath,
            method: 'POST',
            requestPath: `/v5.0.0/containers/${containerId}/exec`,
            body: {
                AttachStdin: true,
                AttachStdout: true,
                AttachStderr: true,
                Cmd: ['/bin/bash', '-c', 'exec -a "$PLOINKY_WEBTTY_MARKER" /bin/bash --noprofile --norc'],
                Env: [`PLOINKY_WEBTTY_MARKER=${marker}`, 'TERM=xterm-256color'],
                Privileged: false,
                Tty: true,
                User: user,
                WorkingDir: '/tmp',
            },
        });
        assert.equal(created.status, 201, created.body);
        const execId = JSON.parse(created.body).Id;
        assert.match(execId, /^[a-f0-9]{64}$/);
        const attached = await requestUpgrade({
            socketPath,
            requestPath: `/v5.0.0/exec/${execId}/start`,
            body: { Detach: false, Tty: true },
        });
        assert.equal(attached.status, 101);
        attachedSocket = attached.socket;
        let output = attached.head.toString('utf8');
        attached.socket.setEncoding('utf8');
        attached.socket.on('data', (chunk) => { output += chunk; });
        const readyPrefix = `__PLOINKY_REST_READY__${marker}|`;
        const readyPattern = new RegExp(
            `${escapeRegExp(readyPrefix)}(\\d+)\\|(\\d+)\\|(\\d+)\\|(\\d+)`,
        );
        attached.socket.write([
            `printf '${readyPrefix}%s|%s|%s|%s\\n' "$$" "$(ps -o pgid= -p $$ | tr -d ' ')" "$(ps -o sid= -p $$ | tr -d ' ')" "$(id -u)"`,
            'IFS= read -r value',
            `printf '__PLOINKY_REST_IO__${marker}|%s\\n' "$value"`,
        ].join('; ') + '\r');
        const readyMatch = await waitFor(() => output.match(readyPattern),
            'REST attached terminal numeric readiness');
        const inner = {
            pid: Number(readyMatch[1]),
            pgrp: Number(readyMatch[2]),
            session: Number(readyMatch[3]),
            uid: Number(readyMatch[4]),
        };
        const activeMarkerProcesses = markerProcesses(containerId, user, marker);
        const markerDiagnostic = JSON.stringify({ marker, inner, activeMarkerProcesses });
        assert.ok(activeMarkerProcesses.some((entry) => entry.pid === inner.pid), markerDiagnostic);
        assert.ok(activeMarkerProcesses.every((entry) => entry.session === inner.session), markerDiagnostic);
        await waitFor(() => {
            const execIds = currentExecIds(containerId);
            return execIds.length === 1 && execIds[0] === execId;
        }, 'REST exact exec identity after readiness');
        attached.socket.write(`rest-input-${marker}\r`);
        await waitFor(() => output.includes(`__PLOINKY_REST_IO__${marker}|rest-input-${marker}`),
            'REST explicit application input round trip');
        const resized = await request({
            socketPath,
            method: 'POST',
            requestPath: `/v5.0.0/exec/${execId}/resize?h=29&w=97`,
        });
        assert.equal(resized.status, 200, resized.body);
        attached.socket.write(`printf '__PLOINKY_REST_SIZE__${marker}|'; stty size\r`);
        await waitFor(() => output.includes(`__PLOINKY_REST_SIZE__${marker}|29 97`), 'REST resize');
        const unsupportedKill = await request({
            socketPath,
            method: 'POST',
            requestPath: `/v5.0.0/exec/${execId}/kill`,
            body: { Signal: 'SIGTERM' },
        });
        assert.equal(unsupportedKill.status, 404);
        attached.socket.destroy();
        attachedSocket = null;
        const inspected = async () => {
            const response = await request({
                socketPath,
                method: 'GET',
                requestPath: `/v5.0.0/exec/${execId}/json`,
            });
            if (response.status !== 200) return null;
            return JSON.parse(response.body);
        };
        let automaticDisconnectCleanup = false;
        try {
            await waitFor(async () => (await inspected())?.Running === false,
                'REST attach disconnect cleanup', 1_500);
            automaticDisconnectCleanup = true;
        } catch (_) {
            const processes = markerProcesses(containerId, user, marker);
            if (processes.length > 0) {
                reclaimExactSession(containerId, user, marker, processes[0].session);
            }
        }
        await waitFor(() => markerProcesses(containerId, user, marker).length === 0,
            'REST marker reclamation');
        await waitFor(() => currentExecIds(containerId).length === 0, 'REST exec drainage');
        return {
            serviceIdentity,
            socketMode: fs.statSync(socketPath).mode & 0o777,
            apiVersion: JSON.parse(version.body).ApiVersion,
            execId,
            io: true,
            dimensions: [97, 29],
            unsupportedExactExecTerminationStatus: unsupportedKill.status,
            automaticDisconnectCleanup,
            audit: { markerProcesses: 0, execIds: 0 },
        };
    } finally {
        if (attachedSocket && !attachedSocket.destroyed) attachedSocket.destroy();
        if (sameLocalProcess(serviceIdentity)) process.kill(serviceIdentity.pid, 'SIGTERM');
        await waitFor(() => !sameLocalProcess(serviceIdentity), 'REST service reap');
        fs.rmSync(directory, { recursive: true, force: false });
    }
}

function inventory(containerImage) {
    runPodman(['image', 'pull', containerImage], { timeout: 10 * 60_000 });
    const images = podmanJson(['image', 'inspect', containerImage]);
    assert.equal(images.length, 1);
    const image = images[0];
    assert.match(image.Id, /^[a-f0-9]{64}$/);
    const podmanVersion = podmanJson(['version', '--format', 'json']);
    const podmanInfo = podmanJson(['info', '--format', 'json']);
    return {
        podmanVersion,
        rootless: podmanInfo.host?.security?.rootless ?? podmanInfo.Host?.Security?.Rootless,
        graphRoot: podmanInfo.store?.graphRoot ?? podmanInfo.Store?.GraphRoot,
        runRoot: podmanInfo.store?.runRoot ?? podmanInfo.Store?.RunRoot,
        imageId: image.Id,
        imageDigest: image.Digest,
        repoDigests: image.RepoDigests || [],
        configuredUser: image.Config?.User || '',
    };
}

async function runWorkerMode() {
    const config = JSON.parse(Buffer.from(process.env.PHASE0_WORKER_CONFIG, 'base64url').toString('utf8'));
    const opened = await openCliSession(config);
    const recovery = {
        schema: 'ploinky-webtty-agent-phase0-recovery/v1',
        containerId: config.containerId,
        user: config.user,
        marker: config.marker,
        execId: opened.execId,
        inner: opened.inner,
        boxClient: opened.cliIdentity,
    };
    fs.writeFileSync(config.recordPath, `${JSON.stringify(recovery)}\n`, { flag: 'wx', mode: 0o600 });
    process.stdout.write(`__PLOINKY_WORKER_READY__${Buffer.from(JSON.stringify(recovery)).toString('base64url')}\n`);
    setInterval(() => {}, 60_000);
}

async function runMatrix(config) {
    const runId = `wtty-${process.pid}-${crypto.randomBytes(5).toString('hex')}`;
    const runtime = inventory(config.agentImage);
    process.stderr.write(`phase0-inventory:${JSON.stringify(runtime)}\n`);
    assert.equal(runtime.rootless, true);
    assert.match(runtime.configuredUser, /^(?:1000(?::1000)?|node)$/);
    const rootName = `phase0-root-${runId}`;
    const nonRootName = `phase0-user-${runId}`;
    const rootId = createAgent({ imageId: runtime.imageId, name: rootName, root: true, runId });
    const nonRootId = createAgent({ imageId: runtime.imageId, name: nonRootName, root: false, runId });
    const owned = [rootId, nonRootId];
    const audits = [];
    let primaryError = null;
    let stage = config.firstCandidate === 'cli' ? 'root-normal' : 'rest-candidate';
    try {
        let rest = null;
        if (config.firstCandidate !== 'cli') {
            process.stderr.write(`phase0-stage:${stage}\n`);
            rest = await runRestCandidate({
                containerId: nonRootId,
                user: '1000:1000',
                marker: `phase0-${runId}-rest`,
                runId,
            });
            audits.push(rest.audit);
            stage = 'root-normal';
        }
        process.stderr.write(`phase0-stage:${stage}\n`);
        const root = await runNormalCliSession({
            containerId: rootId,
            user: '0:0',
            marker: `phase0-${runId}-root-normal`,
        });
        audits.push(root.audit);
        assert.equal(root.uid, 0);
        stage = 'non-root-normal';
        process.stderr.write(`phase0-stage:${stage}\n`);
        const nonRoot = await runNormalCliSession({
            containerId: nonRootId,
            user: '1000:1000',
            marker: `phase0-${runId}-user-normal`,
        });
        audits.push(nonRoot.audit);
        assert.equal(nonRoot.uid, 1000);
        stage = 'box-client-loss';
        process.stderr.write(`phase0-stage:${stage}\n`);
        const clientLoss = await runClientLoss({
            containerId: nonRootId,
            user: '1000:1000',
            marker: `phase0-${runId}-client-loss`,
        });
        audits.push(clientLoss.audit);
        stage = 'foreground-child-client-loss';
        process.stderr.write(`phase0-stage:${stage}\n`);
        const foreground = await runClientLoss({
            containerId: rootId,
            user: '0:0',
            marker: `phase0-${runId}-foreground`,
        }, { foreground: true });
        audits.push(foreground.audit);
        stage = 'target-stop-remove';
        process.stderr.write(`phase0-stage:${stage}\n`);
        const stopRemove = await runStopRemove(runtime.imageId, runId);
        stage = 'same-name-replacement';
        process.stderr.write(`phase0-stage:${stage}\n`);
        const sameName = await runSameNameReplacement(runtime.imageId, runId);
        const recordPath = `/workspace/.phase0-webtty-recovery-${runId}.json`;
        stage = 'worker-crash-recovery';
        process.stderr.write(`phase0-stage:${stage}\n`);
        const workerCrash = await runWorkerCrash({
            containerId: nonRootId,
            user: '1000:1000',
            marker: `phase0-${runId}-worker-crash`,
        }, recordPath);
        audits.push(workerCrash.audit, workerCrash.nextWorkerSession);
        if (!rest) {
            stage = 'rest-candidate';
            process.stderr.write(`phase0-stage:${stage}\n`);
            rest = await runRestCandidate({
                containerId: nonRootId,
                user: '1000:1000',
                marker: `phase0-${runId}-rest`,
                runId,
            });
            audits.push(rest.audit);
        }
        assert.ok(audits.every((entry) => entry.markerProcesses === 0 && entry.execIds === 0));
        return {
            schema: 'ploinky-webtty-agent-phase0/v1',
            runId,
            box: {
                uid: process.getuid(),
                gid: process.getgid(),
                node: process.version,
                nodePty: require('/usr/local/lib/ploinky/webtty/node_modules/node-pty/package.json').version,
                podmanSocket: '/run/user/1000/podman/podman.sock',
            },
            runtime,
            agents: {
                root: { containerId: rootId, configuredUser: '0:0' },
                nonRoot: { containerId: nonRootId, configuredUser: runtime.configuredUser },
            },
            cliNodePty: { root, nonRoot, clientLoss, foreground, stopRemove, sameName, workerCrash },
            rest,
            selectedBackend: 'controlled-podman-exec-under-box-node-pty',
            selectionReason: 'CLI passed every identity/reclamation gate; REST has no exact exec termination endpoint',
            orphanAudits: audits,
        };
    } catch (error) {
        primaryError = error;
        error.message = `phase0 stage ${stage} failed: ${error.message}`;
        throw error;
    } finally {
        const cleanupErrors = [];
        for (const id of owned.reverse()) {
            try {
                removeAgentExact(id);
            } catch (error) {
                cleanupErrors.push(`${id}: ${error.message}`);
            }
        }
        try {
            const remaining = podmanJson([
                'container', 'list', '--all',
                '--filter', `label=io.assistos.ploinky.phase0=${runId}`,
                '--format', 'json',
            ]);
            assert.deepEqual(remaining, []);
        } catch (error) {
            cleanupErrors.push(`label audit: ${error.message}`);
        }
        if (cleanupErrors.length > 0) {
            const detail = `Phase 0 cleanup failed:\n${cleanupErrors.join('\n')}`;
            if (primaryError) primaryError.message += `\n${detail}`;
            else throw new Error(detail);
        }
    }
}

async function main() {
    if (process.argv[2] === '--worker') {
        await runWorkerMode();
        return;
    }
    const encoded = process.argv[2] || '';
    const config = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    const result = await runMatrix(config);
    process.stdout.write(`${JSON.stringify(result)}\n`);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invoked) {
    main().catch((error) => {
        process.stderr.write(`${error.stack || error}\n`);
        process.exitCode = 1;
    });
}

export { runMatrix };
