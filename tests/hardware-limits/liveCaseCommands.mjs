// Reviewed, fixed programs used by the live harness. Manifest values are
// passed as validated argv values, never interpolated into executable source.
import { DELEGATED_GID, DELEGATED_UID, WANTED_CONTROLLERS } from '../../ploinky-box/entrypoint/cgroupDelegation.mjs';
import { PREPARE_SCRIPT_BOX_PATH, parsePreparationResult } from '../../ploinky-box/hardwareLimits/status.mjs';

// Every path's directory, its delegation and controller files, and each
// controller's interface file, with owner, group, mode and value. An absent
// path or file is recorded as absent, never skipped.
export const CORE_LAYOUT = String.raw`
const fs=require('node:fs');
const root='/sys/fs/cgroup';
const paths=['/','/ploinky','/ploinky/core','/ploinky/agents','/ploinky/system'];
const files=['cgroup.procs','cgroup.subtree_control','cgroup.threads','cgroup.controllers','cpu.max','memory.max','pids.max'];
const stat=(p)=>{try{return fs.lstatSync(p);}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const result={pid1:fs.readFileSync('/proc/1/cgroup','utf8'),self:fs.readFileSync('/proc/self/cgroup','utf8'),paths:{}};
for(const suffix of paths){const p=root+(suffix==='/'?'':suffix);const st=stat(p);if(!st){result.paths[suffix]={present:false};continue;}
const entry={present:true,directory:st.isDirectory()&&!st.isSymbolicLink(),uid:st.uid,gid:st.gid,mode:st.mode&4095,files:{}};
for(const name of files){const f=p+'/'+name;const s=stat(f);entry.files[name]=s?{present:true,uid:s.uid,gid:s.gid,mode:s.mode&4095,value:fs.readFileSync(f,'utf8')}:{present:false};}
result.paths[suffix]=entry;}
process.stdout.write(JSON.stringify(result));`;

// The exact fixed command production runs for root preparation
// (ploinky-box/hardwareLimits/status.mjs prepareBoxGeneration).
export function preparationReportArgs(boxId) {
    if (!/^[a-f0-9]{64}$/.test(String(boxId))) throw new Error('Preparation report needs the exact immutable Box ID');
    return ['container', 'exec', '--user', 'root', '--workdir', '/', '--env', 'NODE_OPTIONS=', '--env', 'NODE_PATH=',
        boxId, '/usr/local/bin/node', PREPARE_SCRIPT_BOX_PATH, 'prepare'];
}

/**
 * The claimed enforceable controllers, taken from production's own root
 * preparation report rather than from the CORE_LAYOUT observation. Only an
 * already:true report is accepted: production reports it only when its exact
 * layout and controller readbacks were already settled, so this invocation
 * changed nothing. Claimed plus missing must be exactly the wanted set.
 */
export function preparationClaim(stdout) {
    const report = parsePreparationResult(stdout);
    if (report.structurallyPrepared !== true || report.already !== true || report.reason !== null || report.nsdelegate !== true) {
        throw new Error('Box preparation did not report an already exact prepared layout');
    }
    const controllers = report.controllers;
    const missing = report.missing.map((entry) => entry?.controller);
    if (controllers.some((controller) => !WANTED_CONTROLLERS.includes(controller)) || new Set(controllers).size !== controllers.length
        || report.missing.some((entry) => !entry || typeof entry.reason !== 'string' || !WANTED_CONTROLLERS.includes(entry.controller))
        || new Set(missing).size !== missing.length
        || WANTED_CONTROLLERS.some((controller) => controllers.includes(controller) === missing.includes(controller))) {
        throw new Error('Box preparation reported an inconsistent controller claim');
    }
    return Object.freeze({ controllers: Object.freeze([...controllers]), missing: Object.freeze(missing) });
}

export const MEMBERSHIP = String.raw`
const fs=require('node:fs');const pid=process.argv[1];if(!/^[1-9][0-9]*$/.test(pid))throw Error('Invalid PID');
const stat=fs.readFileSync('/proc/'+pid+'/stat','utf8');const close=stat.lastIndexOf(')');
process.stdout.write(JSON.stringify({pid:Number(pid),start:stat.slice(close+2).trim().split(/\s+/)[19],cgroup:fs.readFileSync('/proc/'+pid+'/cgroup','utf8')}));`;

export const HELD_ALLOCATION = String.raw`
const fs=require('node:fs');const id=process.argv[1];if(!/^[a-f0-9]{32}$/.test(id))throw Error('Invalid run identity');
const root='/tmp/hwl-'+id;const ready=root+'.ready',release=root+'.release';
if(fs.existsSync(ready)||fs.existsSync(release))throw Error('Existing handshake files');
const held=[Buffer.alloc(16*1024*1024,0x5a)];fs.writeFileSync(ready,JSON.stringify({pid:process.pid,bytes:held[0].length}),{flag:'wx',mode:384});
let timer=setInterval(()=>{if(!fs.existsSync(release))return;clearInterval(timer);timer=setInterval(()=>held.push(Buffer.alloc(8*1024*1024,0x5a)),100)},50);
setTimeout(()=>{clearInterval(timer);for(const p of[ready,release])try{fs.unlinkSync(p)}catch(e){if(e.code!=='ENOENT')throw e;}process.exit(4)},20000);`;

export const ALLOCATION_HANDSHAKE = String.raw`
const fs=require('node:fs');const id=process.argv[1],mode=process.argv[2];if(!/^[a-f0-9]{32}$/.test(id)||!['observe','release'].includes(mode))throw Error('Invalid handshake');
const root='/tmp/hwl-'+id;const ready=root+'.ready';let value=null;
try{const fd=fs.openSync(ready,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const st=fs.fstatSync(fd);if(!st.isFile()||st.nlink!==1||st.size>1024)throw Error('Invalid ready receipt');value=JSON.parse(fs.readFileSync(fd,'utf8'));}finally{fs.closeSync(fd)}}catch(e){if(e.code!=='ENOENT')throw e;}
if(value){if(!Number.isSafeInteger(value.pid)||value.pid<=0||value.bytes!==16777216)throw Error('Invalid allocation receipt');process.kill(value.pid,0);if(mode==='release')fs.writeFileSync(root+'.release','release',{flag:'wx',mode:384});}
process.stdout.write(JSON.stringify(value));`;

export const LEAF_OBSERVATION = String.raw`
const fs=require('node:fs');const p=process.argv[1];if(!/^\/sys\/fs\/cgroup\/ploinky\/agents\//.test(p)||fs.realpathSync(p)!==p)throw Error('Noncanonical leaf');
const names=['memory.max','memory.swap.max','memory.current','memory.swap.current','memory.events','cpu.max','cpu.stat','pids.max','pids.events'];const st=fs.statSync(p);
process.stdout.write(JSON.stringify({...Object.fromEntries(names.map(n=>[n,fs.readFileSync(p+'/'+n,'utf8')])),identity:{dev:String(st.dev),ino:String(st.ino)}}));`;

const OWNER_WRITE = 0o200;
const AGGREGATE = Object.freeze({
    memory: ['memory.max', (value) => value === 'max'],
    pids: ['pids.max', (value) => value === 'max'],
    cpu: ['cpu.max', (value) => /^max [1-9][0-9]*$/.test(value)],
});
const words = (value) => String(value).split(/\s+/).filter(Boolean);

function observedEntry(value, suffix) {
    const entry = value.paths?.[suffix];
    if (!entry || entry.present === false || !Number.isSafeInteger(entry.uid)) throw new Error(`Missing cgroup evidence for ${suffix}`);
    return entry;
}
function observedFile(entry, suffix, name) {
    const file = entry.files?.[name];
    if (!file || file.present === false || !Number.isSafeInteger(file.uid) || typeof file.value !== 'string') {
        throw new Error(`Missing cgroup evidence for ${suffix}/${name}`);
    }
    return file;
}

/**
 * The C1 core and delegation proof against production's preparation contract
 * (ploinky-box/entrypoint/cgroupDelegation.mjs) and its non-root parent
 * creation (cli/sandbox/hardwareLimits/delegation.mjs ensureAgentCgroupParents).
 * `claim` is preparationClaim()'s result; only claimed controllers are
 * required, and missing evidence fails.
 */
export function assertCoreLayout(value, claim) {
    const claimed = claim?.controllers;
    if (!Array.isArray(claimed) || claimed.some((controller) => !WANTED_CONTROLLERS.includes(controller))
        || new Set(claimed).size !== claimed.length) throw new Error('Missing independent controller claim');
    if (!value || !/^0::\/ploinky\/core\s*$/.test(value.pid1) || !/^0::\/ploinky\/core\s*$/.test(value.self)) throw new Error('Box PID1/core observer placement mismatch');
    const entries = Object.fromEntries(['/', '/ploinky/core', '/ploinky', '/ploinky/agents', '/ploinky/system'].map((suffix) => [suffix, observedEntry(value, suffix)]));
    for (const suffix of ['/', '/ploinky/core']) {
        const entry = entries[suffix];
        observedFile(entry, suffix, 'cgroup.procs');
        if (entry.uid !== 0 || Object.values(entry.files || {}).some((file) => file?.present !== false && file?.uid !== 0)) throw new Error('Root/core cgroup ownership mismatch');
    }
    // Production delegates /ploinky and exactly these files to 1000:1000.
    const delegated = [];
    for (const [label, read] of [['/ploinky', () => entries['/ploinky']], ...['cgroup.procs', 'cgroup.subtree_control', 'cgroup.threads']
        .map((name) => [`/ploinky/${name}`, () => observedFile(entries['/ploinky'], '/ploinky', name)])]) {
        const target = read();
        if (target.uid !== DELEGATED_UID) throw new Error(`Delegated cgroup ownership mismatch: ${label} is owned by uid ${target.uid}`);
        delegated.push([label, target]);
    }
    for (const suffix of ['/ploinky/agents', '/ploinky/system']) {
        if (entries[suffix].uid !== DELEGATED_UID) throw new Error(`Delegated cgroup ownership mismatch: ${suffix} is owned by uid ${entries[suffix].uid}`);
    }
    for (const [label, target] of delegated) {
        if (target.gid !== DELEGATED_GID) throw new Error(`Delegated cgroup group mismatch: ${label} has gid ${target.gid}`);
        if (!Number.isSafeInteger(target.mode) || (target.mode & OWNER_WRITE) === 0) throw new Error(`Delegated cgroup mode is not owner-writable: ${label}`);
    }
    for (const [suffix, entry] of Object.entries(entries)) {
        if (entry.directory !== true) throw new Error(`${suffix} is not a real cgroup directory`);
    }
    for (const suffix of ['/', '/ploinky']) {
        if (words(observedFile(entries[suffix], suffix, 'cgroup.procs').value).length) throw new Error(`${suffix} has direct processes`);
    }
    // Claimed controllers are enabled at the root and /ploinky (root
    // preparation) and in both parents (ensureAgentCgroupParents).
    for (const suffix of ['/', '/ploinky', '/ploinky/agents', '/ploinky/system']) {
        const enabled = new Set(words(observedFile(entries[suffix], suffix, 'cgroup.subtree_control').value));
        for (const controller of claimed) {
            if (!enabled.has(controller)) throw new Error(`Claimed controller ${controller} is not enabled in ${suffix}`);
        }
    }
    for (const suffix of ['/ploinky', '/ploinky/agents', '/ploinky/system']) {
        for (const controller of claimed) {
            const [name, accepted] = AGGREGATE[controller];
            if (!accepted(observedFile(entries[suffix], suffix, name).value.trim())) throw new Error('Unexpected aggregate cgroup cap');
        }
    }
    return value;
}

export function validateProbe(result, { maxMiB, uid = 1000 } = {}) {
    if (result.status!==0 || result.signal || result.errorCode || result.timedOut || result.truncated || result.cancelled || result.settlementForced) throw new Error('CUDA probe transport failed');
    let value;try{value=JSON.parse(result.stdout);}catch{throw new Error('CUDA probe JSON invalid');}
    if (!value?.ok || value.status!=='complete' || value.containerUid!==uid || !Number.isSafeInteger(value.containerPid) || value.containerPid<=0
        || !Number.isSafeInteger(value.smCount) || value.smCount<=0 || !Number.isSafeInteger(value.allocatedMiB) || value.allocatedMiB<0
        || value.boundMiB!==maxMiB || value.allocatedMiB>maxMiB || !['allocation_oom','bound'].includes(value.termination)
        || !Number.isSafeInteger(value.memGetInfo?.freeBytes) || value.memGetInfo.freeBytes<0
        || !Number.isSafeInteger(value.memGetInfo?.totalBytes) || value.memGetInfo.totalBytes<=0
        || value.cleanupErrors?.length) throw new Error('CUDA probe did not provide complete valid evidence');
    return value;
}
