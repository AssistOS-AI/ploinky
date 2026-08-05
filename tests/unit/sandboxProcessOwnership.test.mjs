import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import {
    inspectProcessIdentity,
    normalizeProcessIdentity,
} from '../../cli/sandbox/processIdentity.js';

const fleetModuleUrl = pathToFileURL(path.resolve('cli/sandbox/bwrap/bwrapFleet.js')).href;
const TEST_BOOT_ID = '123e4567-e89b-12d3-a456-426614174000';

function linuxStat(startTicks, state = 'S') {
    return `42 (identity fixture) ${[state, ...Array(18).fill('0'), startTicks].join(' ')}\n`;
}

function linuxStatus(uid = 501) {
    return `Name:\tidentity\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`;
}

function sequenceReader(entries) {
    const queues = new Map(Object.entries(entries).map(([name, values]) => [
        name,
        Array.isArray(values) ? [...values] : [values, values],
    ]));
    return (name) => {
        const queue = queues.get(String(name));
        assert.ok(queue?.length, `unexpected or exhausted identity read: ${name}`);
        return queue.shift();
    };
}

test('process identity inspector is boot-bound, stable, canonical, and platform injected', () => {
    let linuxExecCalls = 0;
    const linux = inspectProcessIdentity(42, {
        platform: 'linux',
        readFileSyncImpl: sequenceReader({
            '/proc/sys/kernel/random/boot_id': [`${TEST_BOOT_ID}\n`, `${TEST_BOOT_ID}\n`],
            '/proc/42/stat': [linuxStat('987654'), linuxStat('987654')],
            '/proc/42/status': [linuxStatus(), linuxStatus()],
        }),
        execFileSyncImpl: () => {
            linuxExecCalls += 1;
            throw new Error('Linux inspection must not use ps');
        },
    });
    assert.deepEqual(linux, {
        state: 'identified',
        processIdentity: `linux-proc:${TEST_BOOT_ID}:987654`,
        processUid: 501,
    });
    assert.equal(linuxExecCalls, 0);
    assert.equal(normalizeProcessIdentity(linux.processIdentity), linux.processIdentity);

    for (const entries of [
        {
            '/proc/sys/kernel/random/boot_id': [`${TEST_BOOT_ID}\n`, '223e4567-e89b-12d3-a456-426614174000\n'],
            '/proc/42/stat': [linuxStat('987654'), linuxStat('987654')],
            '/proc/42/status': [linuxStatus(), linuxStatus()],
        },
        {
            '/proc/sys/kernel/random/boot_id': [`${TEST_BOOT_ID}\n`, `${TEST_BOOT_ID}\n`],
            '/proc/42/stat': [linuxStat('987654'), linuxStat('987655')],
            '/proc/42/status': [linuxStatus(), linuxStatus()],
        },
        {
            '/proc/sys/kernel/random/boot_id': [`${TEST_BOOT_ID}\n`, `${TEST_BOOT_ID}\n`],
            '/proc/42/stat': [linuxStat('987654'), linuxStat('987654')],
            '/proc/42/status': [linuxStatus(501), linuxStatus(502)],
        },
    ]) {
        assert.deepEqual(inspectProcessIdentity(42, {
            platform: 'linux',
            readFileSyncImpl: sequenceReader(entries),
        }), { state: 'unknown' });
    }

    const darwinCalls = [];
    let darwinProbeCalls = 0;
    const darwin = inspectProcessIdentity(42, {
        platform: 'darwin',
        probeProcessImpl(pid, signal) {
            darwinProbeCalls += 1;
            assert.equal(pid, 42);
            assert.equal(signal, 0);
        },
        execFileSyncImpl(command, args) {
            darwinCalls.push([command, args]);
            if (command === 'sysctl') {
                assert.deepEqual(args, ['-n', 'kern.boottime']);
                return '{ sec = 1785220336, usec = 610367 } Tue Jul 28 09:32:16 2026\n';
            }
            assert.equal(command, 'ps');
            assert.deepEqual(args, ['-p', '42', '-o', 'uid=', '-o', 'state=', '-o', 'lstart=']);
            return '  501 Ss   Tue Aug  4 22:21:24 2026    \n';
        },
    });
    assert.deepEqual(darwin, {
        state: 'identified',
        processIdentity: 'darwin-ps:1785220336:610367:Tue Aug 4 22:21:24 2026',
        processUid: 501,
    });
    assert.equal(darwinCalls.length, 4);
    assert.equal(darwinProbeCalls, 2);
    assert.equal(normalizeProcessIdentity(darwin.processIdentity), darwin.processIdentity);

    const deadError = Object.assign(new Error('no such process'), { code: 'ESRCH' });
    assert.deepEqual(inspectProcessIdentity(42, {
        platform: 'darwin',
        probeProcessImpl() { throw deadError; },
        execFileSyncImpl() { throw new Error('dead process must not reach ps or sysctl'); },
    }), { state: 'dead' });

    let exitingProbeCalls = 0;
    assert.deepEqual(inspectProcessIdentity(42, {
        platform: 'darwin',
        probeProcessImpl() {
            exitingProbeCalls += 1;
            if (exitingProbeCalls > 1) throw deadError;
        },
        execFileSyncImpl(command) {
            if (command === 'sysctl') {
                return '{ sec = 1785220336, usec = 610367 } Tue Jul 28 09:32:16 2026\n';
            }
            throw Object.assign(new Error('process exited during ps'), { status: 1 });
        },
    }), { state: 'dead' });

    for (const malformed of [
        'linux-proc:987654',
        `linux-proc:${TEST_BOOT_ID.toUpperCase()}:987654`,
        `linux-proc:${TEST_BOOT_ID}:0987654`,
        'ps-lstart:Tue Aug 4 22:21:24 2026',
        'darwin-ps:1785220336:1000000:Tue Aug 4 22:21:24 2026',
    ]) {
        assert.throws(() => normalizeProcessIdentity(malformed), TypeError);
    }
});

test('schema-v5 boot-bound sandbox ownership is exact across service and provider-task processes', () => {
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

        function differentCanonicalProcessIdentity(identity) {
            const fields = identity.split(':');
            if (fields[0] === 'linux-proc') {
                fields[fields.length - 1] = String(BigInt(fields[fields.length - 1]) + 1n);
                return fields.join(':');
            }
            if (fields[0] === 'darwin-ps') {
                fields[1] = String(BigInt(fields[1]) + 1n);
                return fields.join(':');
            }
            throw new Error('unexpected process identity platform');
        }

        function serviceAttestation(routeKey, rootPort, digestSeed) {
            const digest = (offset) => 'sha256:' + String.fromCharCode(
                digestSeed.charCodeAt(0) + offset,
            ).repeat(64);
            return {
                routeKey,
                rootPort,
                credentialNonceDigest: digest(0),
                credentialExpiresAt: Math.floor(Date.now() / 1000) + 300,
                manifestDigest: digest(1),
                admissionDigest: digest(2),
                networkHash: digest(3),
            };
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
                ...serviceAttestation('alias-a', 8080, 'a'),
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
                routeKey: 'must-be-discarded',
                rootPort: 65535,
                credentialNonceDigest: 'must-be-discarded',
                credentialExpiresAt: Math.floor(Date.now() / 1000) + 300,
                manifestDigest: 'must-be-discarded',
                admissionDigest: 'must-be-discarded',
                networkHash: 'must-be-discarded',
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

            assert.equal(fleet.SANDBOX_OWNER_SCHEMA_VERSION, 5);
            assert.equal(fleet.BWRAP_PID_SCHEMA_VERSION, 5);
            assert.equal(serviceA.role, 'service');
            assert.equal(serviceA.taskId, '');
            assert.equal(serviceA.provider, '');
            assert.equal(serviceA.processUid, process.getuid());
            assert.match(
                serviceA.processIdentity,
                process.platform === 'linux'
                    ? /^linux-proc:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}:[1-9][0-9]*$/
                    : /^darwin-ps:[1-9][0-9]*:(?:0|[1-9][0-9]*):/,
            );
            assert.equal(taskA.role, 'provider-task');
            assert.equal(taskA.taskId, 'task-a');
            assert.equal(taskA.provider, 'codex');
            assert.deepEqual({
                routeKey: taskA.routeKey,
                rootPort: taskA.rootPort,
                credentialNonceDigest: taskA.credentialNonceDigest,
                credentialExpiresAt: taskA.credentialExpiresAt,
                manifestDigest: taskA.manifestDigest,
                admissionDigest: taskA.admissionDigest,
                networkHash: taskA.networkHash,
            }, {
                routeKey: '',
                rootPort: 0,
                credentialNonceDigest: '',
                credentialExpiresAt: 0,
                manifestDigest: '',
                admissionDigest: '',
                networkHash: '',
            });
            assert.notEqual(serviceA.ownerKey, taskA.ownerKey);
            assert.notEqual(taskA.ownerKey, taskB.ownerKey);
            assert.equal(serviceA.ownerKey, fleet.serviceOwnerKey(runtimeA));
            assert.equal(taskA.ownerKey, fleet.providerTaskOwnerKey(runtimeA, 'task-a'));

            const exactRecordKeys = [
                'admissionDigest',
                'credentialExpiresAt',
                'credentialNonceDigest',
                'enableGeneration',
                'homeKey',
                'instanceId',
                'logPath',
                'manifestDigest',
                'networkHash',
                'ownerKey',
                'pid',
                'processIdentity',
                'processUid',
                'provider',
                'role',
                'rootPort',
                'routeKey',
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
            assert.deepEqual(fleet.assertExactServiceOwner(serviceA), serviceA);
            assert.equal(Object.isFrozen(fleet.assertExactServiceOwner(serviceA)), true);

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
                    ...serviceAttestation('alias-a', 8080, 'a'),
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

            if (process.platform === 'linux') {
                fs.readFileSync = (file, ...args) => {
                    if (String(file) === '/proc/' + servicePidA + '/status') {
                        const status = originalReadFile(file, ...args);
                        const uid = process.getuid();
                        return status.replace(
                            /^Uid:\\s+\\d+\\s+\\d+\\s+\\d+\\s+\\d+\\s*$/m,
                            'Uid:\\t' + uid + '\\t' + (uid + 1) + '\\t' + uid + '\\t' + uid,
                        );
                    }
                    return originalReadFile(file, ...args);
                };
                try {
                    assert.throws(
                        () => fleet.assertExactServiceOwner(serviceA),
                        (error) => error?.code === 'PLOINKY_SANDBOX_OWNER_ATTESTATION_MISMATCH',
                    );
                    assert.throws(
                        () => fleet.stopBwrapProcess(runtimeA, { expectedIdentity: serviceA }),
                        (error) => error?.code === 'PLOINKY_SANDBOX_OWNER_IDENTITY_UNVERIFIED',
                    );
                    assert.equal(fs.existsSync(serviceFileA), true);
                    assert.equal(processExists(servicePidA), true);
                } finally {
                    fs.readFileSync = originalReadFile;
                }

                fs.readFileSync = (file, ...args) => {
                    if (String(file) === '/proc/' + servicePidA + '/status') {
                        const status = originalReadFile(file, ...args);
                        const uid = process.getuid() + 1;
                        return status.replace(
                            /^Uid:\s+\d+\s+\d+\s+\d+\s+\d+\s*$/m,
                            'Uid:\t' + uid + '\t' + uid + '\t' + uid + '\t' + uid,
                        );
                    }
                    return originalReadFile(file, ...args);
                };
                try {
                    assert.throws(
                        () => fleet.stopBwrapProcess(runtimeA, { expectedIdentity: serviceA }),
                        (error) => error?.code === 'PLOINKY_SANDBOX_OWNER_IDENTITY_UNVERIFIED',
                    );
                    assert.equal(fs.existsSync(serviceFileA), true);
                    assert.equal(processExists(servicePidA), true);
                } finally {
                    fs.readFileSync = originalReadFile;
                }
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

            const canonicalServiceBytes = fs.readFileSync(serviceFileA, 'utf8');
            const ownerMutations = [
                ['processUid', serviceA.processUid + 1],
                ['pid', taskPidA],
                ['processIdentity', serviceA.processIdentity + '-changed'],
                ['routeKey', 'other-route'],
                ['rootPort', serviceA.rootPort + 1],
                ['credentialNonceDigest', 'sha256:' + 'f'.repeat(64)],
                ['credentialExpiresAt', serviceA.credentialExpiresAt + 1],
                ['manifestDigest', 'sha256:' + 'f'.repeat(64)],
                ['admissionDigest', 'sha256:' + 'f'.repeat(64)],
                ['networkHash', 'sha256:' + 'f'.repeat(64)],
                ['enableGeneration', 'generation-mutated'],
                ['instanceId', 'instance-mutated'],
                ['runtimeKey', runtimeB],
            ];
            for (const [field, value] of ownerMutations) {
                const mutated = { ...serviceA, [field]: value };
                const mutatedBytes = JSON.stringify(mutated) + '\\n';
                fs.writeFileSync(serviceFileA, mutatedBytes, { mode: 0o600 });
                assert.throws(
                    () => fleet.assertExactServiceOwner(serviceA),
                    (error) => [
                        'PLOINKY_SANDBOX_OWNER_ATTESTATION_MISMATCH',
                        'PLOINKY_SANDBOX_OWNER_RECORD_INVALID',
                        'PLOINKY_SANDBOX_OWNER_INVALID',
                    ].includes(error?.code),
                    field,
                );
                assert.equal(fs.readFileSync(serviceFileA, 'utf8'), mutatedBytes, field);
                assert.equal(processExists(servicePidA), true, field);
                fs.writeFileSync(serviceFileA, canonicalServiceBytes, { mode: 0o600 });
            }
            for (const [field, value] of ownerMutations.filter(([name]) => [
                'pid',
                'processIdentity',
                'processUid',
                'routeKey',
                'rootPort',
                'credentialNonceDigest',
                'credentialExpiresAt',
                'manifestDigest',
                'admissionDigest',
                'networkHash',
            ].includes(name))) {
                assert.equal(fleet.isSandboxOwnerRunning(serviceA.ownerKey, {
                    ...serviceIdentityA,
                    [field]: value,
                }), false, field);
            }
            assert.equal(fs.readFileSync(serviceFileA, 'utf8'), canonicalServiceBytes);
            const expiredService = {
                ...serviceA,
                credentialExpiresAt: Math.floor(Date.now() / 1000) - 1,
            };
            const expiredBytes = JSON.stringify(expiredService) + '\\n';
            fs.writeFileSync(serviceFileA, expiredBytes, { mode: 0o600 });
            assert.throws(
                () => fleet.assertExactServiceOwner(expiredService),
                (error) => error?.code === 'PLOINKY_SANDBOX_OWNER_ATTESTATION_EXPIRED',
            );
            assert.equal(fs.readFileSync(serviceFileA, 'utf8'), expiredBytes);
            assert.equal(processExists(servicePidA), true);
            fs.writeFileSync(serviceFileA, canonicalServiceBytes, { mode: 0o600 });

            const reusedService = JSON.parse(fs.readFileSync(serviceFileA, 'utf8'));
            reusedService.processIdentity = differentCanonicalProcessIdentity(
                reusedService.processIdentity,
            );
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
            const routedTask = { ...taskA, routeKey: 'forbidden-route' };
            fs.writeFileSync(taskFileA, JSON.stringify(routedTask) + '\\n', { mode: 0o600 });
            assert.throws(
                () => fleet.readSandboxOwner(taskA.ownerKey),
                /must not carry service routing authority/,
            );
            assert.equal(fs.existsSync(taskFileA), true);
            fs.writeFileSync(taskFileA, canonicalTaskBytes, { mode: 0o600 });
            const reusedTask = JSON.parse(canonicalTaskBytes);
            reusedTask.processIdentity = differentCanonicalProcessIdentity(
                reusedTask.processIdentity,
            );
            fs.writeFileSync(taskFileA, JSON.stringify(reusedTask) + '\\n', { mode: 0o600 });
            assert.equal(fleet.stopSandboxOwner(taskA.ownerKey, {
                expected: taskA,
                timeout: 25,
                killTimeout: 25,
            }), false);
            assert.equal(fs.existsSync(taskFileA), true);
            assert.equal(processExists(taskPidA), true);
            assert.equal(fleet.stopSandboxOwner(taskA.ownerKey, {
                expected: reusedTask,
                timeout: 25,
                killTimeout: 25,
            }), true);
            assert.equal(fs.existsSync(taskFileA), false);
            assert.equal(processExists(taskPidA), true);
            signalForCleanup(taskPidA);

            const v4Runtime = 'ploinky_repo_agent_v4_workspace_deadbeef';
            const v4File = fleet.BWRAP_PIDS_DIR + '/' + fleet.serviceOwnerKey(v4Runtime) + '.owner.json';
            fs.writeFileSync(v4File, JSON.stringify({
                schemaVersion: 4,
                runtimeKey: v4Runtime,
                pid: process.pid,
            }) + '\\n', { mode: 0o600 });
            assert.throws(
                () => fleet.readServiceOwner(v4Runtime),
                (error) => error?.code === 'PLOINKY_SANDBOX_OWNER_RECORD_INVALID',
            );
            assert.equal(fs.existsSync(v4File), true);
            fs.unlinkSync(v4File);

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
            assert.throws(
                () => fleet.saveServiceOwner({
                    runtimeKey: runtimeA,
                    pid: process.pid,
                    ...taskIdentity,
                    homeKey: runtimeA,
                    workdir: '/workspace',
                    logPath: '/workspace/service.log',
                }),
                /routeKey/,
            );
            assert.throws(
                () => fleet.saveServiceOwner({
                    runtimeKey: runtimeA,
                    pid: process.pid,
                    ...taskIdentity,
                    homeKey: runtimeA,
                    workdir: '/workspace',
                    logPath: '/workspace/service.log',
                    ...serviceAttestation('alias-a', 8080, 'a'),
                    rootPort: 0,
                }),
                /rootPort/,
            );
            assert.throws(
                () => fleet.saveServiceOwner({
                    runtimeKey: runtimeA,
                    pid: process.pid,
                    ...taskIdentity,
                    homeKey: runtimeA,
                    workdir: '/workspace',
                    logPath: '/workspace/service.log',
                    ...serviceAttestation('alias-a', 8080, 'a'),
                    credentialNonceDigest: 'sha256:' + 'A'.repeat(64),
                }),
                /credentialNonceDigest/,
            );
            assert.throws(
                () => fleet.saveServiceOwner({
                    runtimeKey: runtimeA,
                    pid: process.pid,
                    ...taskIdentity,
                    homeKey: runtimeA,
                    workdir: '/workspace',
                    logPath: '/workspace/service.log',
                    ...serviceAttestation('alias-a', 8080, 'a'),
                    credentialExpiresAt: Math.floor(Date.now() / 1000),
                }),
                /future timestamp/,
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
                ...serviceAttestation('alias-b', 8080, 'a'),
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
        assert.equal(evidence.schemaVersion, 5);
        assert.match(evidence.serviceOwnerKey, /^service-[a-f0-9]{64}$/);
        assert.equal(new Set(evidence.taskOwnerKeys).size, 3);
        for (const ownerKey of evidence.taskOwnerKeys) {
            assert.match(ownerKey, /^provider-task-[a-f0-9]{64}$/);
        }
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});
