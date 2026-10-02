import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const fleetModuleUrl = pathToFileURL(path.resolve('cli/sandbox/bwrap/bwrapFleet.js')).href;

test('sandbox PID ownership is isolated by exact runtime key and rejects stale identities', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-sandbox-owner-'));
    const script = `
        import assert from 'node:assert/strict';
        import fs from 'node:fs';
        const fleet = await import(${JSON.stringify(fleetModuleUrl)});

        const aliasA = 'ploinky_repo_agent_alias_a_workspace_deadbeef';
        const aliasB = 'ploinky_repo_agent_alias_b_workspace_deadbeef';
        const identityA = { instanceId: 'instance-a', enableGeneration: 'generation-a' };
        const identityB = { instanceId: 'instance-b', enableGeneration: 'generation-b' };
        fleet.saveBwrapPid(aliasA, process.pid, identityA);
        fleet.saveBwrapPid(aliasB, process.pid, identityB);

        assert.equal(fleet.getBwrapPid(aliasA, identityA), process.pid);
        assert.equal(fleet.getBwrapPid(aliasB, identityB), process.pid);
        assert.equal(fleet.isBwrapProcessRunning(aliasA, identityA), true);
        assert.equal(fleet.isBwrapProcessRunning(aliasB, identityB), true);

        const aliasAFile = fleet.BWRAP_PIDS_DIR + '/' + aliasA + '.pid';
        const aliasBFile = fleet.BWRAP_PIDS_DIR + '/' + aliasB + '.pid';
        assert.notEqual(aliasAFile, aliasBFile);
        assert.equal(fs.statSync(aliasAFile).mode & 0o777, 0o600);
        assert.equal(fs.statSync(aliasBFile).mode & 0o777, 0o600);
        const aliasARecord = JSON.parse(fs.readFileSync(aliasAFile, 'utf8'));
        assert.equal(aliasARecord.schemaVersion, 2);
        assert.equal(aliasARecord.instanceId, identityA.instanceId);
        assert.equal(aliasARecord.enableGeneration, identityA.enableGeneration);

        const staleGeneration = { ...identityA, enableGeneration: 'generation-a-replaced' };
        assert.equal(fleet.getBwrapPid(aliasA, staleGeneration), 0);
        assert.equal(fleet.isBwrapProcessRunning(aliasA, staleGeneration), false);
        assert.equal(fs.existsSync(aliasAFile), true);
        assert.equal(fleet.isBwrapProcessRunning(aliasA, identityA), true);
        fleet.saveBwrapPid(aliasA, process.pid, identityA);
        assert.throws(
            () => fleet.saveBwrapPid(aliasA, process.pid, staleGeneration),
            (error) => error?.code === 'PLOINKY_SANDBOX_PID_SLOT_BUSY',
        );
        assert.equal(fleet.isBwrapProcessRunning(aliasA, identityA), true);

        fleet.clearBwrapPid(aliasA);
        assert.equal(fs.existsSync(aliasAFile), false);
        assert.equal(fleet.isBwrapProcessRunning(aliasB, identityB), true);
        assert.equal(fleet.stopBwrapProcess(aliasB, {
            expectedIdentity: { ...identityB, enableGeneration: 'generation-b-stale' },
        }), false);
        assert.equal(fleet.isBwrapProcessRunning(aliasB, identityB), true);

        const staleKey = 'ploinky_repo_agent_stale_workspace_deadbeef';
        fleet.saveBwrapPid(staleKey, process.pid, identityA);
        const staleFile = fleet.BWRAP_PIDS_DIR + '/' + staleKey + '.pid';
        const stale = JSON.parse(fs.readFileSync(staleFile, 'utf8'));
        stale.processIdentity = stale.processIdentity + '-reused';
        fs.writeFileSync(staleFile, JSON.stringify(stale), { mode: 0o600 });
        assert.equal(fleet.isBwrapProcessRunning(staleKey, identityA), false);
        assert.equal(fs.existsSync(staleFile), false);

        const legacyKey = 'ploinky_repo_agent_legacy_workspace_deadbeef';
        const legacyFile = fleet.BWRAP_PIDS_DIR + '/' + legacyKey + '.pid';
        fs.writeFileSync(legacyFile, String(process.pid), { mode: 0o600 });
        assert.equal(fleet.getBwrapPid(legacyKey), 0);
        assert.equal(fs.existsSync(legacyFile), true);
        assert.throws(
            () => fleet.assertBwrapPidSlotAvailable(legacyKey),
            (error) => error?.code === 'PLOINKY_SANDBOX_PID_RECORD_INVALID',
        );

        assert.throws(
            () => fleet.saveBwrapPid('../wrong-owner', process.pid, identityA),
            /exact safe container name/,
        );
        assert.throws(
            () => fleet.saveBwrapPid('ploinky_missing_identity', process.pid),
            /exact instanceId and enableGeneration/,
        );
        assert.throws(
            () => fleet.saveBwrapPid('ploinky_partial_identity', process.pid, { instanceId: 'only-one' }),
            /exact instanceId and enableGeneration/,
        );

        fleet.clearBwrapPid(aliasB);
        fs.unlinkSync(legacyFile);
        console.log(JSON.stringify({ aliasA, aliasB, schemaVersion: fleet.BWRAP_PID_SCHEMA_VERSION }));
    `;

    try {
        const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
            cwd: workspace,
            env: {
                ...process.env,
                PLOINKY_WORKSPACE_ROOT: workspace,
                PLOINKY_CWD: workspace,
            },
            encoding: 'utf8',
        });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        const evidence = JSON.parse(result.stdout.trim());
        assert.notEqual(evidence.aliasA, evidence.aliasB);
        assert.equal(evidence.schemaVersion, 2);
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});

test('sandbox lifecycle call sites use the exact container runtime key', () => {
    const bwrapManager = fs.readFileSync('cli/sandbox/bwrap/bwrapServiceManager.js', 'utf8');
    const seatbeltManager = fs.readFileSync('cli/sandbox/seatbelt/seatbeltServiceManager.js', 'utf8');
    const serviceManager = fs.readFileSync('cli/sandbox/docker/agentServiceManager.js', 'utf8');
    const containerFleet = fs.readFileSync('cli/sandbox/docker/containerFleet.js', 'utf8');

    for (const source of [bwrapManager, seatbeltManager]) {
        assert.match(source, /saveBwrapPid\(containerName, child\.pid, runtimeIdentity\)/);
        assert.match(source, /assertBwrapPidSlotAvailable\(containerName\)/);
        assert.match(source, /isBwrapProcessRunning\(containerName, runtimeIdentity\)/);
        assert.match(source, /getBwrapPid\(containerName, runtimeIdentity\)/);
        assert.doesNotMatch(source, /(?:saveBwrapPid|isBwrapProcessRunning|stopBwrapProcess)\(agentName/);
        // What the replacement stops do is asserted by running them (the slot
        // and stop tests below, and nativeGraphPredecessor.test.mjs). This only
        // guards that the unqualified, runtime-key-only stop is gone and that
        // every launch resolves its slot first.
        assert.doesNotMatch(source, /stopBwrapProcess\(containerName\)/);
        assert.match(source, /resolveSandboxSlotForStart\(containerName, \{/);
    }
    // The dispatcher and the operator stops observe the exact runtime key.
    assert.match(serviceManager, /observeSandboxRuntime\(containerName\)/);
    assert.match(containerFleet, /observeSandboxRuntime\(name\)/);
    assert.match(containerFleet, /stopSandboxRuntimes\(bwrapEntries\.map\(\(entry\) => entry\.runtimeKey\)/);
});

// Runs `script` against the fleet module in a child process bound to its own
// workspace. `child()` spawns a short-lived process this script owns; every
// one is killed on the way out.
function runFleet(script) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-sandbox-slot-'));
    try {
        const source = [
            "import assert from 'node:assert/strict';",
            "import fs from 'node:fs';",
            "import cp from 'node:child_process';",
            "import { syncBuiltinESMExports } from 'node:module';",
            `const fleet = await import(${JSON.stringify(fleetModuleUrl)});`,
            'const children = [];',
            'const realKill = process.kill.bind(process);',
            'const child = () => {',
            "  const c = cp.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { detached: true, stdio: 'ignore' });",
            '  c.unref(); children.push(c.pid); return c.pid;',
            '};',
            'try {',
            script,
            '} finally {',
            "  for (const pid of children) { try { realKill(-pid, 'SIGKILL'); } catch (_) {} try { realKill(pid, 'SIGKILL'); } catch (_) {} }",
            '}',
            "console.log('DONE');",
        ].join('\n');
        const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
            cwd: workspace,
            env: { ...process.env, PLOINKY_WORKSPACE_ROOT: workspace, PLOINKY_CWD: workspace },
            encoding: 'utf8',
        });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.match(result.stdout, /DONE/);
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
}

test('the slot of a runtime key resolves to empty, successor or named predecessor, and refuses everything else before any signal', () => {
    runFleet(`
        const key = 'ploinky_repo_agent_slot_workspace_deadbeef';
        const predecessor = { instanceId: 'pred-i', enableGeneration: 'pred-g' };
        const successor = { instanceId: 'succ-i', enableGeneration: 'succ-g' };
        const slot = (expected, wanted = successor) => fleet.resolveSandboxSlotForStart(key, { successor: wanted, expectedPredecessor: expected });
        const file = () => fleet.BWRAP_PIDS_DIR + '/' + key + '.pid';

        assert.equal(slot(null).kind, 'empty', 'no record at all');
        const pid = child();
        fleet.saveBwrapPid(key, pid, predecessor);
        assert.equal(slot(predecessor).kind, 'predecessor');
        assert.equal(slot(predecessor, predecessor).kind, 'successor', 'the exact requested tuple is reuse, not replacement');
        for (const expected of [null, undefined, { instanceId: 'other-i', enableGeneration: 'other-g' }]) {
            assert.throws(() => slot(expected), (error) => error.code === 'PLOINKY_SANDBOX_PID_SLOT_BUSY', 'an unexpected occupant is refused');
        }
        assert.equal(fleet.isBwrapProcessRunning(key, predecessor), true, 'the refusals never signalled it');
        assert.throws(() => slot({ instanceId: 'x' }), /exact instanceId and enableGeneration/);

        // An unverifiable slot throws without a signal and without touching the record.
        const before = fs.readFileSync(file(), 'utf8');
        fs.writeFileSync(file(), '{"pid": 1}');
        assert.throws(() => slot(predecessor), (error) => error.code === 'PLOINKY_SANDBOX_PID_RECORD_INVALID');
        assert.equal(fs.readFileSync(file(), 'utf8'), '{"pid": 1}');
        fs.writeFileSync(file(), before);
        realKill(pid, 0);
    `);
});

test('a manager stop is complete only once the exact process is observed gone', () => {
    runFleet(`
        const key = 'ploinky_repo_agent_stop_workspace_deadbeef';
        const identity = { instanceId: 'i', enableGeneration: 'g' };
        const pid = child();
        fleet.saveBwrapPid(key, pid, identity);

        // A different tuple is refused and nothing is signalled.
        assert.throws(
            () => fleet.stopExactSandboxOrThrow(key, { instanceId: 'x', enableGeneration: 'y' }, { timeout: 100 }),
            (error) => error.code === 'PLOINKY_RUNTIME_OWNERSHIP_AMBIGUOUS' && error.stopResult.state === 'refused',
        );
        assert.equal(fleet.isBwrapProcessRunning(key, identity), true);

        // Denied signals are a failure that keeps the record.
        process.kill = (target, signal) => {
            if (signal === 0) return realKill(target, 0);
            throw Object.assign(new Error('denied'), { code: 'EPERM' });
        };
        try {
            assert.throws(
                () => fleet.stopExactSandboxOrThrow(key, identity, { timeout: 100 }),
                (error) => error.code === 'PLOINKY_RUNTIME_OWNERSHIP_AMBIGUOUS' && error.stopResult.state === 'failed',
            );
        } finally {
            process.kill = realKill;
        }
        assert.equal(fleet.getBwrapPid(key, identity), pid, 'the record survived the failed stop');
        assert.equal(fleet.stopBwrapProcess(key, { expectedIdentity: identity, timeout: 100 }), true);
        assert.equal(fleet.getBwrapPid(key, identity), 0, 'the record went only after the exit was observed');
        assert.equal(fleet.stopExactSandboxOrThrow(key, identity).state, 'absent', 'an absent runtime is a completed stop');
        assert.equal(fleet.stopBwrapProcess(key, { expectedIdentity: identity }), false, 'nothing left to stop');
    `);
});

test('a PID slot that cannot be verified is never cleared or replaced, while a stale one is available again', () => {
    runFleet(`
        const key = 'ploinky_repo_agent_unverified_workspace_deadbeef';
        const identity = { instanceId: 'i', enableGeneration: 'g' };
        const pid = child();
        fleet.saveBwrapPid(key, pid, identity);
        const file = fleet.BWRAP_PIDS_DIR + '/' + key + '.pid';
        const before = fs.readFileSync(file, 'utf8');

        // Identity probing breaks after the record was written.
        const realExec = cp.execFileSync;
        const realRead = fs.readFileSync;
        cp.execFileSync = (command, ...rest) => { if (command === 'ps') throw new Error('ps unavailable'); return realExec(command, ...rest); };
        fs.readFileSync = (target, ...rest) => {
            if (typeof target === 'string' && target.startsWith('/proc/') && target.endsWith('/stat')) {
                throw Object.assign(new Error('denied'), { code: 'EACCES' });
            }
            return realRead(target, ...rest);
        };
        syncBuiltinESMExports();
        try {
            assert.throws(() => fleet.assertBwrapPidSlotAvailable(key), (error) => error.code === 'PLOINKY_RUNTIME_OWNERSHIP_AMBIGUOUS');
            assert.equal(fleet.isBwrapProcessRunning(key, identity), false);
            assert.equal(fleet.stopBwrapProcesses([key], { timeout: 100 }).length, 0);
        } finally {
            cp.execFileSync = realExec;
            fs.readFileSync = realRead;
            syncBuiltinESMExports();
        }
        assert.equal(fs.readFileSync(file, 'utf8'), before, 'the record is byte-identical');
        realKill(pid, 0);

        // The process is now really gone (killed, and an unreaped zombie): the record is stale.
        realKill(-pid, 'SIGKILL');
        const deadline = Date.now() + 3000;
        for (;;) {
            const state = cp.spawnSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).stdout.trim();
            if (!state || state.startsWith('Z') || Date.now() > deadline) break;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        }
        fleet.assertBwrapPidSlotAvailable(key);
        assert.equal(fs.existsSync(file), false, 'the stale record was removed by compare-and-delete');
    `);
});
