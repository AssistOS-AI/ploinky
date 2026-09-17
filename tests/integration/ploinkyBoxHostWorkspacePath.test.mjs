import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { AGENTLIB_STABLE_MOUNT_PATH } from '../../agentlib/contract.mjs';
import { BOX_AGENTLIB_LABELS } from '../../ploinky-box/constants.mjs';
import {
    createPodmanHarness,
    execInBox,
    requirePodmanCandidate,
} from '../e2e/ploinkyBox/nativeHelpers.mjs';

const WORKSPACE_NAME = "work space ăîș 文档 'quoted' $(printf unexpected);&[]";

const OUTER_PROBE = String.raw`
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const [root, externalLink] = process.argv.slice(1);
assert.equal(process.cwd(), root);
assert.equal(fs.realpathSync('.'), root);
assert.equal(process.env.PLOINKY_WORKSPACE_ROOT, root);
assert.equal(fs.readFileSync(path.join(root, 'host.txt'), 'utf8'), 'from-host');
assert.equal(fs.readFileSync(path.join(root, 'absolute-in-tree'), 'utf8'), 'from-host');
assert.throws(() => fs.readFileSync(externalLink), { code: 'ENOENT' });
fs.writeFileSync(path.join(root, 'box.txt'), 'from-box');
process.stdout.write('OUTER_HOST_PATH_OK');
`;

const READ_ONLY_PROBE = String.raw`
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
for (const root of process.argv.slice(1)) {
    const filename = path.join(root, '.host-workspace-read-only-probe');
    assert.throws(() => fs.writeFileSync(filename, 'must-not-write', { flag: 'wx' }), { code: 'EROFS' });
    assert.equal(fs.existsSync(filename), false);
}
process.stdout.write('AGENTLIB_READ_ONLY_OK');
`;

const WEBTTY_PROBE = String.raw`
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { buildWorkerEnvironment, buildShellEnvironment } from '/opt/ploinky/core-services/webtty/environment.mjs';
import { WebttyWorkerClient } from '/opt/ploinky/cli/server/webtty/workerClient.mjs';
import { readLinuxProcessIdentity, listLinuxSessionMembers } from '/opt/ploinky/cli/server/webtty/runtimeRecords.mjs';

const [workspaceRoot] = process.argv.slice(1);
const options = { workspaceRoot };
const client = new WebttyWorkerClient({
    terminalId: 'native_host_path_terminal_01',
    marker: 'native_host_path_worker_marker_01',
    workspaceRoot,
    workerEnv: buildWorkerEnvironment(process.env, options),
    // The probe uses node -e; the production worker must run its own module.
    forkImpl: (filename, args, config) => fork(filename, args, { ...config, execArgv: [] }),
    closeGraceMs: 5_000,
});
let output = '';
let terminalExit;
let processExit;
let requestedClose = false;
const errors = [];
client.on('output', (message) => { output = (output + message.data).slice(-64 * 1024); });
client.on('terminal-error', (message) => errors.push(message.category));
client.on('error-category', (message) => {
    if (!requestedClose || message.category !== 'ipc_disconnected') errors.push(message.category);
});
client.on('terminal-exit', (message) => { terminalExit = message; });
client.on('process-exit', (message) => { processExit = message; });

async function waitUntil(predicate, label, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) return;
        assert.deepEqual(errors, [], label);
        await delay(25);
    }
    assert.fail(label + ' timed out');
}

let workerIdentity;
let ptyIdentity;
try {
    workerIdentity = await client.spawn();
    const ready = await client.start({
        cwdRelative: '', cols: 160, rows: 24,
        shellEnv: buildShellEnvironment(process.env, options),
    });
    ptyIdentity = ready.processIdentity;
    // The shell echo contains literal backslash-octal text. Only execution
    // emits the actual record separators, so echoed input cannot pass.
    await client.input('printf "\\n\\036PLOINKY_PATH:%s\\037%s\\036\\n" "$PWD" "$PLOINKY_WORKSPACE_ROOT"\r');
    const marker = /\x1ePLOINKY_PATH:([^\x1e\x1f]*)\x1f([^\x1e\x1f]*)\x1e/;
    await waitUntil(() => marker.test(output), 'WebTTY path output');
    const match = marker.exec(output);
    assert.equal(match[1], workspaceRoot, 'the real PTY shell PWD preserves the host path');
    assert.equal(match[2], workspaceRoot, 'the real PTY shell environment preserves the host path');
    assert.deepEqual(errors, []);
} finally {
    requestedClose = true;
    await client.close();
    assert.equal(await client.waitForExit(6_000), true, 'the worker must exit after controlled close');
}
assert.deepEqual(errors, [], 'no terminal or cleanup failure may be ignored');
assert.equal(terminalExit?.category, 'requested');
assert.equal(processExit?.exitCode, 0);
assert.equal(processExit?.signal, null, 'the worker must exit without the client killing it');
assert.equal(await readLinuxProcessIdentity(workerIdentity.pid), null, 'the worker was reaped');
await waitUntil(async () => (await readLinuxProcessIdentity(ptyIdentity.pid)) === null, 'PTY shell reaping', 3_000);
assert.deepEqual(await listLinuxSessionMembers(ptyIdentity.sessionId), [], 'no process survives in the PTY session');
await delay(25);
assert.deepEqual(await listLinuxSessionMembers(ptyIdentity.sessionId), [], 'PTY cleanup remains proven');
process.stdout.write('WEBTTY_HOST_PATH_OK');
`;

const NESTED_PROBE = [
    'set -eu',
    'test "$(pwd -P)" = "$1"',
    'test "$PLOINKY_WORKSPACE_ROOT" = "$1"',
    'test "$(cat "$1/host.txt")" = from-host',
    'test "$(cat "$1/box.txt")" = from-box',
    'test "$(cat "$1/absolute-in-tree")" = from-host',
    'test ! -e "$1/absolute-external"',
    'test ! -e "$2"',
    'test ! -e /workspace/host.txt',
    'printf from-nested > "$1/nested.txt"',
    'if test -n "$3"; then',
    '  test -r "$3/package.json"',
    '  if (printf must-not-write > "$3/.nested-read-only-probe") 2>/dev/null; then exit 21; fi',
    '  test ! -e "$3/.nested-read-only-probe"',
    'fi',
    'printf NESTED_HOST_PATH_OK',
].join('\n');

function inspectBox(harness, containerId) {
    const result = harness.runner.query('podman', ['container', 'inspect', containerId]);
    assert.equal(result.ok, true, result.stderr);
    return JSON.parse(result.stdout)[0];
}

test('native Box, WebTTY, and nested Podman preserve the literal host workspace path', {
    timeout: 15 * 60_000,
}, async (t) => {
    const candidateReference = requirePodmanCandidate(t);
    if (!candidateReference) return;
    const harness = createPodmanHarness(t, candidateReference, { workspaceName: WORKSPACE_NAME });
    const workspaceRoot = harness.identity.workspaceRoot;
    const selectedAgentLib = String(process.env.PLOINKY_TEST_AGENTLIB_DIR || '');
    const localAgentLib = selectedAgentLib ? path.join(workspaceRoot, 'achillesAgentLib') : null;
    if (localAgentLib) {
        fs.cpSync(fs.realpathSync(selectedAgentLib), localAgentLib, { recursive: true });
    }
    const externalFile = path.join(harness.root, 'outside-workspace.txt');
    fs.writeFileSync(path.join(workspaceRoot, 'host.txt'), 'from-host');
    fs.writeFileSync(externalFile, 'outside-workspace');
    fs.symlinkSync(path.join(workspaceRoot, 'host.txt'), path.join(workspaceRoot, 'absolute-in-tree'));
    fs.symlinkSync(externalFile, path.join(workspaceRoot, 'absolute-external'));

    let prepared;
    try {
        prepared = await harness.supervisor.prepareBoxForCommand({
            imageRef: candidateReference,
            explicitPort: 19104,
            explicitMediaPort: 17904,
        });
    } catch (error) {
        t.diagnostic(harness.output.bytes.slice(-16_000));
        throw error;
    }
    const containerId = prepared.containerId;
    const record = inspectBox(harness, containerId);
    assert.equal(record.Config.WorkingDir, workspaceRoot);
    assert.deepEqual(record.Config.Env.filter((entry) => entry.startsWith('PLOINKY_WORKSPACE_ROOT=')),
        [`PLOINKY_WORKSPACE_ROOT=${workspaceRoot}`]);
    const workspaceMounts = record.Mounts.filter((mount) => mount.Destination === workspaceRoot);
    assert.equal(workspaceMounts.length, 1);
    assert.equal(workspaceMounts[0].Type, 'bind');
    assert.equal(workspaceMounts[0].Source, workspaceRoot);
    assert.equal(workspaceMounts[0].RW, true);
    assert.equal(record.Mounts.some((mount) => /^\/workspace(?:\/|$)/.test(mount.Destination)), false);
    assert.equal(execInBox(harness.runner, containerId, ['pwd', '-P']), workspaceRoot);
    assert.equal(execInBox(harness.runner, containerId, [
        'node', '-e', OUTER_PROBE, workspaceRoot, path.join(workspaceRoot, 'absolute-external'),
    ]), 'OUTER_HOST_PATH_OK');
    assert.equal(fs.readFileSync(path.join(workspaceRoot, 'box.txt'), 'utf8'), 'from-box');
    assert.equal(execInBox(harness.runner, containerId, [
        'node', '--input-type=module', '-e', WEBTTY_PROBE, workspaceRoot,
    ], { timeoutMs: 30_000 }), 'WEBTTY_HOST_PATH_OK');

    const agentLibMode = record.Config.Labels[BOX_AGENTLIB_LABELS.mode];
    assert.equal(agentLibMode, localAgentLib ? 'local' : 'image');
    if (localAgentLib) {
        for (const destination of [AGENTLIB_STABLE_MOUNT_PATH, localAgentLib]) {
            const mount = record.Mounts.find((entry) => entry.Destination === destination);
            assert.equal(mount?.Source, localAgentLib);
            assert.equal(mount?.RW, false);
        }
        assert.equal(execInBox(harness.runner, containerId, [
            'node', '-e', READ_ONLY_PROBE, AGENTLIB_STABLE_MOUNT_PATH, localAgentLib,
        ]), 'AGENTLIB_READ_ONLY_OK');
    } else {
        assert.equal(record.Mounts.some((mount) => mount.Destination === AGENTLIB_STABLE_MOUNT_PATH), false);
        assert.match(record.Config.Labels[BOX_AGENTLIB_LABELS.commit], /^[a-f0-9]{40}$/);
        assert.match(record.Config.Labels[BOX_AGENTLIB_LABELS.fingerprint], /^[a-f0-9]{64}$/);
    }

    const probeImage = String(process.env.PLOINKY_BOX_NESTED_PROBE_IMAGE || 'docker.io/library/alpine:latest');
    execInBox(harness.runner, containerId, ['podman', 'pull', probeImage], { timeoutMs: 600_000 });
    const probeImageId = execInBox(harness.runner, containerId, [
        'podman', 'image', 'inspect', '--format', '{{.Id}}', probeImage,
    ]);
    assert.match(probeImageId, /^(?:sha256:)?[a-f0-9]{64}$/);
    let nestedId;
    try {
        nestedId = execInBox(harness.runner, containerId, [
            'podman', 'create', '--network=none', '--image-volume=ignore',
            '--workdir', workspaceRoot,
            '--env', `PLOINKY_WORKSPACE_ROOT=${workspaceRoot}`,
            '--volume', `${workspaceRoot}:${workspaceRoot}`,
            probeImageId, 'sh', '-c', NESTED_PROBE,
            'host-workspace-probe', workspaceRoot, externalFile, localAgentLib || '',
        ]);
        assert.match(nestedId, /^[a-f0-9]{64}$/);
        const nestedRecord = JSON.parse(execInBox(harness.runner, containerId, [
            'podman', 'container', 'inspect', nestedId,
        ]))[0];
        assert.equal(nestedRecord.Config.WorkingDir, workspaceRoot);
        assert.deepEqual(nestedRecord.Mounts.map((mount) => ({
            source: mount.Source, destination: mount.Destination, rw: mount.RW,
        })), [{ source: workspaceRoot, destination: workspaceRoot, rw: true }]);
        assert.equal(execInBox(harness.runner, containerId, [
            'podman', 'container', 'start', '--attach', nestedId,
        ], { timeoutMs: 120_000 }), 'NESTED_HOST_PATH_OK');
        assert.equal(fs.readFileSync(path.join(workspaceRoot, 'nested.txt'), 'utf8'), 'from-nested');
    } finally {
        if (nestedId) execInBox(harness.runner, containerId, ['podman', 'container', 'rm', '--force', nestedId]);
    }
    t.diagnostic(`Verified ${workspaceRoot}; outer image ${record.Image}; nested image ${probeImageId}; AgentLib ${agentLibMode}`);
});
