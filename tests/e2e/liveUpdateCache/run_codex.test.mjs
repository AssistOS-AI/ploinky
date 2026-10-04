import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { manifestFixture, installPureGuards } from './test_support_codex.mjs';
import { acceptanceMain, IMPLEMENTED_PHASES, readManifestFile } from './run_codex.mjs';
import { REQUIRED_PHASES } from './contracts_codex.mjs';
const controlledSpawn = cp.spawnSync;
installPureGuards();
test('every stage is wired but a valid manifest still launches nothing on an unqualified host and never reports a pass', async () => {
    const { value, nowMs } = manifestFixture(); assert.deepEqual(IMPLEMENTED_PHASES, REQUIRED_PHASES);
    const outputs = []; const exit = await acceptanceMain(['--acceptance', '/owned/manifest_codex.json'], { nowMs, read: () => Buffer.from(JSON.stringify(value)), write: record => outputs.push(record) });
    assert.equal(exit, 64); assert.equal(outputs.length, 1); assert.equal(outputs[0].status, 'REFUSED'); assert.equal(outputs[0].acceptance, 'UNQUALIFIED'); assert.equal(outputs[0].reason, 'runtime-host-unqualified'); assert.equal(outputs[0].resourceDisposition, 'NO_RUNTIME_LAUNCHED');
    for (const hostFacts of [{ platform: 'darwin', uid: 1000 }, { platform: 'linux', uid: 0 }]) {
        const refused = []; assert.equal(await acceptanceMain(['--acceptance', '/owned/manifest_codex.json'], { nowMs, hostFacts, read: () => Buffer.from(JSON.stringify(value)), write: record => refused.push(record) }), 64);
        assert.equal(refused[0].reason, 'runtime-host-unqualified');
    }
    // A qualified host without the operator inputs file still refuses before any adapter exists.
    const missing = []; const io = { openSync: () => { const error = new Error('x'); error.code = 'ENOENT'; throw error; } };
    assert.equal(await acceptanceMain(['--acceptance', '/owned/manifest_codex.json'], { nowMs, hostFacts: { platform: 'linux', uid: 1000 }, io, read: () => Buffer.from(JSON.stringify(value)), write: record => missing.push(record) }), 64);
    assert.equal(missing[0].reason, 'acceptance-inputs-missing');
});
test('invalid argc/Node/manifest refuses before runtime work and public errors contain no private details', async () => {
    let reads = 0; const outputs = [], read = () => { reads++; throw new Error('PRIVATE-FS-DETAIL'); }, write = row => outputs.push(row);
    assert.equal(await acceptanceMain(['--acceptance', '/owned/manifest_codex.json', '--skip'], { read, write }), 64); assert.equal(reads, 0);
    assert.equal(await acceptanceMain(['--acceptance', '/owned/manifest_codex.json'], { read, write, nodeVersion: 'v21.0.0' }), 64); assert.equal(reads, 0);
    assert.equal(await acceptanceMain(['--acceptance', '/owned/manifest_codex.json'], { read, write }), 64); assert.equal(reads, 1);
    assert.equal(JSON.stringify(outputs).includes('PRIVATE'), false);
});
test('only an explicit PASS verdict with exit 0 is success; other receipts and exceptions are nonzero', async () => {
    const { value, nowMs } = manifestFixture(), outputs = [];
    const run = receipt => async () => receipt;
    assert.equal(await acceptanceMain(['--acceptance', '/owned/manifest_codex.json'], { nowMs, read: () => Buffer.from(JSON.stringify(value)), write: row => outputs.push(row), run: run({ exitCode: 0, acceptance: 'PASS' }) }), 0);
    assert.equal(await acceptanceMain(['--acceptance', '/owned/manifest_codex.json'], { nowMs, read: () => Buffer.from(JSON.stringify(value)), write: row => outputs.push(row), run: run({ exitCode: 3, acceptance: 'UNQUALIFIED' }) }), 3);
    for (const receipt of [{ exitCode: 0, acceptance: 'FAIL' }, { exitCode: 0 }, {}, { exitCode: -1, acceptance: 'PASS' }, { exitCode: 0, acceptance: 'UNQUALIFIED' }]) {
        assert.equal(await acceptanceMain(['--acceptance', '/owned/manifest_codex.json'], { nowMs, read: () => Buffer.from(JSON.stringify(value)), write: row => outputs.push(row), run: run(receipt) }), 1, JSON.stringify(receipt));
    }
    assert.equal(await acceptanceMain(['--acceptance', '/owned/manifest_codex.json'], { nowMs, read: () => Buffer.from(JSON.stringify(value)), write: row => outputs.push(row), run: async () => { throw new Error('PRIVATE'); } }), 64);
    assert.equal(outputs.at(-1).resourceDisposition, 'NO_RUNTIME_LAUNCHED'); assert.equal(JSON.stringify(outputs.at(-1)).includes('PRIVATE'), false);
});
test('manifest reader is no-follow, bounded/stable and closes descriptor after refusal', () => {
    let closed = 0, flags; const bytes = Buffer.from('{}'), stat = { isFile: () => true, nlink: 1, mode: 0o100600, size: bytes.length, dev: 1, ino: 2, uid: 1000 };
    const io = { openSync: (_file, value) => { flags = value; return 1; }, fstatSync: () => stat,
        readSync: (_fd, buffer, offset) => { if (offset) return 0; bytes.copy(buffer); return bytes.length; }, closeSync: () => { closed++; } };
    assert.deepEqual(readManifestFile('/owned/manifest_codex.json', io), bytes); assert(flags & fs.constants.O_NOFOLLOW); assert.equal(closed, 1);
    stat.nlink = 2; assert.throws(() => readManifestFile('/owned/manifest_codex.json', io)); assert.equal(closed, 2);
});

test('controlled shell fixture: exact old branch-config side effect versus new early dispatch/refusal', () => {
    assert.match(process.env.PLOINKY_AGENTLIB_FINGERPRINT ?? '', /^[a-f0-9]{64}$/, 'registered test contract must precede controlled shell fixture');
    const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
    const evidence = '/Users/danielsava/work/file-parser/.worktrees/cleanup-repair-20261002/evidence/lane-update-cache/execution_checkpoint_20261004_codex';
    const fixture = fs.mkdtempSync('/private/tmp/live-entry-'); fs.mkdirSync(path.join(fixture, 'bin')); fs.mkdirSync(path.join(fixture, 'home'));
    const marker = path.join(fixture, 'branch_marker_codex.txt'), nodeMarker = path.join(fixture, 'node_marker_codex.txt');
    fs.writeFileSync(path.join(fixture, 'bin/node'), `#!/bin/sh\nprintf dispatch > '${nodeMarker}'\nexit 91\n`, { mode: 0o700 });
    const run = (kind, script, args) => {
        const folder = path.join(fixture, kind, 'tests'); fs.mkdirSync(folder, { recursive: true });
        for (const name of ['run-all.sh', 'test_all.sh']) fs.copyFileSync(kind === 'old' ? path.join(evidence, 'baseline', name) : path.join(repo, 'tests', name), path.join(folder, name));
        fs.writeFileSync(path.join(folder, 'branch_config.sh'), `printf branch > '${marker}'\nexit 77\n`);
        const result = controlledSpawn('/bin/bash', [path.join(folder, script), ...args], { cwd: fixture, timeout: 5000, maxBuffer: 4096,
            env: { HOME: path.join(fixture, 'home'), TMPDIR: fixture, PATH: `${path.join(fixture, 'bin')}:/usr/bin:/bin`, PLOINKY_BRANCH: 'trap' } });
        assert.equal(result.error, undefined); return result.status;
    };
    const args = ['--acceptance', path.join(fixture, 'manifest_codex.json')];
    assert.equal(run('old', 'test_all.sh', args), 77); assert.equal(fs.existsSync(marker), true); fs.unlinkSync(marker);
    for (const script of ['run-all.sh', 'test_all.sh']) {
        assert.equal(run('candidate', script, args), 91); assert.equal(fs.existsSync(marker), false); assert.equal(fs.existsSync(nodeMarker), true); fs.unlinkSync(nodeMarker);
        assert.equal(run('candidate', script, [...args, '--skip-U5']), 64); assert.equal(fs.existsSync(marker), false); assert.equal(fs.existsSync(nodeMarker), false);
    }
    // The wholly fabricated fixture stays under its exclusive temporary parent for evidence.
});
