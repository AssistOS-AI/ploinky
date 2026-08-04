import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const fleetModuleUrl = pathToFileURL(path.resolve('cli/sandbox/bwrap/bwrapFleet.js')).href;

test('schema-v3 sandbox ownership is exact across service and provider-task processes', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-sandbox-owner-'));
    const script = `
        import assert from 'node:assert/strict';
        import fs from 'node:fs';
        import { spawn } from 'node:child_process';
        const fleet = await import(${JSON.stringify(fleetModuleUrl)});

        const ownedPids = new Set();
        function spawnOwnedProcess({ ignoreTerm = false } = {}) {
            const source = ignoreTerm
                ? "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"
                : "setInterval(() => {}, 1000);";
            const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
                detached: true,
                stdio: 'ignore',
            });
            assert.ok(child.pid > 0);
            child.unref();
            ownedPids.add(child.pid);
            return child.pid;
        }

        function signalForCleanup(pid) {
            try { process.kill(-pid, 'SIGKILL'); } catch (_) {}
            try { process.kill(pid, 'SIGKILL'); } catch (_) {}
        }

        function processExists(pid) {
            try {
                process.kill(pid, 0);
                return true;
            } catch (error) {
                return error?.code === 'EPERM';
            }
        }

        const runtimeA = 'ploinky_repo_agent_alias_a_workspace_deadbeef';
        const runtimeB = 'ploinky_repo_agent_alias_b_workspace_deadbeef';
        const serviceIdentityA = { instanceId: 'instance-a', enableGeneration: 'generation-a' };
        const serviceIdentityB = { instanceId: 'instance-b', enableGeneration: 'generation-b' };
        const taskIdentity = { instanceId: 'instance-a', enableGeneration: 'generation-a' };
        const servicePidA = spawnOwnedProcess();
        const taskPidA = spawnOwnedProcess();
        const taskPidB = spawnOwnedProcess({ ignoreTerm: true });
        const servicePidB = spawnOwnedProcess();
        const taskPidC = spawnOwnedProcess();

        try {
            await new Promise((resolve) => setTimeout(resolve, 100));

            const serviceA = fleet.saveServiceOwner({
                runtimeKey: runtimeA,
                pid: servicePidA,
                ...serviceIdentityA,
                homeKey: runtimeA,
                workdir: '/workspace/projects/current',
                logPath: '/workspace/.ploinky/logs/service-a.log',
            });
            const taskA = fleet.saveProviderTaskOwner({
                runtimeKey: runtimeA,
                pid: taskPidA,
                ...taskIdentity,
                homeKey: runtimeA,
                workdir: '/workspace/projects/current',
                logPath: '/workspace/.ploinky/logs/tasks/task-a-provider.log',
                taskId: 'task-a',
                provider: 'codex',
            });
            const taskB = fleet.saveProviderTaskOwner({
                runtimeKey: runtimeA,
                pid: taskPidB,
                ...taskIdentity,
                homeKey: runtimeA,
                workdir: '/workspace/projects/current',
                logPath: '/workspace/.ploinky/logs/tasks/task-b-provider.log',
                taskId: 'task-b',
                provider: 'opencode',
            });

            assert.equal(fleet.SANDBOX_OWNER_SCHEMA_VERSION, 3);
            assert.equal(fleet.BWRAP_PID_SCHEMA_VERSION, 3);
            assert.equal(serviceA.role, 'service');
            assert.equal(serviceA.taskId, '');
            assert.equal(serviceA.provider, '');
            assert.equal(taskA.role, 'provider-task');
            assert.equal(taskA.taskId, 'task-a');
            assert.equal(taskA.provider, 'codex');
            assert.notEqual(serviceA.ownerKey, taskA.ownerKey);
            assert.notEqual(taskA.ownerKey, taskB.ownerKey);
            assert.equal(serviceA.ownerKey, fleet.serviceOwnerKey(runtimeA));
            assert.equal(taskA.ownerKey, fleet.providerTaskOwnerKey(runtimeA, 'task-a'));

            const exactRecordKeys = [
                'enableGeneration',
                'homeKey',
                'instanceId',
                'logPath',
                'ownerKey',
                'pid',
                'processIdentity',
                'provider',
                'role',
                'runtimeKey',
                'schemaVersion',
                'taskId',
                'workdir',
            ];
            assert.deepEqual(Object.keys(serviceA).sort(), exactRecordKeys);
            const serviceFileA = fleet.BWRAP_PIDS_DIR + '/' + serviceA.ownerKey + '.owner.json';
            assert.equal(fs.statSync(serviceFileA).mode & 0o777, 0o600);
            assert.equal(fs.statSync(serviceFileA).uid, process.getuid());
            assert.equal(fs.statSync(fleet.BWRAP_PIDS_DIR).mode & 0o777, 0o700);
            assert.equal(fs.statSync(fleet.BWRAP_PIDS_DIR).uid, process.getuid());
            assert.equal(fs.readFileSync(serviceFileA, 'utf8'), JSON.stringify(serviceA) + '\\n');

            assert.deepEqual(fleet.listServiceOwners({ runtimeKey: runtimeA }).map((entry) => entry.ownerKey), [
                serviceA.ownerKey,
            ]);
            assert.deepEqual(
                fleet.listProviderTaskOwners({ runtimeKey: runtimeA }).map((entry) => entry.ownerKey).sort(),
                [taskA.ownerKey, taskB.ownerKey].sort(),
            );
            assert.equal(fleet.readServiceOwner(runtimeA).ownerKey, serviceA.ownerKey);
            assert.equal(fleet.readProviderTaskOwner(runtimeA, 'task-a').ownerKey, taskA.ownerKey);
            assert.equal(fleet.getBwrapPid(runtimeA, serviceIdentityA), servicePidA);
            assert.throws(
                () => fleet.isSandboxOwnerRunning(taskA.ownerKey),
                /requires instanceId and enableGeneration/,
            );
            assert.throws(
                () => fleet.stopSandboxOwner(taskA.ownerKey),
                /requires instanceId and enableGeneration/,
            );
            assert.throws(
                () => fleet.saveServiceOwner({
                    runtimeKey: runtimeA,
                    pid: servicePidB,
                    ...serviceIdentityB,
                    homeKey: runtimeA,
                    workdir: '/workspace/projects/replacement',
                    logPath: '/workspace/.ploinky/logs/replacement.log',
                }),
                (error) => error?.code === 'PLOINKY_SANDBOX_OWNER_SLOT_BUSY',
            );
            assert.equal(fleet.readServiceOwner(runtimeA).pid, servicePidA);

            const staleTaskIdentity = {
                ...taskIdentity,
                enableGeneration: 'generation-replaced',
            };
            assert.equal(fleet.isSandboxOwnerRunning(taskA.ownerKey, staleTaskIdentity), false);
            assert.equal(fleet.stopSandboxOwner(taskA.ownerKey, {
                expected: staleTaskIdentity,
                timeout: 25,
                killTimeout: 25,
            }), false);
            assert.equal(fleet.isSandboxOwnerRunning(taskA.ownerKey, taskIdentity), true);
            assert.equal(processExists(taskPidA), true);

            const originalReadFile = fs.readFileSync;
            const originalPath = process.env.PATH;
            fs.readFileSync = (file, ...args) => {
                if (String(file) === '/proc/' + taskPidA + '/stat') {
                    const error = new Error('simulated unreadable proc identity');
                    error.code = 'EACCES';
                    throw error;
                }
                return originalReadFile(file, ...args);
            };
            process.env.PATH = '/definitely-no-process-tools';
            try {
                assert.throws(
                    () => fleet.isSandboxOwnerRunning(taskA.ownerKey, taskIdentity),
                    (error) => error?.code === 'PLOINKY_SANDBOX_OWNER_IDENTITY_UNVERIFIED',
                );
                assert.equal(fs.existsSync(
                    fleet.BWRAP_PIDS_DIR + '/' + taskA.ownerKey + '.owner.json',
                ), true);
                assert.equal(processExists(taskPidA), true);
            } finally {
                fs.readFileSync = originalReadFile;
                process.env.PATH = originalPath;
            }

            const originalLstat = fs.lstatSync;
            fs.lstatSync = (...args) => new Proxy(originalLstat(...args), {
                get(target, property, receiver) {
                    if (property === 'uid') return process.getuid() + 1;
                    return Reflect.get(target, property, receiver);
                },
            });
            try {
                assert.throws(
                    () => fleet.readServiceOwner(runtimeA),
                    (error) => error?.code === 'PLOINKY_SANDBOX_OWNER_STORE_INVALID',
                );
            } finally {
                fs.lstatSync = originalLstat;
            }

            const originalGetuid = process.getuid;
            process.getuid = undefined;
            try {
                assert.throws(
                    () => fleet.listSandboxOwners(),
                    (error) => error?.code === 'PLOINKY_SANDBOX_OWNER_STORE_INVALID',
                );
            } finally {
                process.getuid = originalGetuid;
            }

            const originalFstat = fs.fstatSync;
            fs.fstatSync = (...args) => new Proxy(originalFstat(...args), {
                get(target, property, receiver) {
                    if (property === 'uid') return process.getuid() + 1;
                    return Reflect.get(target, property, receiver);
                },
            });
            try {
                assert.throws(
                    () => fleet.readSandboxOwner(serviceA.ownerKey),
                    (error) => error?.code === 'PLOINKY_SANDBOX_OWNER_RECORD_INVALID',
                );
            } finally {
                fs.fstatSync = originalFstat;
            }

            const reusedService = JSON.parse(fs.readFileSync(serviceFileA, 'utf8'));
            reusedService.processIdentity += '-pid-reused';
            fs.writeFileSync(serviceFileA, JSON.stringify(reusedService) + '\\n', { mode: 0o600 });
            const originalRename = fs.renameSync;
            fs.renameSync = (source, destination) => {
                originalRename(source, destination);
                throw new Error('simulated owner-store crash after atomic rename');
            };
            try {
                assert.throws(
                    () => fleet.getBwrapPid(runtimeA, serviceIdentityA),
                    /simulated owner-store crash/,
                );
            } finally {
                fs.renameSync = originalRename;
            }
            assert.equal(fs.existsSync(serviceFileA), false);
            assert.equal(
                fs.readdirSync(fleet.BWRAP_PIDS_DIR).filter((name) => name.includes('.operation-')).length,
                2,
            );
            assert.equal(fleet.getBwrapPid(runtimeA, serviceIdentityA), 0);
            assert.equal(
                fs.readdirSync(fleet.BWRAP_PIDS_DIR).some((name) => name.includes('.operation-')),
                false,
            );
            assert.equal(fs.existsSync(serviceFileA), false);
            assert.equal(processExists(servicePidA), true);
            signalForCleanup(servicePidA);

            const taskFileA = fleet.BWRAP_PIDS_DIR + '/' + taskA.ownerKey + '.owner.json';
            const canonicalTaskBytes = fs.readFileSync(taskFileA, 'utf8');
            fs.writeFileSync(taskFileA, JSON.stringify(JSON.parse(canonicalTaskBytes), null, 2) + '\\n', {
                mode: 0o600,
            });
            assert.throws(
                () => fleet.readSandboxOwner(taskA.ownerKey),
                (error) => error?.code === 'PLOINKY_SANDBOX_OWNER_RECORD_INVALID',
            );
            assert.equal(fs.existsSync(taskFileA), true);
            fs.writeFileSync(taskFileA, canonicalTaskBytes, { mode: 0o600 });
            const reusedTask = JSON.parse(canonicalTaskBytes);
            reusedTask.processIdentity += '-pid-reused';
            fs.writeFileSync(taskFileA, JSON.stringify(reusedTask) + '\\n', { mode: 0o600 });
            assert.equal(fleet.stopSandboxOwner(taskA.ownerKey, {
                expected: taskA,
                timeout: 25,
                killTimeout: 25,
            }), true);
            assert.equal(fs.existsSync(taskFileA), false);
            assert.equal(processExists(taskPidA), true);
            signalForCleanup(taskPidA);

            const v2Runtime = 'ploinky_repo_agent_v2_workspace_deadbeef';
            const v2File = fleet.BWRAP_PIDS_DIR + '/' + fleet.serviceOwnerKey(v2Runtime) + '.owner.json';
            fs.writeFileSync(v2File, JSON.stringify({
                schemaVersion: 2,
                runtimeKey: v2Runtime,
                pid: process.pid,
            }) + '\\n', { mode: 0o600 });
            assert.throws(
                () => fleet.readServiceOwner(v2Runtime),
                (error) => error?.code === 'PLOINKY_SANDBOX_OWNER_RECORD_INVALID',
            );
            assert.equal(fs.existsSync(v2File), true);
            fs.unlinkSync(v2File);

            const legacyRuntime = 'ploinky_repo_agent_legacy_workspace_deadbeef';
            const legacyFile = fleet.BWRAP_PIDS_DIR + '/' + legacyRuntime + '.pid';
            fs.writeFileSync(legacyFile, String(process.pid) + '\\n', { mode: 0o600 });
            assert.throws(
                () => fleet.readServiceOwner(legacyRuntime),
                (error) => error?.code === 'PLOINKY_SANDBOX_OWNER_RECORD_INVALID',
            );
            assert.equal(fs.existsSync(legacyFile), true);
            fs.unlinkSync(legacyFile);

            assert.throws(
                () => fleet.saveProviderTaskOwner({
                    runtimeKey: runtimeA,
                    pid: process.pid,
                    ...taskIdentity,
                    homeKey: runtimeA,
                    workdir: '/workspace',
                    logPath: '/workspace/task.log',
                    taskId: 'missing-provider',
                }),
                /provider/,
            );
            assert.throws(
                () => fleet.saveServiceOwner({
                    runtimeKey: runtimeA,
                    pid: process.pid,
                    ...taskIdentity,
                    homeKey: runtimeA,
                    workdir: '/workspace/../escape',
                    logPath: '/workspace/service.log',
                }),
                /normalized absolute path/,
            );
            assert.throws(
                () => fleet.saveServiceOwner({
                    runtimeKey: runtimeA,
                    pid: process.pid,
                    ...taskIdentity,
                    homeKey: runtimeA,
                    workdir: '/workspace',
                    logPath: '/' + 'x'.repeat(4097),
                }),
                /logPath is invalid/,
            );
            assert.throws(
                () => fleet.saveServiceOwner({
                    runtimeKey: ' ' + runtimeA,
                    pid: process.pid,
                    ...taskIdentity,
                    homeKey: runtimeA,
                    workdir: '/workspace',
                    logPath: '/workspace/service.log',
                }),
                /exact safe container name/,
            );
            assert.throws(
                () => fleet.saveServiceOwner({
                    runtimeKey: runtimeA,
                    pid: process.pid,
                    ...taskIdentity,
                    homeKey: '..',
                    workdir: '/workspace',
                    logPath: '/workspace/service.log',
                }),
                /homeKey is invalid/,
            );

            assert.equal(fleet.stopSandboxOwner(taskB.ownerKey, {
                expected: taskB,
                timeout: 25,
                killTimeout: 1000,
            }), true);
            assert.equal(fleet.readProviderTaskOwner(runtimeA, 'task-b'), null);

            const serviceB = fleet.saveServiceOwner({
                runtimeKey: runtimeB,
                pid: servicePidB,
                ...serviceIdentityB,
                homeKey: runtimeB,
                workdir: '/workspace/projects/other',
                logPath: '/workspace/.ploinky/logs/service-b.log',
            });
            const taskC = fleet.saveProviderTaskOwner({
                runtimeKey: runtimeB,
                pid: taskPidC,
                ...serviceIdentityB,
                homeKey: runtimeB,
                workdir: '/workspace/projects/other',
                logPath: '/workspace/.ploinky/logs/tasks/task-c-provider.log',
                taskId: 'task-c',
                provider: 'pi',
            });
            assert.deepEqual(fleet.stopAllBwrapProcesses({ timeout: 500, killTimeout: 500 }), [runtimeB]);
            assert.equal(fleet.readServiceOwner(runtimeB), null);
            assert.equal(fleet.isSandboxOwnerRunning(taskC.ownerKey, serviceIdentityB), true);
            assert.deepEqual(
                fleet.stopAllSandboxOwners({ timeout: 500, killTimeout: 500 }),
                [taskC.ownerKey],
            );
            assert.equal(fleet.listSandboxOwners().length, 0);
            assert.equal(serviceB.runtimeKey, runtimeB);

            await new Promise((resolve) => setTimeout(resolve, 100));
            console.log(JSON.stringify({
                schemaVersion: fleet.SANDBOX_OWNER_SCHEMA_VERSION,
                serviceOwnerKey: serviceA.ownerKey,
                taskOwnerKeys: [taskA.ownerKey, taskB.ownerKey, taskC.ownerKey],
            }));
        } finally {
            for (const pid of ownedPids) signalForCleanup(pid);
        }
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
            timeout: 20_000,
        });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        const evidence = JSON.parse(result.stdout.trim());
        assert.equal(evidence.schemaVersion, 3);
        assert.match(evidence.serviceOwnerKey, /^service-[a-f0-9]{64}$/);
        assert.equal(new Set(evidence.taskOwnerKeys).size, 3);
        for (const ownerKey of evidence.taskOwnerKeys) {
            assert.match(ownerKey, /^provider-task-[a-f0-9]{64}$/);
        }
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});
