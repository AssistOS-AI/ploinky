import fs from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createRepositoryProcessObserver, PROC_LIMITS, REPOSITORY_OPERATION_MARKER, sameProcess } from './marketplaceRepositoryProcessGroup.mjs';
import { INSTALL_BWRAP, INSTALL_PROCESS, installUnitArguments, installUnitError } from './marketplaceRepositoryInstallUnit.mjs';

const sameBirth = (left, right) => left.birth === right.birth && left.namespace === right.namespace && left.uids === right.uids;
const missing = error => ['ENOENT', 'ESRCH'].includes(error?.code);

export function createRepositoryNamespaceObserver({ fsApi = fs, outer = createRepositoryProcessObserver(),
    procRoot = '/proc', now = () => performance.now(), kill = process.kill,
    observerFactory = options => createRepositoryProcessObserver(options) } = {}) {
    return {
        async attest({ launcherPid, initPid, coordinator, operationId, workspaceRoot, cwd, executable = process.execPath }) {
            const deadline = now() + PROC_LIMITS.timeoutMs;
            let expired = false;
            let proc;
            let namespace;
            let timer;
            const check = () => { if (expired || now() >= deadline) throw installUnitError(); };
            const task = async () => {
                if (![launcherPid, initPid].every(pid => Number.isSafeInteger(pid) && pid > 0 && pid <= 2147483647)
                    || launcherPid === initPid || !coordinator || !/^[a-f0-9-]{36}$/.test(operationId || '')) throw installUnitError();
                const expectedArgs = [INSTALL_BWRAP, ...installUnitArguments({ workspaceRoot, cwd, executable })];
                const marker = `${REPOSITORY_OPERATION_MARKER}=${operationId}`;
                const supervisor = await outer.read(coordinator.pid); check();
                const launcher = await outer.read(launcherPid, { executable: true, environment: true }); check();
                const init = await outer.read(initPid); check();
                if (!sameProcess(supervisor, coordinator) || launcher.parent !== coordinator.pid || init.parent !== launcherPid
                    || launcher.uids !== coordinator.uids || init.uids !== coordinator.uids
                    || launcher.namespace !== coordinator.namespace || init.namespace === coordinator.namespace
                    || launcher.exe !== INSTALL_BWRAP || JSON.stringify(launcher.argv) !== JSON.stringify(expectedArgs)
                    || !launcher.environment?.includes(marker)) throw installUnitError();
                namespace = await fsApi.open(`${procRoot}/${initPid}/ns/pid`, 'r'); check();
                proc = await fsApi.open(`${procRoot}/${initPid}/root/proc`, 'r'); check();
                const pinnedRoot = `${procRoot}/self/fd/${proc.fd}`;
                const pinnedNamespace = await fsApi.readlink(`${procRoot}/self/fd/${namespace.fd}`); check();
                const type = (await fsApi.statfs(pinnedRoot)).type; check();
                if (type !== 0x9fa0 || pinnedNamespace !== init.namespace) throw installUnitError();
                // The base proc parser permits private zero topology fields;
                // no legacy cohort validator or ownership classification runs.
                const privateObserver = observerFactory({ fsApi, procRoot: pinnedRoot, now });
                const privateInit = await privateObserver.read(1); check();
                const helper = await privateObserver.read(2, { executable: true }); check();
                if (!sameBirth(privateInit, init) || helper.namespace !== init.namespace || helper.uids !== init.uids
                    || helper.parent !== 1 || helper.exe !== executable
                    || JSON.stringify(helper.argv) !== JSON.stringify([executable, INSTALL_PROCESS])) throw installUnitError();
                const launcherAfter = await outer.read(launcherPid, { executable: true, environment: true }); check();
                const initAfter = await outer.read(initPid); check();
                const supervisorAfter = await outer.read(coordinator.pid); check();
                if (!sameProcess(supervisorAfter, coordinator) || !sameProcess(launcherAfter, launcher) || !sameProcess(initAfter, init)
                    || launcherAfter.parent !== coordinator.pid || initAfter.parent !== launcherPid
                    || launcherAfter.exe !== launcher.exe || JSON.stringify(launcherAfter.argv) !== JSON.stringify(expectedArgs)
                    || !launcherAfter.environment?.includes(marker)) throw installUnitError();
                let closed = false;
                const scan = async () => {
                    if (closed) throw installUnitError();
                    const observation = await privateObserver.scan();
                    if (closed) throw installUnitError();
                    const records = observation.records;
                    return { ...observation, members: records,
                        writers: records.filter(record => record.state !== 'Z'
                            && !sameProcess(record, privateInit) && !sameProcess(record, helper)) };
                };
                return {
                    scan,
                    async proveBarrier() {
                        for (let pass = 0; pass < 2; pass += 1) {
                            const result = await scan();
                            if (!result.complete) throw installUnitError('namespace-incomplete');
                            if (result.writers.length) throw installUnitError('namespace-writer');
                            if (!result.records.some(record => sameProcess(record, privateInit))
                                || !result.records.some(record => sameProcess(record, helper))) throw installUnitError('namespace-incomplete');
                            if (!pass) await new Promise(resolve => setTimeout(resolve, 25));
                        }
                    },
                    async proveTerminated() {
                        for (let pass = 0; pass < 2; pass += 1) {
                            if (closed) throw installUnitError();
                            try { await outer.read(init.pid); throw installUnitError('namespace-termination'); }
                            catch (error) { if (!missing(error)) throw error; }
                        }
                        const result = await scan();
                        if (!result.complete || result.records.length) throw installUnitError('namespace-termination');
                    },
                    async signal(signalName, isAllowed = () => true) {
                        if (closed) return false;
                        return outer.signal(init, signalName, { kill, isAllowed: () => !closed && isAllowed() });
                    },
                    async close() {
                        if (closed) return;
                        closed = true;
                        await Promise.allSettled([proc.close(), namespace.close()]);
                    },
                };
            };
            try {
                return await Promise.race([task().catch(async error => {
                    await Promise.allSettled([proc?.close(), namespace?.close()]);
                    if (error?.diagnostic?.predicate === 'install-protocol') throw installUnitError('namespace-attestation');
                    throw error;
                }), new Promise((_, reject) => {
                    timer = setTimeout(() => { expired = true; reject(installUnitError()); }, PROC_LIMITS.timeoutMs);
                })]);
            } finally { clearTimeout(timer); }
        },
    };
}
