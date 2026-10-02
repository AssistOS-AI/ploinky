// Reviewed, fixed programs, budgets and validators for the apparatus-local-llm
// (LIVE-L1, LIVE-L2) and apparatus-vllm (LIVE-L3) cases. Values reach a program
// only as validated argv words, never by interpolation into executable source.
// Test-only; nothing here runs a process.
//
// The cases drive the local-llm agent the way the product does: the administrator
// path (the hardware-limits store and Apply) for its budgets, and the agent's own
// MCP tools through the Router, with the same local operator session the CLI's
// `ploinky client tool` uses, for installs, Runs, Stops and the smoke prompt.
import { MIB } from './liveGpuCommands.mjs';
import { bounded, keys } from './liveCommon.mjs';
import { resolveMemoryPercent } from '../../cli/sandbox/hardwareLimits/resolve.mjs';
import { cpuMaxMatches } from '../../cli/sandbox/hardwareLimits/cpuQuota.mjs';
import { LLM_AGENT, LLM_MODELS, LLM_REF, LLM_REPOSITORY } from './liveLlmNames.mjs';

export { LLM_AGENT, LLM_MODELS, LLM_REF, LLM_REPOSITORY };
export const GIB = 1024 * MIB;

// The owned agents of the local-llm fixture, in the shape the shared GPU case kit takes
// (liveGpuCases.mjs): one agent, which is a share client, and no unrelated CPU agent.
export const LLM_FIXTURE = Object.freeze({
    repository: LLM_REPOSITORY, refs: Object.freeze({ llm: LLM_REF }), names: Object.freeze({ llm: LLM_AGENT }),
    roles: Object.freeze(['llm']), clients: Object.freeze(['llm']), unrelated: null,
});

// LIVE-L1: the plan's 4 CPU / 25 % RAM / 50 % GPU. The percentages are the administrator's
// (the store holds percentages), resolved against the Box envelope by the product.
export const LLM_BUDGET = Object.freeze({ cpus: 4, memoryPercent: 25, gpu: Object.freeze({ smPercent: 50, vramPercent: 50 }) });
// The model needs the agent's RAM view to cover its own 768 MiB, the 1 GiB margin and the agent's
// own use; below this the L1 budget could not run it on this host (BLOCKED, not a failed budget).
export const L1_MIN_RAM_BYTES = 3 * GIB;

// LIVE-L2: a RAM budget that is known to be insufficient, not merely small. Admission refuses a
// llama.cpp Run unless the agent's available RAM exceeds its 768 MiB need plus a 1 GiB margin
// (available - 1 GiB < 768 MiB for any available RAM below 1.75 GiB). The saved cap is therefore
// kept at or below 1280 MiB, and at least 640 MiB so the controller and its tool processes live.
export const INSUFFICIENT_RAM = Object.freeze({ minCapBytes: 640 * MIB, maxCapBytes: 1280 * MIB });
export function insufficientMemoryPercent(envelopeBytes) {
    let best = null;
    for (let percent = 1; percent <= 100; percent += 1) {
        let capBytes;
        try { capBytes = resolveMemoryPercent(percent, envelopeBytes); } catch { continue; }
        if (capBytes > INSUFFICIENT_RAM.maxCapBytes) break;
        if (capBytes >= INSUFFICIENT_RAM.minCapBytes) best = { percent, capBytes };
    }
    return best;
}

// LIVE-L3: the share vLLM runs under, chosen from production's admission arithmetic for the pinned
// Qwen3-4B-AWQ snapshot on the 6144-MiB device (admitVllm): weights 2,681,909,887 B + KV cache for
// the recommended 8192 tokens (147,456 B per token = 1,207,959,552 B) + vLLM's 768 MiB overhead
// = 4,695,175,807 B must fit utilization x device x 0.94, so the utilization is at least 0.78;
// admission derives that from (free - 512 MiB) / device, so the share is at least
// 0.78 x 6144 + 512 = 5304 MiB (86.3 %). 90 % (5529 MiB) gives utilization 0.81 with room to
// spare; 50 % (3072 MiB) does not fit. Stage 1 calibrates under this very share, and stage 2
// verifies through the product's public admission that it fits before it starts the model.
export const VLLM_SHARE = Object.freeze({ smPercent: 100, vramPercent: 90 });

// ---------------------------------------------------------------------------
// The local-llm agent's MCP tools, called in the Box through the Router.

export const LLM_TOOL_NAMES = Object.freeze(['local_llm_overview', 'local_llm_status', 'local_llm_run', 'local_llm_stop', 'local_llm_runner_install', 'local_llm_test_prompt']);
export const LLM_TOOL_OUTPUT_LIMIT = 60000;
export const LLM_MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
export const LLM_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

// The program validates every argument again (it is the in-Box side of the allowlist), asks the
// Router for the agent that offers the tool, calls it and prints one bounded JSON document:
// {ok:true, agent, result} or {ok:false, error:{code, message, details?}}. A refusal of the
// tool (an MCP error, or a document with ok:false) is data, not an exception.
export const LLM_TOOL_CALL = String.raw`
const ALLOWED={local_llm_overview:['preview'],local_llm_status:['sinceSeq'],local_llm_run:['requestId','modelId','runnerId','params','replace'],local_llm_stop:[],local_llm_runner_install:['runnerId','acceptLicence'],local_llm_test_prompt:['prompt','maxTokens']};
const out=(value)=>{let text=JSON.stringify(value);if(text.length>60000)text=JSON.stringify({ok:false,error:{code:'too_large',message:'The reply exceeds 60000 characters'}});process.stdout.write(text);};
const fail=(message,code)=>{out({ok:false,error:{code:code||'invalid',message:String(message).slice(0,400)}});process.exit(3);};
const [tool,argsText,viewText]=process.argv.slice(1);
if(!Object.hasOwn(ALLOWED,tool))fail('Unsupported tool');
let args,view;try{args=JSON.parse(argsText||'{}');view=JSON.parse(viewText||'{}');}catch{fail('Invalid JSON');}
if(!args||typeof args!=='object'||Array.isArray(args)||Buffer.byteLength(argsText||'')>4096||Object.keys(args).some((k)=>!ALLOWED[tool].includes(k)))fail('Invalid arguments');
const id=/^[a-z0-9][a-z0-9._-]{0,127}$/;
if(tool==='local_llm_run'&&(!/^[A-Za-z0-9_-]{8,64}$/.test(args.requestId)||!id.test(args.modelId)||!id.test(args.runnerId)||(args.replace!==undefined&&typeof args.replace!=='boolean')||(args.params!==undefined&&(!args.params||typeof args.params!=='object'||Array.isArray(args.params)))))fail('Invalid run request');
if(tool==='local_llm_overview'&&args.preview!==undefined&&(!args.preview||!id.test(args.preview.modelId)||!id.test(args.preview.runnerId)||(args.preview.params!==undefined&&(typeof args.preview.params!=='object'||Array.isArray(args.preview.params)))))fail('Invalid preview request');
if(tool==='local_llm_runner_install'&&(args.runnerId!=='vllm'||args.acceptLicence!==false))fail('Only vllm may be installed, and without a licence acceptance');
if(tool==='local_llm_test_prompt'&&(typeof args.prompt!=='string'||args.prompt.length<1||args.prompt.length>200||!Number.isInteger(args.maxTokens)||args.maxTokens<1||args.maxTokens>512))fail('Invalid test prompt');
if(tool==='local_llm_status'&&args.sinceSeq!==undefined&&!Number.isInteger(args.sinceSeq))fail('Invalid status request');
const pick=(o,keys)=>{if(!o||typeof o!=='object')return o??null;const r={};for(const k of keys)if(o[k]!==undefined)r[k]=o[k];return r;};
const admission=(a)=>a?{status:a.status,reason:a.reason?String(a.reason).slice(0,400):null,reasonCode:a.reasonCode??null,estimate:pick(a.estimate,['gpuBytes','ramBytes','gpuMemoryUtilization','weightsBytes','kvBytes','basis'])}:null;
const deployment=(d)=>d?{id:d.id,modelId:d.modelId,runnerId:d.runnerId,profile:d.profile,phase:d.phase,error:d.error?String(d.error).slice(0,400):null,pausedReason:d.pausedReason??null,admission:admission(d.admission),artifact:pick(d.artifact,['type','repo','file','revision','commit','size','sha256','quantization']),artifactFiles:Array.isArray(d.artifact&&d.artifact.files)?d.artifact.files.map((f)=>pick(f,['path','size','sha256'])).slice(0,64):undefined,runner:pick(d.runner,['pid','port','startedAt']),download:pick(d.download,['bytes','total','rate','etaSeconds']),createdAt:d.createdAt,updatedAt:d.updatedAt}:null;
const project=(name,result)=>{
 if(name==='local_llm_overview'){const hw=result.hardware||{};const models=Array.isArray(result.models)?result.models:[];const wanted=models.find((m)=>m&&m.id===view.model);
  return {profile:result.profile,limits:result.limits??null,
   hardware:{gpu:pick(hw.gpu,['available','name','driverVersion','totalBytes','usedBytes','freeBytes','memoryModel','state','reason','device']),memory:pick(hw.memory,['totalBytes','availableBytes']),cpus:hw.cpus??null,cgroupMemory:hw.cgroupMemory??null},
   runners:(result.runners||[]).map((r)=>({...pick(r,['id','displayName','supported','installed','version','enabled','disabledReason','unsupportedReason','reason','totalBytes','files']),install:r.install?{phase:r.install.state&&r.install.state.phase,installing:r.install.installing,installed:r.install.installed,version:r.install.version,download:r.install.state&&r.install.state.download,error:r.install.state&&r.install.state.error?String(r.install.state.error).slice(0,300):null,pausedReason:r.install.state&&r.install.state.pausedReason,rebuild:r.install.state&&r.install.state.rebuild,cache:r.install.cache}:undefined})),
   model:wanted?{id:wanted.id,sources:wanted.sources,weights:Object.fromEntries(Object.entries(wanted.weights||{}).map(([k,w])=>[k,{size:w.size,download:w.download,bytesNeeded:w.acquisition&&w.acquisition.bytesNeeded,runners:w.runners}])),runners:Object.fromEntries(Object.entries(wanted.runners||{}).map(([k,r])=>[k,{format:r.format,size:r.size,params:r.params,admission:admission(r.admission)}]))}:null,
   deployment:deployment(result.deployment),
   preview:result.preview?{modelId:result.preview.modelId,runnerId:result.preview.runnerId,error:result.preview.error??null,params:result.preview.params??null,admission:admission(result.preview.admission)}:undefined,gatewayModel:result.gatewayModel};}
 if(name==='local_llm_status'){return {phase:result.phase,profile:result.profile??null,deployment:deployment(result.deployment),logs:(result.logs||[]).slice(-30).map((l)=>({seq:l.seq,text:String(l.line??l.text??l.message??'').slice(0,240)})),nextSeq:result.nextSeq,runnerReport:pick(result.runnerReport,['modelMiB','kvMiB','kvTokens','computeMiB','totalMiB','offloaded','device']),memoryGuard:result.memoryGuard??null};}
 return result;};
(async()=>{
 const {mintSessionJwt}=await import('/opt/ploinky/cli/server/auth/localService.js');
 const {createAgentClient}=await import('/opt/ploinky/Agent/client/MCPBrowserClient.js');
 const token=mintSessionJwt({id:'local:admin',username:'admin',name:'Local CLI',email:'',roles:['user','admin']},1,{channel:'cli'});
 const client=createAgentClient('http://127.0.0.1:8080/mcp',{requestHeaders:{cookie:'ploinky_jwt='+token}});
 try{
  const tools=await client.listTools();
  const agents=[...new Set(tools.filter((t)=>t&&t.name===tool).map((t)=>(t.annotations&&t.annotations.router&&t.annotations.router.agent)||t.agent).filter(Boolean))];
  if(agents.length!==1)fail('The tool '+tool+' is offered by '+agents.length+' agents','agent_not_found');
  let timer;const reply=await Promise.race([client.callTool(tool,args,{agent:agents[0]}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('timeout')),285000);})]).finally(()=>clearTimeout(timer));
  const text=reply&&Array.isArray(reply.content)?(reply.content.find((c)=>c&&c.type==='text')||{}).text:undefined;
  const refusal=(raw)=>{let doc=null;try{doc=JSON.parse(raw);}catch{doc=null;}
   if(doc&&typeof doc==='object'&&typeof doc.error==='string')return {ok:false,agent:agents[0],error:{code:doc.error.slice(0,80),message:String(doc.message||doc.error).slice(0,600),details:doc.details&&doc.details.admission?{admission:admission(doc.details.admission)}:undefined}};
   const message=String(raw||'The tool failed').replace(/^MCP error -?\d+:\s*/,'');const code=(/\b(admission_[a-z_]+|busy|runner_[a-z_]+|licence_required|invalid_[a-z_]+)\b/.exec(message)||[])[1]||'tool_error';
   return {ok:false,agent:agents[0],error:{code,message:message.slice(0,600)}};};
  if(reply&&reply.isError){out(refusal(text));return;}
  const result=reply&&reply.json&&typeof reply.json==='object'?reply.json:(text!==undefined?JSON.parse(text):reply);
  if(result&&result.ok===false){out(refusal(JSON.stringify(result)));return;}
  out({ok:true,agent:agents[0],result:project(tool,result)});
 }finally{await client.close().catch(()=>{});}
})().catch((e)=>{out({ok:false,error:{code:'transport',message:String(e&&e.message||e).slice(0,400)}});process.exit(3);});`;

// One tool call as a bounded argv word list for `container exec <BOX> node -e PROGRAM ...`.
export function llmToolWords(tool, args = {}, view = {}) {
    if (!LLM_TOOL_NAMES.includes(tool)) throw new Error('Unsupported local-llm tool');
    const argsText = JSON.stringify(args); const viewText = JSON.stringify(view);
    if (Buffer.byteLength(argsText) > 4096 || Buffer.byteLength(viewText) > 1024) throw new Error('local-llm tool arguments exceed their bound');
    if (view.model !== undefined && !LLM_MODEL_ID.test(view.model)) throw new Error('Invalid local-llm model view');
    return [tool, argsText, viewText];
}

// ---------------------------------------------------------------------------
// In-agent programs, started with `container exec <AGENT>` in the nested engine.

// The runner processes of the agent, found by their executable (llama.cpp) or their module
// (vLLM), with the names of their environment and the values of the CUDA variables only: never
// an argument (llama-server carries its API key there) and never another value.
export const LLM_RUNNER_PROCESSES = String.raw`
const fs=require('node:fs');const matcher=process.argv[1];
if(!['llama-server','vllm'].includes(matcher))throw Error('Invalid runner matcher');
const out=[];
for(const name of fs.readdirSync('/proc').filter((n)=>/^[1-9][0-9]*$/.test(n)).slice(0,4096)){
 try{
  const exe=fs.readlinkSync('/proc/'+name+'/exe');const cmd=fs.readFileSync('/proc/'+name+'/cmdline','utf8').split('\0');
  const hit=matcher==='llama-server'?exe.endsWith('/llama-server'):cmd.includes('vllm.entrypoints.openai.api_server');
  if(!hit)continue;
  const env=fs.readFileSync('/proc/'+name+'/environ','utf8').split('\0').filter(Boolean);
  const at=(e)=>e.indexOf('=');
  const stat=fs.readFileSync('/proc/'+name+'/stat','utf8');const tail=stat.slice(stat.lastIndexOf(')')+2).split(' ');
  const status=fs.readFileSync('/proc/'+name+'/status','utf8');const uid=(/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m.exec(status)||[]).slice(1,5).map(Number);
  out.push({pid:Number(name),exe,ppid:Number(tail[1]),start:tail[19],uid,envNames:env.map((e)=>e.slice(0,at(e))).sort().slice(0,96),cuda:Object.fromEntries(env.filter((e)=>e.startsWith('CUDA_')).map((e)=>[e.slice(0,at(e)),e.slice(at(e)+1,at(e)+161)]))});
 }catch(e){if(!['ENOENT','ESRCH','EACCES','EPERM'].includes(e.code))throw e;}
}
process.stdout.write(JSON.stringify({processes:out}));`;

// The digests of the image files that identify the runner: llama.cpp's server, the image's source
// contract and its runner lock. A fixed list, read-only, streamed.
export const LLM_IMAGE_FILES = Object.freeze(['/opt/llama.cpp/llama-server', '/opt/local-llm/source.contract', '/opt/local-llm/runners.lock.json']);
export const LLM_IMAGE_DIGESTS = String.raw`
const fs=require('node:fs');const crypto=require('node:crypto');
const files=['/opt/llama.cpp/llama-server','/opt/local-llm/source.contract','/opt/local-llm/runners.lock.json'];
const result={};
for(const file of files){try{const hash=crypto.createHash('sha256');let size=0;const fd=fs.openSync(file,fs.constants.O_RDONLY);try{const buffer=Buffer.alloc(1<<20);for(;;){const n=fs.readSync(fd,buffer,0,buffer.length,null);if(!n)break;size+=n;hash.update(buffer.subarray(0,n));}}finally{fs.closeSync(fd);}result[file]={sha256:hash.digest('hex'),size};}catch(e){result[file]=e.code==='ENOENT'?null:{error:String(e.code||e.message).slice(0,40)};}}
const contract=(()=>{try{return fs.readFileSync('/opt/local-llm/source.contract','utf8').slice(0,2000);}catch{return null;}})();
process.stdout.write(JSON.stringify({files:result,contract}));`;

// ---------------------------------------------------------------------------
// The measurements taken while the model generates (LIVE-L1): one read-only sample of the
// agent leaf's cgroup interface files, and the analysis of a run of samples against the budget.

// One sample of the agent leaf: the CPU accounting, the memory counters and the limits, read by the
// Box user, with the Box's monotonic clock taken beside the CPU read. memory.peak is absent on older
// kernels (null). Nothing is written.
export const LLM_LEAF_SAMPLE = String.raw`
const fs=require('node:fs');const p=process.argv[1];
if(!/^\/sys\/fs\/cgroup\/ploinky\/agents\/[A-Za-z0-9_.-]+$/.test(p)||fs.realpathSync(p)!==p)throw Error('Noncanonical leaf');
const read=(n)=>{try{return fs.readFileSync(p+'/'+n,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const cpuStat=read('cpu.stat');const atNs=process.hrtime.bigint().toString();
const out={atNs,'cpu.stat':cpuStat};
for(const n of ['cpu.max','memory.max','memory.swap.max','memory.current','memory.swap.current','memory.peak','memory.events'])out[n]=read(n);
process.stdout.write(JSON.stringify(out));`;

// The text request of LIVE-L1: long enough to be sampled while it generates (the tool's bounds are 200 characters and 512 tokens).
export const L1_PROMPT = Object.freeze({ prompt: 'Write a numbered list of twenty short facts about graphics cards.', maxTokens: 256 });

// While the model generates: the cgroup is sampled every 250 ms (plus the time of one read) and the GPU at the gate's own cadence of 500 ms.
export const INFERENCE_CADENCE = Object.freeze({ sampleMs: 250, gpuMs: 500 });

// What the analysis allows beyond the strict limits, each with its reason.
//   CPU: usage over a window may exceed quota x wall time by 10 % (the kernel charges usage per 100 ms
//   period, and the two reads of a window are not instantaneous) plus one period's quota (the burst a
//   period may still hold when the window starts mid-period).
//   GPU: nvidia-smi's per-process figure under MPS includes the CUDA context of the process (the same
//   256 MiB allowance the P2 probe bound and the L3 share evidence use) on top of the pinned limit.
export const INFERENCE_TOLERANCE = Object.freeze({ cpuRatio: 0.1, cpuPeriodsOfSlack: 1, gpuContextMiB: 256 });

const numberOrNull = value => (value === null || value === undefined ? null : /^[0-9]+$/.test(String(value).trim()) ? Number(String(value).trim()) : null);
const keyed = text => Object.fromEntries(String(text ?? '').split('\n').map(line => /^([a-z_]+) ([0-9]+)$/.exec(line.trim())).filter(Boolean).map(found => [found[1], Number(found[2])]));

// A raw leaf sample as numbers; anything unreadable stays null so the analysis can say so.
export function parseLeafSample(raw) {
    const cpu = keyed(raw['cpu.stat']); const events = keyed(raw['memory.events']);
    const atNs = /^[0-9]{1,20}$/.test(String(raw.atNs)) ? BigInt(raw.atNs) : null;
    const text = value => (value === null || value === undefined ? null : String(value).trim());
    return {
        atUs: atNs === null ? null : Number(atNs / 1000n),
        usageUsec: cpu.usage_usec ?? null, nrPeriods: cpu.nr_periods ?? null, nrThrottled: cpu.nr_throttled ?? null, throttledUsec: cpu.throttled_usec ?? null,
        cpuMax: text(raw['cpu.max']), memoryMax: text(raw['memory.max']), swapMax: text(raw['memory.swap.max']),
        memoryCurrent: numberOrNull(raw['memory.current']), memoryPeak: numberOrNull(raw['memory.peak']), swapCurrent: numberOrNull(raw['memory.swap.current']),
        oom: events.oom ?? null, oomKill: events.oom_kill ?? null, memoryHigh: events.high ?? null, memoryMaxEvents: events.max ?? null,
    };
}

// The GPU part of one gate check, reduced to what the analysis reads. `runnerHostPids` are the runner's
// host PIDs, resolved by verified identity; `owned` are the PIDs the gate proved ours. Device memory is
// summed over the runner's own rows (null when it has none) and over every owned row.
export function summarizeGpuCheck(label, checked, runnerHostPids, at = Date.now()) {
    const rows = (checked.inventory?.details ?? []).map(row => ({ pid: row.pid, type: row.type, memoryMiB: row.memoryMiB }));
    const sum = list => (list.length && list.every(row => Number.isFinite(row.memoryMiB)) ? list.reduce((total, row) => total + row.memoryMiB, 0) : null);
    const mine = rows.filter(row => runnerHostPids.includes(row.pid));
    const ownedRows = rows.filter(row => (checked.owned ?? []).includes(row.pid));
    return { label, at, usedMiB: checked.memory?.usedMiB ?? null, utilizationPercent: checked.utilization ?? null, rows, runnerMiB: sum(mine), ownedMiB: sum(ownedRows), runnerListed: mine.length, ownedListed: ownedRows.length };
}

/**
 * The verdict of a run of samples taken while a model generated. `violations` are budget breaches
 * (the case fails); `blockers` are measurements that could not be made (the case is BLOCKED, never
 * PASS); `summary` is the evidence either way. The first and last cgroup samples bound the window.
 */
export function analyzeInference({ cgroup, gpu, cpus, memoryCapBytes, shareMiB, tolerance = INFERENCE_TOLERANCE }) {
    const violations = []; const blockers = [];
    const summary = { samples: { cgroup: cgroup.length, inFlightCgroup: cgroup.filter(sample => sample.label === 'in-flight').length, gpu: gpu.length, inFlightGpu: gpu.filter(sample => sample.label === 'in-flight').length } };
    if (cgroup.length < 2 || cgroup.some(sample => sample.atUs === null || sample.usageUsec === null)) { blockers.push('The cgroup samples around the inference are missing or unreadable, so the CPU use cannot be measured'); return { violations, blockers, summary }; }
    // CPU: the quota in every sample, and the use over the whole window and between neighbours.
    const quota = String(cpus);
    for (const sample of cgroup) if (!cpuMaxMatches(sample.cpuMax, quota)) violations.push(`cpu.max is ${sample.cpuMax}, not ${cpus} CPUs (${sample.label})`);
    const period = Number(String(cgroup[0].cpuMax ?? '').split(/\s+/)[1]) || 100000;
    const allowance = (wallUs) => Math.floor(cpus * wallUs * (1 + tolerance.cpuRatio) + cpus * period * tolerance.cpuPeriodsOfSlack);
    const first = cgroup[0]; const last = cgroup.at(-1);
    const wallUs = last.atUs - first.atUs; const usedUs = last.usageUsec - first.usageUsec;
    summary.cpu = { cpus, windowUs: wallUs, usageUsec: usedUs, allowedUsec: allowance(Math.max(wallUs, 0)), averageCpus: wallUs > 0 ? Math.round(usedUs / wallUs * 1000) / 1000 : null,
        nrThrottled: first.nrThrottled !== null && last.nrThrottled !== null ? last.nrThrottled - first.nrThrottled : null, throttledUsec: first.throttledUsec !== null && last.throttledUsec !== null ? last.throttledUsec - first.throttledUsec : null };
    if (wallUs <= 0 || usedUs < 0) violations.push(`cpu.stat does not advance sensibly over the window (${usedUs} us of use in ${wallUs} us)`);
    else {
        if (usedUs > allowance(wallUs)) violations.push(`CPU use over the inference window was ${usedUs} us in ${wallUs} us (${summary.cpu.averageCpus} CPUs), above the ${cpus}-CPU quota allowance of ${allowance(wallUs)} us`);
        let worst = 0;
        for (let at = 1; at < cgroup.length; at += 1) {
            const span = cgroup[at].atUs - cgroup[at - 1].atUs; const used = cgroup[at].usageUsec - cgroup[at - 1].usageUsec;
            if (span > 0 && used > allowance(span)) violations.push(`CPU use between two samples was ${used} us in ${span} us, above the ${cpus}-CPU quota allowance of ${allowance(span)} us (${cgroup[at].label})`);
            if (span > 0) worst = Math.max(worst, used / span);
        }
        summary.cpu.peakIntervalCpus = Math.round(worst * 1000) / 1000;
    }
    // Memory: peak at or below memory.max, no swap, no OOM kill.
    for (const sample of cgroup) {
        if (sample.memoryMax !== String(memoryCapBytes)) violations.push(`memory.max is ${sample.memoryMax}, not ${memoryCapBytes} (${sample.label})`);
        if (sample.memoryCurrent === null || sample.swapCurrent === null || sample.oomKill === null) blockers.push(`memory.current, memory.swap.current or memory.events could not be read (${sample.label})`);
    }
    const peaks = cgroup.flatMap(sample => [sample.memoryCurrent, sample.memoryPeak]).filter(Number.isFinite);
    const peak = peaks.length ? Math.max(...peaks) : null;
    const swap = Math.max(0, ...cgroup.map(sample => sample.swapCurrent ?? 0));
    const kills = last.oomKill !== null && first.oomKill !== null ? last.oomKill - first.oomKill : null;
    summary.memory = { capBytes: memoryCapBytes, peakBytes: peak, peakFromMemoryPeak: cgroup.some(sample => sample.memoryPeak !== null), maxCurrentBytes: Math.max(0, ...cgroup.map(sample => sample.memoryCurrent ?? 0)), swapMaxSeenBytes: swap, oomKillDelta: kills, oomKillAtEnd: last.oomKill, memoryMaxEventsDelta: first.memoryMaxEvents !== null && last.memoryMaxEvents !== null ? last.memoryMaxEvents - first.memoryMaxEvents : null };
    if (peak !== null && peak > memoryCapBytes) violations.push(`The cgroup's memory peak ${peak} exceeded memory.max ${memoryCapBytes}`);
    if (swap > 0) violations.push(`The cgroup used ${swap} bytes of swap during the inference`);
    if ((kills ?? 0) > 0 || (last.oomKill ?? 0) > 0) violations.push(`The kernel recorded an OOM kill in the cgroup (oom_kill ${last.oomKill}, ${kills} during the window)`);
    // GPU: the runner's own device memory (or the owned MPS server's, when the driver lists only that), against the share.
    const limitMiB = shareMiB + tolerance.gpuContextMiB;
    const runnerSeen = gpu.map(sample => sample.runnerMiB).filter(Number.isFinite); const ownedSeen = gpu.map(sample => sample.ownedMiB).filter(Number.isFinite);
    const util = gpu.map(sample => sample.utilizationPercent).filter(Number.isFinite);
    summary.gpu = { shareMiB, limitMiB, basis: runnerSeen.length ? 'runner-pid' : ownedSeen.length ? 'owned-mps-server' : null, runnerPeakMiB: runnerSeen.length ? Math.max(...runnerSeen) : null, ownedPeakMiB: ownedSeen.length ? Math.max(...ownedSeen) : null,
        utilizationMaxPercent: util.length ? Math.max(...util) : null, utilizationSamples: util.length };
    if (!runnerSeen.length && !ownedSeen.length) blockers.push('No process row of the runner or of the owned MPS server was listed with its device memory, so the GPU memory of the inference cannot be measured');
    if (runnerSeen.length && Math.max(...runnerSeen) > limitMiB) violations.push(`The runner held ${Math.max(...runnerSeen)} MiB of device memory, above the share's pinned limit ${shareMiB} MiB (plus ${tolerance.gpuContextMiB} MiB context)`);
    if (ownedSeen.length && Math.max(...ownedSeen) > limitMiB) violations.push(`The owned GPU processes held ${Math.max(...ownedSeen)} MiB of device memory, above the share's pinned limit ${shareMiB} MiB (plus ${tolerance.gpuContextMiB} MiB context)`);
    return { violations, blockers, summary };
}

// The calibration tool of the local-llm candidate (local-llm/tools/vllm_mps_calibration.mjs), run in the agent.
export const VLLM_TOOL_PATH = '/code/tools/vllm_mps_calibration.mjs';
export function vllmToolWords(command, { pins = null, hostNvmlBytes = null } = {}) {
    if (command === 'prerequisites') {
        if (!pins) throw new Error('The vLLM prerequisite check needs the pins of the lock entry');
        keys(pins, ['version', 'runnerLockDigest', 'files', 'downloadBytes'], 'vLLM lock pins');
        if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(pins.version) || !/^[0-9a-f]{64}$/.test(pins.runnerLockDigest) || !Number.isSafeInteger(pins.files) || pins.files < 1 || !Number.isSafeInteger(pins.downloadBytes) || pins.downloadBytes < 1) throw new Error('Invalid vLLM lock pins');
        return [VLLM_TOOL_PATH, 'prerequisites', '--pins', JSON.stringify({ version: pins.version, runnerLockDigest: pins.runnerLockDigest, files: pins.files, downloadBytes: pins.downloadBytes })];
    }
    if (command === 'calibrate') {
        if (!Number.isSafeInteger(hostNvmlBytes) || hostNvmlBytes < 1) throw new Error('The calibration needs the host NVML total');
        return [VLLM_TOOL_PATH, 'calibrate', '--host-nvml-bytes', String(hostNvmlBytes)];
    }
    throw new Error('Unsupported vLLM tool command');
}

// ---------------------------------------------------------------------------
// Pins of an apparatus-local-llm / apparatus-vllm execution profile.

const SHA256 = /^[0-9a-f]{64}$/;
export function validateLlmModelPins(models) {
    keys(models, ['small', 'awq'], 'local-llm model pins');
    keys(models.small, ['id', 'repo', 'file', 'commit', 'size', 'sha256'], 'GGUF model pin');
    keys(models.awq, ['id', 'repo', 'commit', 'size', 'files'], 'AWQ model pin');
    if (models.small.id !== LLM_MODELS.small || models.awq.id !== LLM_MODELS.awq) throw new Error('Unexpected model pins');
    if (!bounded(models.small.repo, 200) || !bounded(models.small.file, 200) || !/^[0-9a-f]{40}$/.test(models.small.commit) || !SHA256.test(models.small.sha256)
        || !Number.isSafeInteger(models.small.size) || models.small.size < 1) throw new Error('Invalid GGUF model pin');
    if (!bounded(models.awq.repo, 200) || !/^[0-9a-f]{40}$/.test(models.awq.commit) || !Number.isSafeInteger(models.awq.size) || models.awq.size < 1
        || !Array.isArray(models.awq.files) || !models.awq.files.length || models.awq.files.length > 64
        || models.awq.files.some(file => !bounded(file.path, 200) || !SHA256.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 1)
        || models.awq.files.reduce((sum, file) => sum + file.size, 0) !== models.awq.size) throw new Error('Invalid AWQ model pin');
    return models;
}

export function validateLlmProfile(profile) {
    const llm = profile.llm;
    keys(llm, ['image', 'revision', 'models', 'budget', 'playground', 'vllm'], 'local-llm profile');
    if (!profile.provision || llm.image !== profile.provision.image || llm.revision !== profile.provision.llm?.revision) throw new Error('The local-llm pins and the provision plan disagree');
    if (!/^[0-9a-f]{40}$/.test(llm.revision)) throw new Error('Invalid local-llm revision');
    validateLlmModelPins(llm.models);
    keys(llm.budget, ['cpus', 'memoryPercent', 'gpu'], 'local-llm budget');
    keys(llm.budget.gpu, ['smPercent', 'vramPercent'], 'local-llm GPU budget');
    if (JSON.stringify(llm.budget) !== JSON.stringify(LLM_BUDGET)) throw new Error('The local-llm budget is not the planned one');
    keys(llm.playground, ['mode', 'reason'], 'Playground');
    if (llm.playground.mode !== 'tool' || !bounded(llm.playground.reason, 1000)) throw new Error('Invalid Playground decision');
    const l3 = profile.cases.includes('LIVE-L3');
    if (!l3) { if (llm.vllm !== null) throw new Error('Only the vLLM block carries vLLM pins'); return llm; }
    keys(llm.vllm, ['stage', 'share', 'pins', 'calibration'], 'vLLM profile');
    if (!['calibration', 'qualified'].includes(llm.vllm.stage)) throw new Error('Invalid vLLM stage');
    if (JSON.stringify(llm.vllm.share) !== JSON.stringify(VLLM_SHARE)) throw new Error('The vLLM share is not the planned one');
    keys(llm.vllm.pins, ['version', 'runnerLockDigest', 'files', 'downloadBytes'], 'vLLM lock pins');
    vllmToolWords('prerequisites', { pins: llm.vllm.pins });
    if (llm.vllm.stage === 'calibration') {
        if (llm.vllm.calibration !== null) throw new Error('Stage 1 carries no calibration');
    } else {
        keys(llm.vllm.calibration, ['evidenceDigest', 'tuple', 'expectQualified'], 'vLLM calibration pin');
        keys(llm.vllm.calibration.tuple, ['runnerLockDigest', 'driverVersion', 'gpuPciDeviceId', 'computeCapability', 'deviceTotalBytes'], 'vLLM qualification tuple');
        const tuple = llm.vllm.calibration.tuple;
        if (!SHA256.test(llm.vllm.calibration.evidenceDigest) || typeof llm.vllm.calibration.expectQualified !== 'boolean' || tuple.runnerLockDigest !== llm.vllm.pins.runnerLockDigest
            || !/^[0-9]+(?:\.[0-9]+){1,3}$/.test(tuple.driverVersion) || !/^0x[0-9A-F]{8}$/.test(tuple.gpuPciDeviceId) || !/^[0-9]+\.[0-9]+$/.test(tuple.computeCapability)
            || !Number.isSafeInteger(tuple.deviceTotalBytes) || tuple.deviceTotalBytes < 1) throw new Error('Invalid vLLM calibration pin');
    }
    return llm;
}

// The Playground decision recorded in every local-llm manifest (the plan asks for a browser request).
export const PLAYGROUND_DECISION = Object.freeze({
    mode: 'tool',
    reason: 'The Playground is a tab of the Explorer dashboard and calls the local_llm_test_prompt tool through the Explorer MCP client (local-llm-dashboard.js). The owned fixture installs no Explorer: a browser request needs the full Explorer graph (UserPersisto sign-in and an administrator claim, LiveKit, OnlyOffice and the other agents), a browser profile and a Playwright runtime that this harness neither provisions nor has verified on apparatus. The cases call the same tool through the Router with the local operator session instead.',
});
