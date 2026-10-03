// The production root preparation and uid-1000 parent creation run over the
// in-memory cgroup hierarchy; the fixed CORE_LAYOUT observer then runs over it,
// exactly as C1 observes a Box. Test-only helper of the step-4 executor tests.
import vm from 'node:vm';
import { prepareCgroupDelegation } from '../../ploinky-box/entrypoint/cgroupDelegation.mjs';
import { ensureAgentCgroupParents, readStructuralDelegation } from '../../cli/sandbox/hardwareLimits/delegation.mjs';
import { CORE_LAYOUT } from './liveCaseCommands.mjs';
import { FakeCgroupFs } from './fakeCgroupFs.mjs';

const INTERFACE_FILES = Object.freeze({ 'cpu.max': ['cpu', 'max 100000'], 'memory.max': ['memory', 'max'], 'pids.max': ['pids', 'max'] });
export function observerFs(fake) {
    const interfaceFile = (target) => {
        const located = fake.resolve(target);
        const group = located?.file && fake.groups.get(located.rel);
        const known = group && INTERFACE_FILES[located.file];
        return known && group.available.has(known[0]) ? { group, value: known[1] } : null;
    };
    const stat = ({ uid, gid = uid, mode }, directory) => ({ uid, gid, mode: mode ?? (directory ? 0o40755 : 0o100644), isDirectory: () => directory, isSymbolicLink: () => false });
    return {
        lstatSync(target) {
            try { const value = fake.lstatSync(target); return stat(value, value.isDirectory()); }
            catch (error) { const file = error.code === 'ENOENT' && interfaceFile(target); if (!file) throw error; return stat({ uid: file.group.uid }, false); }
        },
        readFileSync(target) {
            try { return fake.readFileSync(target); }
            catch (error) { const file = error.code === 'ENOENT' && interfaceFile(target); if (!file) throw error; return `${file.value}\n`; }
        },
        writeFileSync: (...args) => fake.writeFileSync(...args),
        mkdirSync: (...args) => fake.mkdirSync(...args),
        chownSync: (...args) => fake.chownSync(...args),
        rmdirSync: (...args) => fake.rmdirSync(...args),
    };
}
export function observeLayout(fsApi) {
    let output = '';
    vm.runInNewContext(CORE_LAYOUT, { require: () => fsApi, process: { stdout: { write: (text) => { output += text; } } } });
    return JSON.parse(output);
}
export async function productionLayout({ available = ['cpu', 'io', 'memory', 'pids'] } = {}) {
    const fake = new FakeCgroupFs({ controllers: available });
    const first = await prepareCgroupDelegation({ argv: ['prepare'], getuid: () => 0, fsApi: fake, sleep: async () => {} });
    if (first.exitCode !== 0) throw new Error(JSON.stringify(first.result));
    fake.actorUid = 1000;
    const structural = readStructuralDelegation({ fsApi: fake });
    ensureAgentCgroupParents({ fsApi: fake, controllers: structural.controllers });
    return { fake, layout: observeLayout(observerFs(fake)) };
}
