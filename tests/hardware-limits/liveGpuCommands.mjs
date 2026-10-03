// Reviewed, fixed programs and argument builders for the apparatus-mps cases
// (LIVE-P1 to LIVE-P4). Values reach a program only as validated argv words,
// never by interpolation into executable source. Test-only; nothing here runs
// a process. Programs run as Box uid 1000 (`container exec --user podman`)
// and only observe, except the two the plan defines as mutations: the
// administrator request (Apply and the policy store, through the Router's own
// route) and the owned-daemon kill of the crash case.
import { mpsServerDefaultMemoryMiB } from '../../cli/sandbox/hardwareLimits/mps.mjs';
import { validateProbe } from './liveCaseCommands.mjs';
import { HASH, absolute, blocked, bounded, keys } from './liveCommon.mjs';

export const MPS_CLIENT_PIPE = '/run/ploinky-mps-pipe';
export const MPS_TOOL_DIRECTORY = '/usr/local/nvidia/bin';
export const MPS_LIBRARY_DIRECTORY = '/usr/local/nvidia/lib64';
export const PROBE_FILE = 'mpsprobe.py';
export const PROBE_CONTAINER_PATH = '/code/mpsprobe.py';
export const PROBE_DEADLINE_MS = 45000;
export const MIB = 1048576;

// Shares the executors save. 17% of the 6144-MiB RTX 3060 is 1044 MiB (the
// production floor(vramPercent * total / 100)): about the plan's 1-GiB cap.
export const GPU_SHARES = Object.freeze({
    first: Object.freeze({ smPercent: 25, vramPercent: 17 }),
    raised: Object.freeze({ smPercent: 50, vramPercent: 34 }),
});
// What a successful Apply or restart proves about each drained container, recorded in the case evidence. The product does not expose
// the drained container's exit status: drainTargetedContainer returns it, but its callers discard it (mpsGraph.mjs:181 `drain(...)`,
// mpsLifecycle.mjs:231) and the journal keeps only the drain receipt. What is certain: a drain returns only after assertCleanTermination
// (cli/sandbox/docker/targetedContainerLifecycle.js:107-122, called at :184 and :207) found exit status 0, no OOM kill and no state error,
// and throws TARGETED_DRAIN_FAILED otherwise. That holds only for a client the drain actually reached: a cohort client that was already not
// running is retired directly (mpsLifecycle.mjs:222-227) and an absent container returns early (targetedContainerLifecycle.js:180-182),
// both without it. So the claim is made by observation: only a client seen RUNNING immediately before an Apply that answered `applied` is
// recorded as acknowledged; every other client is recorded as not acknowledged.
export const DRAIN_ACKNOWLEDGEMENT_BASIS = Object.freeze({
    exitStatus: 'not exposed by the product',
    basis: 'running-before-and-applied-implies-assertCleanTermination-passed (exit 0)',
    source: 'cli/sandbox/docker/targetedContainerLifecycle.js:107-122',
});
export const shareMemoryMiB = (vramPercent, totalMiB) => Math.floor(vramPercent * totalMiB / 100);
// The daemon-wide memory default the product configures for a share (amendment A6): the share rounded UP to a whole GiB, by
// the product's own function. The client keeps the exact share (shareMemoryMiB) in its environment.
export const serverDefaultMiB = (vramPercent, totalMiB) => mpsServerDefaultMemoryMiB(shareMemoryMiB(vramPercent, totalMiB));
// A tighter client value the P2 probes set themselves: 10% of the SMs and a
// 512-MiB per-process limit. A client may set any value; the server default
// is only a default (that is the documented best-effort limit).
export const TIGHTER_CLIENT = Object.freeze({ smPercent: 10, memoryMiB: 512 });
// The 128-MiB probe steps: the bound must be a multiple of 128 above the cap.
export const probeBoundMiB = capMiB => Math.ceil((capMiB + 256) / 128) * 128;

// ---------------------------------------------------------------------------
// Nested-engine inspect of one agent container: Go field names only. Config.User
// is the image user the share eligibility reads; Config.Env and Mounts carry
// the MPS environment and pipe bind; Config.Labels the generation labels.
export const GPU_AGENT_INSPECT = '{"id":{{json .ID}},"name":{{json .Name}},"created":{{json .Created}},"image":{{json .Image}},"imageName":{{json .ImageName}},"user":{{json .Config.User}},"labels":{{json .Config.Labels}},"env":{{json .Config.Env}},"mounts":{{json .Mounts}},"running":{{json .State.Running}},"pid":{{json .State.Pid}},"startedAt":{{json .State.StartedAt}}}';
// `{{.ID}} {{.Names}}`: one row per nested container, to find the container a
// replacement created under the same name.
export const NESTED_NAME_LIST_FORMAT = '{{.ID}} {{.Names}}';

// The CUDA probe command inside one agent container. `set` overrides client
// environment values for this process only; `unset` removes names so the
// process does not use MPS (the bypass), through `env -u`.
export function probeExecArgv({ containerId, maxMiB, set = {}, unset = [] }) {
    if (!/^[a-f0-9]{64}$/.test(containerId) || !Number.isInteger(maxMiB) || maxMiB < 128 || maxMiB > 8192 || maxMiB % 128) throw new Error('Invalid CUDA probe invocation');
    const names = [...Object.keys(set), ...unset];
    if (names.some(name => !/^CUDA_MPS_[A-Z_]+$/.test(name)) || Object.values(set).some(value => !/^[A-Za-z0-9=/._:-]{1,128}$/.test(String(value)))) throw new Error('Invalid CUDA probe environment');
    return ['container', 'exec', ...Object.entries(set).flatMap(([name, value]) => ['--env', `${name}=${value}`]), containerId,
        ...(unset.length ? ['env', ...unset.flatMap(name => ['-u', name])] : []), 'python3', PROBE_CONTAINER_PATH, '--max-mib', String(maxMiB)];
}

// ---------------------------------------------------------------------------
// Probe protocol (plan §18.9). The probe prints one bounded JSON line and exits
// 0 (complete), 2 (failed) or 3 (blocked: an unsupported driver call). A CUDA
// allocation failure is a probe-REPORTED termination (allocation_oom), not a
// kernel OOM kill and not an error; an initialization or protocol failure is
// never expected. The first MiB-bounded report is returned; everything else
// throws with the probe's own step and error.
export function parseProbeResult(result, { maxMiB, uid = 1000 } = {}) {
    if (!result || result.errorCode || result.signal || result.timedOut || result.truncated || result.cancelled || result.settlementForced) throw new Error('CUDA probe transport failed');
    const text = String(result.stdout || '').trim();
    let report = null;
    try { report = text.length <= 16384 ? JSON.parse(text.split('\n').filter(Boolean).at(-1) || '') : null; } catch { report = null; }
    if (result.status === 3) throw blocked(`CUDA probe unsupported: ${String(report?.step || 'unknown step').slice(0, 64)}: ${String(report?.error || 'no detail').slice(0, 200)}`);
    // The probe never started: python3 or the staged file is missing from the
    // image. That is a prerequisite of the fixture, not a failure of the share.
    if (!report && (result.status === 126 || result.status === 127 || /executable file .* not found|not found in \$PATH|can't open file|No such file or directory/i.test(String(result.stderr || '')))) {
        throw blocked(`The CUDA probe cannot start in the fixture image (exit ${result.status}): ${String(result.stderr || '').replace(/\s+/g, ' ').trim().slice(0, 200)}`);
    }
    if (result.status !== 0) {
        // libcuda missing at the fixed path is a wiring prerequisite, not a failure of the share.
        if (report?.step === 'python' && /libcuda/.test(String(report?.error))) throw blocked(`CUDA probe cannot load the driver library at the generated wiring path: ${String(report.error).slice(0, 200)}`);
        throw new Error(`CUDA probe failed at ${String(report?.step || 'an unknown step').slice(0, 64)}: ${String(report?.error || `exit ${result.status}`).slice(0, 200)}`);
    }
    if (!report) throw new Error('CUDA probe JSON invalid');
    if (report.ok === true && report.termination === 'bound' && report.allocatedMiB < maxMiB) throw new Error('CUDA probe reported a bound termination below its bound');
    return validateProbe({ ...result, stdout: JSON.stringify(report) }, { maxMiB, uid });
}

// ---------------------------------------------------------------------------
// MPS control replies, captured as evidence only. The production parser is the
// authority on grammar; the plan (§18.8) leaves the memory reply's wire format
// Unknown until LIVE-P1 captures it, so these helpers never extract numbers
// leniently: they keep the raw reply and classify only exact forms.
export const MPS_CONTROL_COMMANDS = Object.freeze([
    /^get_server_list$/, /^get_default_active_thread_percentage$/, /^get_default_device_pinned_mem_limit 0$/,
    /^set_active_thread_percentage [1-9][0-9]{0,9} (?:[1-9][0-9]?|100)$/, /^set_device_pinned_mem_limit [1-9][0-9]{0,9} 0 [1-9][0-9]{0,5}M$/,
]);
export function assertMpsControlCommand(command) {
    if (typeof command !== 'string' || command.length > 200 || !MPS_CONTROL_COMMANDS.some(pattern => pattern.test(command))) throw new Error('Unsupported MPS control command');
    return command;
}
export function classifyMpsReply(text) {
    const value = String(text ?? '').trim();
    // The product's own grammar (mps.mjs parseMpsSmReply): an integer 1..100, optionally with a zero-only fraction.
    if (/^(?:100|[1-9][0-9]?)(?:\.0+)?$/.test(value)) return { form: 'integer-percentage', value: Number(value) };
    const memory = /^([1-9][0-9]*)([MG])$/.exec(value);
    if (memory) return { form: 'integer-with-M-or-G', bytes: Number(memory[1]) * (memory[2] === 'M' ? MIB : 1024 * MIB) };
    if (value === '') return { form: 'empty' };
    return { form: 'other', text: value.slice(0, 200) };
}

// The run-as-the-client control helper of the P4 case (plan §18.10): the same
// image and keep-id mapping as a client, the control binary bound read-only
// at /x, the verified read-only driver libraries, and the pipe bind either
// writable or read-only. It is a recorded, owned nested container.
// MPS eligibility needs a non-root numeric UID:GID image user; the helper takes the
// same one for its keep-id mapping.
export const MPS_CLIENT_USER = /^([1-9][0-9]{0,9}):([1-9][0-9]{0,9})$/;
export function controlHelperRunArgv({ name, image, pipeDirectory, writable, runId, user = '1000:1000' }) {
    const owner = MPS_CLIENT_USER.exec(user);
    if (!owner || !/^hwl-[a-f0-9]{12}-ctl-(?:rw|ro)$/.test(name) || !/^[a-z0-9][a-z0-9.-]*(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/.test(image)
        || !/^\/run\/ploinky\/mps\/pipe-[a-f0-9]{32}$/.test(pipeDirectory) || !/^[a-f0-9]{32}$/.test(runId)) throw new Error('Invalid control helper invocation');
    return ['run', '--detach', '--name', name, '--pull=never', `--userns=keep-id:uid=${owner[1]},gid=${owner[2]}`, '--network', 'none', '--pids-limit', '64', '--memory', '256m',
        '--cgroups=enabled', '--cgroupns=private', '--cgroup-parent=/ploinky/system',
        '--label', `io.assistos.ploinky.hwl-run=${runId}`,
        '--volume', `${MPS_TOOL_DIRECTORY}/nvidia-cuda-mps-control:/x:ro`,
        '--volume', `${MPS_LIBRARY_DIRECTORY}:${MPS_LIBRARY_DIRECTORY}:ro`,
        '--volume', `${pipeDirectory}:${MPS_CLIENT_PIPE}:z,${writable ? 'rw' : 'ro'}`,
        image, 'node', '-e', 'setInterval(()=>{},3600000)'];
}
// One control command through a helper: the command is a positional word, the
// shell script is constant.
export function controlHelperExecArgv({ containerId, command }) {
    if (!/^[a-f0-9]{64}$/.test(containerId)) throw new Error('Invalid control helper identity');
    assertMpsControlCommand(command);
    return ['container', 'exec', '--env', `CUDA_MPS_PIPE_DIRECTORY=${MPS_CLIENT_PIPE}`, '--env', `LD_LIBRARY_PATH=${MPS_LIBRARY_DIRECTORY}`,
        containerId, 'sh', '-c', 'printf "%s\\n" "$1" | /x', 'sh', command];
}

// ---------------------------------------------------------------------------
// In-Box programs.

// The administrator request through the Router's own route, as the product's
// local operator channel makes it: a session cookie minted by the same
// workspace key the Router verifies (the CLI's `local:admin` session) and the
// control-origin CSRF token for that session. GET reads the state and the
// store token; POST carries one hardware-limits action (set, clear, apply).
export const ADMIN_REQUEST = String.raw`
const http=require('node:http');
const method=process.argv[1];const bodyText=String(process.argv[2]||'');
if(!['GET','POST'].includes(method)||Buffer.byteLength(bodyText)>16384)throw Error('Invalid request');
(async()=>{
const {mintSessionJwt}=await import('/opt/ploinky/cli/server/auth/localService.js');
const {mintAdminCsrfToken}=await import('/opt/ploinky/cli/server/adminControlSecurity.js');
const token=mintSessionJwt({id:'local:admin',username:'admin',name:'Local CLI',email:'',roles:['user','admin']},1,{channel:'cli'});
const payload=JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString('utf8'));
const host='127.0.0.1:8080';const origin='http://'+host;
const headers={host,cookie:'ploinky_jwt='+token,accept:'application/json'};
if(method==='POST'){headers.origin=origin;headers['content-type']='application/json';headers['content-length']=String(Buffer.byteLength(bodyText));
headers['x-ploinky-csrf-token']=mintAdminCsrfToken({sessionId:payload.sid,req:{headers:{host},socket:{}}});}
const reply=await new Promise((resolve,reject)=>{const chunks=[];let size=0;
const request=http.request({host:'127.0.0.1',port:8080,method,path:'/api/marketplace/hardware-limits',headers},(response)=>{
response.on('data',(chunk)=>{size+=chunk.length;if(size>262144){request.destroy(new Error('reply too large'));return;}chunks.push(chunk);});
response.on('end',()=>resolve({status:response.statusCode,text:Buffer.concat(chunks).toString('utf8')}));response.on('error',reject);});
request.on('error',reject);request.setTimeout(840000,()=>request.destroy(new Error('timeout')));
if(method==='POST')request.write(bodyText);request.end();});
process.stdout.write(JSON.stringify(reply));
})().catch((error)=>{process.stdout.write(JSON.stringify({error:String(error&&error.message||error).slice(0,300)}));process.exit(3);});`;

// Everything observable about the owned MPS generation, read-only: the
// private state file, the daemon's process facts as the Box sees them, and
// the raw replies of the three read-only control queries, which are the
// sanitized fixture plan §18.8 asks LIVE-P1 to capture.
export const MPS_OBSERVE = String.raw`
const fs=require('node:fs');const cp=require('node:child_process');
const root='/run/ploinky/mps';const out={state:null,daemon:null,control:null};
const one=(v,n)=>String(v==null?'':v).replace(/[^\x20-\x7e]+/g,' ').trim().slice(0,n||200);
const readBounded=(file,max)=>{const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const st=fs.fstatSync(fd);
if(!st.isFile()||st.uid!==process.getuid()||st.size>max)throw Error('Unsafe file');return {text:fs.readFileSync(fd,'utf8'),st};}finally{fs.closeSync(fd);}};
let state=null;
try{const read=readBounded(root+'/state.json',65536);if((read.st.mode&0o777)!==0o600)throw Error('Unsafe state mode');state=JSON.parse(read.text);}catch(e){if(e.code!=='ENOENT')throw e;}
if(state){out.state={schema:state.schema,status:state.status,daemonGeneration:state.daemonGeneration||null,configurationGeneration:state.configurationGeneration||null,
serverDefault:state.serverDefault||null,pipeDirectory:state.pipeDirectory||null,logDirectory:state.logDirectory||null,daemon:state.daemon||null,
tools:state.tools?{control:state.tools.control||null,server:state.tools.server||null}:null,
pendingClients:(state.pendingClients||[]).map((c)=>c.key),oldClients:(state.oldClients||[]).map((c)=>c.key),desiredClients:(state.desiredClients||[]).map((c)=>c.key),
lastReadback:state.lastReadback&&typeof state.lastReadback==='object'?Object.fromEntries(['at','sm','memory','servers'].filter((k)=>state.lastReadback[k]!=null).map((k)=>[k,k==='at'?Number(state.lastReadback[k])||0:one(state.lastReadback[k],64)])):null};}
if(state&&state.daemon&&Number.isSafeInteger(state.daemon.pid)){
const pid=state.daemon.pid;const info={pid};
try{const stat=fs.readFileSync('/proc/'+pid+'/stat','utf8');info.startTime=stat.slice(stat.lastIndexOf(')')+2).split(' ')[19];
info.status=fs.readFileSync('/proc/'+pid+'/status','utf8').split('\n').filter((l)=>/^(Uid|Gid):/.test(l));
info.cgroup=fs.readFileSync('/proc/'+pid+'/cgroup','utf8').trim();
const exe=fs.statSync('/proc/'+pid+'/exe');info.exe={dev:exe.dev,ino:exe.ino};
info.pipeEnvMatches=fs.readFileSync('/proc/'+pid+'/environ').toString().split('\0').includes('CUDA_MPS_PIPE_DIRECTORY='+state.pipeDirectory);
info.alive=true;}catch(e){info.alive=false;info.error=String(e.code||e.message).slice(0,64);}
out.daemon=info;
if(info.alive){const env={PATH:'/usr/local/nvidia/bin:/usr/bin:/bin',LD_LIBRARY_PATH:'/usr/local/nvidia/lib64',CUDA_MPS_PIPE_DIRECTORY:state.pipeDirectory,CUDA_MPS_LOG_DIRECTORY:state.logDirectory};
const ask=(command)=>{const r=cp.spawnSync('/usr/local/nvidia/bin/nvidia-cuda-mps-control',[],{input:command+'\n',encoding:'utf8',env,timeout:5000,maxBuffer:8192});
return {command,status:r.status,signal:r.signal,stdout:String(r.stdout||'').slice(0,2048),stderr:String(r.stderr||'').slice(0,512),error:r.error?String(r.error.code||r.error.message).slice(0,64):null};};
out.control=[ask('get_default_active_thread_percentage'),ask('get_default_device_pinned_mem_limit 0'),ask('get_server_list')];}}
process.stdout.write(JSON.stringify(out));`;

// What a failed MPS case needs from inside the Box before the Box is destroyed, read-only
// and bounded: the private state file (status, daemon, pending clients, last problem and
// its cause) and, from the owned log directories, bounded tails of the daemon's control
// and server logs. It sends no control command, starts nothing and writes nothing.
export const MPS_FAILURE_EVIDENCE = String.raw`
const fs=require('node:fs');
const root='/run/ploinky/mps';const FILE_BYTES=6144;const TOTAL_BYTES=40960;
const one=(v,n)=>String(v==null?'':v).replace(/[^\x20-\x7e]+/g,' ').trim().slice(0,n||200);
const out={state:null,daemon:null,logs:[],entries:[],omittedLogFiles:0,problems:[]};
const note=(where,e)=>out.problems.push(where+': '+one(e&&(e.code||e.message)||e,80));
const open=(file)=>fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
let state=null;
try{const fd=open(root+'/state.json');try{const st=fs.fstatSync(fd);if(!st.isFile()||st.uid!==process.getuid()||st.size>65536)throw Error('Unsafe state file');state=JSON.parse(fs.readFileSync(fd,'utf8'));}finally{fs.closeSync(fd);}}catch(e){if(e.code!=='ENOENT')note('state',e);}
if(state){const lp=state.lastProblem;const cause=lp&&lp.cause?{step:one(lp.cause.step,40),errorClass:one(lp.cause.errorClass,64),code:lp.cause.code==null?null:one(lp.cause.code,64),message:one(lp.cause.message,400)}:null;
out.state={schema:state.schema,status:one(state.status,32),transitionId:state.transitionId?one(state.transitionId,64):null,daemonGeneration:state.daemonGeneration||null,configurationGeneration:state.configurationGeneration||null,
serverDefault:state.serverDefault||null,pipeDirectory:state.pipeDirectory||null,logDirectory:state.logDirectory||null,daemon:state.daemon||null,
pendingClients:(Array.isArray(state.pendingClients)?state.pendingClients:[]).slice(0,32).map((c)=>({key:one(c.key,128),phase:one(c.phase,32),containerId:c.containerId?String(c.containerId).slice(0,12):null})),
oldClients:(Array.isArray(state.oldClients)?state.oldClients:[]).slice(0,32).map((c)=>one(c.key,128)),drainedClients:Array.isArray(state.drainedClients)?state.drainedClients.length:0,
lastProblem:lp?{code:one(lp.code,64),message:one(lp.message,300),cause}:null,
lastReadback:state.lastReadback&&typeof state.lastReadback==='object'?Object.fromEntries(['at','sm','memory','servers'].filter((k)=>state.lastReadback[k]!=null).map((k)=>[k,k==='at'?Number(state.lastReadback[k])||0:one(state.lastReadback[k],64)])):null};}
if(state&&state.daemon&&Number.isSafeInteger(state.daemon.pid)){const pid=state.daemon.pid;const info={pid};
try{const stat=fs.readFileSync('/proc/'+pid+'/stat','utf8');info.startTime=stat.slice(stat.lastIndexOf(')')+2).split(' ')[19];info.alive=true;
info.status=fs.readFileSync('/proc/'+pid+'/status','utf8').split('\n').filter((l)=>/^(Uid|Gid):/.test(l));info.cgroup=fs.readFileSync('/proc/'+pid+'/cgroup','utf8').trim();}catch(e){info.alive=info.alive===true;info.error=one(e.code||e.message,64);}
out.daemon=info;}
let entries=[];try{entries=fs.readdirSync(root).sort();}catch(e){if(e.code!=='ENOENT')note('root',e);}
out.entries=entries.slice(0,64);
const logDirectories=[...new Set([...(state&&typeof state.logDirectory==='string'&&state.logDirectory.startsWith(root+'/')?[state.logDirectory.slice(root.length+1)]:[]),...entries.filter((n)=>/^log-[a-f0-9]{32}$/.test(n))])].filter((n)=>/^log-[a-f0-9]{32}$/.test(n)).slice(0,4);
let total=0;
for(const name of logDirectories){const directory=root+'/'+name;const item={directory,files:[]};
try{const st=fs.lstatSync(directory);if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==process.getuid())throw Error('Unsafe log directory');
for(const file of fs.readdirSync(directory).sort().slice(0,16)){
if(!/^[A-Za-z0-9._-]{1,64}$/.test(file))continue;
if(total>=TOTAL_BYTES){out.omittedLogFiles+=1;continue;}
try{const fd=open(directory+'/'+file);try{const fst=fs.fstatSync(fd);if(!fst.isFile()||fst.uid!==process.getuid()){item.files.push({name:file,unsafe:true});continue;}
const length=Math.min(fst.size,FILE_BYTES,TOTAL_BYTES-total);const buffer=Buffer.alloc(length);if(length>0)fs.readSync(fd,buffer,0,length,fst.size-length);total+=length;
item.files.push({name:file,size:fst.size,tail:buffer.toString('utf8').replace(/[^\x20-\x7e\n]+/g,' ')});}finally{fs.closeSync(fd);}}catch(e){item.files.push({name:file,error:one(e.code||e.message,64)});}}
}catch(e){item.error=one(e.code||e.message,64);}
out.logs.push(item);}
process.stdout.write(JSON.stringify(out));`;

// Read-only facts for a LIVE-P1 whose Box reports sharing unavailable: the
// grant marker as mounted (state, MPS fields and the identities it expects),
// the bound tool files as the Box stats them (to compare with those), and one bounded nvidia-smi observation with the
// loader path the Box image lacks and one with the bare environment, so the
// real cause is on the record before the case stops. Nothing is signalled,
// started or written.
export const GPU_GRANT_FACTS = String.raw`
const fs=require('node:fs');const cp=require('node:child_process');
const out={marker:null,tools:{},smi:{}};
const one=(v,n)=>String(v==null?'':v).replace(/[^\x20-\x7e]+/g,' ').trim().slice(0,n||200);
try{const m=JSON.parse(fs.readFileSync('/etc/ploinky-box-gpu-grant.json','utf8'));
out.marker={state:m.state,reason:m.reason?one(m.reason,300):null,fingerprint:m.fingerprint||null,driverVersion:m.driverVersion||null,devices:Array.isArray(m.devices)?m.devices.length:null,
mps:m.mps?Object.keys(m.mps).sort():null,mpsProblem:m.mpsProblem?one(m.mpsProblem,400):null,
mpsExpected:m.mps?Object.fromEntries(['control','server'].map((k)=>[k,m.mps[k]?{dev:m.mps[k].dev,ino:m.mps[k].ino,size:m.mps[k].size,mtimeMs:m.mps[k].mtimeMs,sha256:m.mps[k].sha256}:null])):null};}catch(e){out.marker={error:one(e.code||e.message,64)};}
for(const f of ['/usr/local/nvidia/bin/nvidia-smi','/usr/local/nvidia/bin/nvidia-cuda-mps-control','/usr/local/nvidia/bin/nvidia-cuda-mps-server']){
try{const st=fs.statSync(f);out.tools[f]={dev:st.dev,ino:st.ino,size:st.size,mtimeMs:st.mtimeMs,nlink:st.nlink,mode:(st.mode&0o777).toString(8)};
if(/mps/.test(f)&&st.isFile()&&st.size>0&&st.size<=67108864)out.tools[f].sha256=require('node:crypto').createHash('sha256').update(fs.readFileSync(f)).digest('hex');}catch(e){out.tools[f]={error:one(e.code||e.message,64)};}}
const smi=(env)=>{const r=cp.spawnSync('/usr/local/nvidia/bin/nvidia-smi',['-i','0','--query-gpu=index,uuid,name,memory.total,driver_version','--format=csv,noheader,nounits'],{encoding:'utf8',env,timeout:5000,maxBuffer:8192});
return {status:r.status,signal:r.signal||null,error:r.error?one(r.error.code||r.error.message,64):null,stdout:one(r.stdout,300),stderr:one(r.stderr,300)};};
out.smi.bare=smi({PATH:'/usr/local/nvidia/bin:/usr/bin:/bin'});
out.smi.withLoaderPath=smi({PATH:'/usr/local/nvidia/bin:/usr/bin:/bin',LD_LIBRARY_PATH:'/usr/local/nvidia/lib64'});
process.stdout.write(JSON.stringify(out));`;

// The crash case's only mutation of the MPS generation: SIGKILL of the one
// control daemon, after the program itself re-proves its identity from the
// private state file and /proc (start time, uid, executable identity, the
// /ploinky/core cgroup, the pipe directory in its environment). Anything
// that does not match refuses without signalling; nothing else is signalled.
export const MPS_KILL_OWNED_DAEMON = String.raw`
const fs=require('node:fs');
const pid=Number(process.argv[1]);const start=String(process.argv[2]);
if(!Number.isSafeInteger(pid)||pid<=1||!/^[0-9]+$/.test(start))throw Error('Invalid daemon identity');
const refuse=(reason)=>{process.stdout.write(JSON.stringify({killed:false,refused:reason}));process.exit(0);};
const fd=fs.openSync('/run/ploinky/mps/state.json',fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
let state;try{const st=fs.fstatSync(fd);if(!st.isFile()||st.uid!==process.getuid()||st.size>65536||(st.mode&0o777)!==0o600)refuse('state file unsafe');state=JSON.parse(fs.readFileSync(fd,'utf8'));}finally{fs.closeSync(fd);}
const d=state.daemon;if(!d||d.pid!==pid||String(d.startTime)!==start)refuse('state does not name this daemon');
let stat;try{stat=fs.readFileSync('/proc/'+pid+'/stat','utf8');}catch(e){refuse('process absent');}
if(stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]!==start)refuse('start time differs');
const status=fs.readFileSync('/proc/'+pid+'/status','utf8');const uid=process.getuid();
if(!new RegExp('^Uid:\\s+'+uid+'\\s+'+uid+'\\s+'+uid+'\\s+'+uid+'\\s*$','m').test(status))refuse('uid differs');
const exe=fs.statSync('/proc/'+pid+'/exe');if(exe.dev!==d.executableDev||exe.ino!==d.executableIno)refuse('executable differs');
if(fs.readFileSync('/proc/'+pid+'/cgroup','utf8').trim()!=='0::/ploinky/core')refuse('cgroup differs');
if(!fs.readFileSync('/proc/'+pid+'/environ').toString().split('\0').includes('CUDA_MPS_PIPE_DIRECTORY='+state.pipeDirectory))refuse('pipe environment differs');
process.kill(pid,'SIGKILL');process.stdout.write(JSON.stringify({killed:true,pid,start}));`;

// ---------------------------------------------------------------------------
// The pinned GPU facts of an apparatus-mps execution profile: the device the
// plan's evidence names, the three NVIDIA tools by canonical path and content,
// and the CUDA probe file by digest. The runner rechecks every one of them on
// the host before it acts.
export function validateGpuProfile(profile) {
    const gpu = profile.gpu;
    // The local-llm blocks bring no CUDA probe of their own: their cases ask the product.
    const llm = profile.llm !== undefined;
    keys(gpu, ['uuid', 'name', 'driverVersion', 'memoryMiB', 'expectedSmCount', 'smi', 'mpsControl', 'mpsServer', ...(llm ? [] : ['probe'])], 'GPU pins');
    if (!/^GPU-[a-fA-F0-9-]{8,64}$/.test(gpu.uuid) || !bounded(gpu.name, 256) || !/^[0-9]+(?:\.[0-9]+)+$/.test(gpu.driverVersion)
        || !Number.isInteger(gpu.memoryMiB) || gpu.memoryMiB < 1024 || gpu.memoryMiB > 1048576
        || !Number.isInteger(gpu.expectedSmCount) || gpu.expectedSmCount < 1 || gpu.expectedSmCount > 1024) throw new Error('Invalid GPU device pins');
    for (const name of ['smi', 'mpsControl', 'mpsServer']) {
        keys(gpu[name], ['path', 'digest'], `GPU tool ${name}`);
        if (!absolute(gpu[name].path) || !HASH.test(gpu[name].digest)) throw new Error(`Invalid GPU tool pin ${name}`);
    }
    if (llm) {
        if (!profile.provision?.gpu || profile.provision.gpu.uuid !== gpu.uuid) throw new Error('The GPU pins and the GPU provision plan disagree');
        if (!(profile.fixtures?.llm?.ref === 'local-llms/local-llm')) throw new Error('The local-llm cases need the local-llm fixture reference');
        return gpu;
    }
    keys(gpu.probe, ['sourcePath', 'digest'], 'GPU probe pin');
    if (!absolute(gpu.probe.sourcePath) || !HASH.test(gpu.probe.digest) || !gpu.probe.sourcePath.startsWith(`${profile.source.root}/`)) throw new Error('Invalid GPU probe pin');
    if (!profile.provision?.gpu || profile.provision.gpu.uuid !== gpu.uuid || profile.provision.gpu.probe.sourcePath !== gpu.probe.sourcePath || profile.provision.gpu.probe.digest !== gpu.probe.digest) {
        throw new Error('The GPU pins and the GPU provision plan disagree');
    }
    if (!(profile.fixtures?.gpu?.ref === 'hwlfixture/probe')) throw new Error('The GPU cases need the probe fixture reference');
    return gpu;
}
