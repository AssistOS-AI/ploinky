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
        assert.match(source, /stopBwrapProcess\(containerName\)/);
        assert.doesNotMatch(source, /(?:saveBwrapPid|isBwrapProcessRunning|stopBwrapProcess)\(agentName/);
    }
    assert.match(serviceManager, /isBwrapProcessRunning\(containerName\)/);
    assert.match(containerFleet, /isBwrapProcessRunning\(name\)/);
    assert.match(containerFleet, /stopBwrapProcesses\(bwrapEntries\.map\(\(entry\) => entry\.runtimeKey\)/);
});
