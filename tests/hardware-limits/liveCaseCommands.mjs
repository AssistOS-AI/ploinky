// Reviewed, fixed programs used by the live harness. Manifest values are
// passed as validated argv values, never interpolated into executable source.
export const CORE_LAYOUT = String.raw`
const fs=require('node:fs');
const root='/sys/fs/cgroup';
const paths=['/','/ploinky','/ploinky/core','/ploinky/agents','/ploinky/system'];
const files=['cgroup.procs','cgroup.subtree_control','cpu.max','memory.max','pids.max'];
const result={pid1:fs.readFileSync('/proc/1/cgroup','utf8'),self:fs.readFileSync('/proc/self/cgroup','utf8'),paths:{}};
for(const suffix of paths){const p=root+(suffix==='/'?'':suffix);const st=fs.statSync(p);const entry={uid:st.uid,gid:st.gid,files:{}};for(const name of files){try{const f=p+'/'+name;const s=fs.statSync(f);entry.files[name]={uid:s.uid,gid:s.gid,value:fs.readFileSync(f,'utf8')};}catch(e){if(e.code!=='ENOENT')throw e;}}result.paths[suffix]=entry;}
process.stdout.write(JSON.stringify(result));`;

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

export function assertCoreLayout(value) {
    if (!value || !/^0::\/ploinky\/core\s*$/.test(value.pid1) || !/^0::\/ploinky\/core\s*$/.test(value.self)) throw new Error('Box PID1/core observer placement mismatch');
    for (const suffix of ['/', '/ploinky/core']) {
        const entry=value.paths?.[suffix];
        if (entry?.uid!==0 || Object.values(entry.files || {}).some(file=>file.uid!==0)) throw new Error('Root/core cgroup ownership mismatch');
    }
    for (const suffix of ['/ploinky', '/ploinky/agents', '/ploinky/system']) {
        if (value.paths?.[suffix]?.uid!==1000) throw new Error('Delegated cgroup ownership mismatch');
    }
    for (const suffix of ['/ploinky', '/ploinky/agents', '/ploinky/system']) {
        const files=value.paths[suffix].files;
        if (files['memory.max']?.value.trim()!=='max' || files['pids.max']?.value.trim()!=='max'
            || !/^max [1-9][0-9]*$/.test(files['cpu.max']?.value.trim()||'')) throw new Error('Unexpected aggregate cgroup cap');
    }
    return value;
}

export function validateProbe(result, { maxMiB, uid = 1000 } = {}) {
    if (result.status!==0 || result.signal || result.errorCode || result.timedOut || result.truncated || result.cancelled) throw new Error('CUDA probe transport failed');
    let value;try{value=JSON.parse(result.stdout);}catch{throw new Error('CUDA probe JSON invalid');}
    if (!value?.ok || value.status!=='complete' || value.containerUid!==uid || !Number.isSafeInteger(value.containerPid) || value.containerPid<=0
        || !Number.isSafeInteger(value.smCount) || value.smCount<=0 || !Number.isSafeInteger(value.allocatedMiB) || value.allocatedMiB<0
        || value.boundMiB!==maxMiB || value.allocatedMiB>maxMiB || !['allocation_oom','bound'].includes(value.termination)
        || !Number.isSafeInteger(value.memGetInfo?.freeBytes) || value.memGetInfo.freeBytes<0
        || !Number.isSafeInteger(value.memGetInfo?.totalBytes) || value.memGetInfo.totalBytes<=0
        || value.cleanupErrors?.length) throw new Error('CUDA probe did not provide complete valid evidence');
    return value;
}
