import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { BOX_LABELS } from '../../ploinky-box/constants.mjs';
import { runBoundedProcess } from '../hardware-limits/liveProcess.mjs';
import { dispatchRemoteRun, assertRemoteArrival } from '../hardware-limits/liveRemote.mjs';
import vm from 'node:vm';
import {
    CORE_LAYOUT, MEMBERSHIP as PROCESS_MEMBERSHIP, HELD_ALLOCATION, ALLOCATION_HANDSHAKE,
    assertCoreLayout,
} from '../hardware-limits/liveCaseCommands.mjs';
import { FakeCgroupFs, mountinfoLine } from '../hardware-limits/fakeCgroupFs.mjs';
import { prepareCgroupDelegation } from '../../ploinky-box/entrypoint/cgroupDelegation.mjs';
import { PREPARE_SCRIPT_BOX_PATH } from '../../ploinky-box/hardwareLimits/status.mjs';
import { ensureAgentCgroupParents, readStructuralDelegation } from '../../cli/sandbox/hardwareLimits/delegation.mjs';
import { parseGpuInventory, requireGpuIdle } from '../hardware-limits/liveGpu.mjs';
import { engineIdentityDigest } from '../hardware-limits/liveCommon.mjs';
import { fakeEngineInfo, unsupportedFormat } from '../hardware-limits/fakeLiveEngine.mjs';
import {
    assertWorkspace, executeLiveRun, jsonDigest, readPrivateJson, runLiveCommand,
    validateAuthorization, validateExecutionProfile, liveSourceDigest, postExitObservation, POST_EXIT_VANISHED,
} from '../hardware-limits/liveHarness.mjs';

const hash = bytes => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
const ok = stdout => ({ status: 0, signal: null, stdout, stderr: '', timedOut: false, truncated: false, cancelled: false, errorCode: null });
function fixture(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-live-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
    const fixtureHome = path.join(root, 'home'); fs.mkdirSync(fixtureHome);
    const runId = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(path.join(workspace, '.ploinky-hwl-owner'), runId);
    const sourceRoot = path.join(root, 'source'); fs.mkdirSync(sourceRoot);
    const candidate = path.join(sourceRoot, 'candidate.mjs'); fs.writeFileSync(candidate, '// fixture only\n');
    const engine = path.join(root, 'engine'); fs.writeFileSync(engine, 'fixture\n');
    const node = fs.realpathSync(process.execPath);
    const stat = fs.statSync(workspace); const identity = buildWorkspaceIdentity(workspace);
    const host = { arch: 'test', os: process.platform, hostname: 'test-engine', id: 'engine-id' };
    const box = { id: 'a'.repeat(64), created: '2026-10-01T00:00:00Z', image: 'b'.repeat(64), labels: { [BOX_LABELS.pathHash]: identity.pathHash, [BOX_LABELS.role]: 'box' }, mounts: [], running: true };
    const agents = ['memory', 'cpu', 'pids'].map((role, i) => ({ id: String(i + 1).repeat(64), created: box.created, image: 'c'.repeat(64), role }));
    const profile = {
        protocol: 'owned-fixture-v1', host: { hostname: os.hostname(), platform: process.platform, home: fixtureHome },
        node: { path: node, digest: hash(fs.readFileSync(node)) },
        candidate: { path: candidate, digest: hash(fs.readFileSync(candidate)) },
        engine: { path: engine, digest: hash(fs.readFileSync(engine)), identityDigest: engineIdentityDigest(fakeEngineInfo(host)) },
        source: { root: sourceRoot, digest: liveSourceDigest(sourceRoot) },
        workspace: { path: workspace, uid: stat.uid, dev: String(stat.dev), ino: String(stat.ino), marker: runId },
        box: { id: box.id, created: box.created, image: box.image, contractDigest: jsonDigest({ labels: box.labels, mounts: box.mounts }), pathHash: identity.pathHash, instance: identity.instance },
        agents, cases: ['LIVE-C2'],
    };
    const run = { schema: 1, runId, configDigest: hash('config'), casesDigest: hash('cases'), block: 'mac-cpu', target: { engine: null, ssh: null, execution: profile }, state: 'proposed', workspace: {}, ports: {}, deadlines: {}, images: [], ownedBoxes: [{ id: box.id, created: box.created }], ownedProcesses: [], ownedPaths: [{ path: workspace }], preInventory: { containers: [] }, operations: [{ id: 'fixture-created', state: 'observed', resourceIds: [box.id] }], cleanup: { state: 'not-started', steps: [], failures: [] } };
    const calls = []; let destroyed = false; let active = null; let pressured = false;
    const provider = async (binary, args, options) => {
        calls.push({ binary, args, options });
        // Like Podman, refuse a `--format` template that names a field the engine does not have.
        const refused = unsupportedFormat(args); if (refused) return refused;
        if (binary === node) { destroyed = true; return ok(''); }
        if (args[0] === 'info') return ok(JSON.stringify(fakeEngineInfo(host)));
        if (args.includes('ps')) return ok(destroyed ? '' : box.id + '\n');
        if (args[0] === 'container' && args[1] === 'inspect') return ok(JSON.stringify(box));
        if (args.includes('inspect')) {
            active = agents.find(agent => agent.id === args.at(-1));
            return ok(JSON.stringify({ ...active, running: true, pid: 123, startedAt: "2026-10-01T01:00:00Z", memory: 67108864, memorySwap: 67108864, nanoCpus: 500000000, pidsLimit: 64 }));
        }
        const script = args[args.indexOf('-e') + 1];
        if (script?.includes('const pid=')) { pressured = false; return ok(`0::/ploinky/agents/${active.id}\n`); }
        if (script?.includes('const names=')) return ok(JSON.stringify({ identity: { dev: '1', ino: '23' }, 'memory.max': '67108864\n', 'memory.swap.max': '0\n', 'cpu.max': '50000 100000\n', 'pids.max': '64\n', 'memory.events': `oom_kill ${pressured ? 1 : 0}\n`, 'cpu.stat': `nr_throttled ${pressured ? 1 : 0}\n`, 'pids.events': `max ${pressured ? 1 : 0}\n` }));
        pressured = true;
        await new Promise(resolve => setTimeout(resolve, 2));
        return ok('');
    };
    return { root, workspace, run, profile, box, host, calls, provider };
}

test('HLIVE.authorization-exact-target-action-and-bytes', t => {
    const { run } = fixture(t); const bytes = Buffer.from(JSON.stringify(run));
    const authorization = { schema: 1, runId: run.runId, manifestDigest: hash(bytes), targetDigest: jsonDigest(run.target), action: 'live' };
    assert.doesNotThrow(() => validateAuthorization(run, bytes, authorization, 'live'));
    assert.throws(() => validateAuthorization(run, bytes, authorization, 'cleanup'));
    assert.throws(() => validateAuthorization(run, Buffer.concat([bytes, Buffer.from(' ')]), authorization, 'live'));
    assert.throws(() => validateAuthorization({ ...run, target: {} }, bytes, authorization, 'live'));
});
test('HLIVE.missing-authorization-zero-commands', async t => {
    const { root, run } = fixture(t); const runPath = path.join(root, 'run_codex.json');
    fs.writeFileSync(runPath, JSON.stringify(run), { mode: 0o600 });
    await assert.rejects(runLiveCommand({ runPath, action: 'live', processProvider: () => { throw Error('must not run'); } }), /APPROVAL REQUIRED/);
});
test('HLIVE.profile-rejects-arbitrary-command-and-duplicate-agent', t => {
    const { run } = fixture(t); validateExecutionProfile(run);
    run.target.execution.command = 'rm'; assert.throws(() => validateExecutionProfile(run));
    delete run.target.execution.command;
    run.target.execution.agents[1].id = run.target.execution.agents[0].id;
    assert.throws(() => validateExecutionProfile(run));
});
test('HLIVE.private-evidence-symlink-hardlink-and-permissions', t => {
    const { root } = fixture(t); const file = path.join(root, 'read_codex.json');
    fs.writeFileSync(file, '{}', { mode: 0o600 }); assert.deepEqual(readPrivateJson(file).value, {});
    const link = path.join(root, 'link_codex.json'); fs.symlinkSync(file, link); assert.throws(() => readPrivateJson(link));
    fs.unlinkSync(link); fs.linkSync(file, link); assert.throws(() => readPrivateJson(file));
    fs.unlinkSync(link); fs.chmodSync(file, 0o644); assert.throws(() => readPrivateJson(file));
});
test('HLIVE.workspace-replacement-refuses-before-process', async t => {
    const f = fixture(t); fs.renameSync(f.workspace, f.workspace + '-old'); fs.mkdirSync(f.workspace);
    fs.writeFileSync(path.join(f.workspace, '.ploinky-hwl-owner'), f.run.runId);
    assert.throws(() => assertWorkspace(f.profile));
    await assert.rejects(executeLiveRun({ run: f.run, hostIdentity: f.profile.host, processProvider: f.provider })); assert.equal(f.calls.length, 0);
});
test('HLIVE.ssh-no-local-fallback', async t => {
    const f = fixture(t); f.run.target.ssh = { alias: 'ubuntu-codex' };
    const report = await executeLiveRun({ run: f.run, hostIdentity: f.profile.host, processProvider: f.provider });
    assert.equal(report.verdict, 'BLOCKED'); assert.equal(f.calls.length, 0);
});
test('HLIVE.engine-service-mismatch-no-pressure-or-destroy', async t => {
    const f = fixture(t); f.profile.engine.identityDigest = hash('wrong');
    const report = await executeLiveRun({ run: f.run, hostIdentity: f.profile.host, processProvider: f.provider });
    assert.equal(report.verdict, 'FAIL'); assert.equal(f.calls.length, 1); assert.ok(fs.existsSync(f.workspace));
});
test('HLIVE.same-leaf-event-deltas-and-incomplete-block', async t => {
    const f = fixture(t); let persisted = 0;
    const report = await executeLiveRun({ run: f.run, hostIdentity: f.profile.host, processProvider: f.provider, persist: () => { persisted++; } });
    assert.equal(report.cases.find(value => value.id === 'LIVE-C2').result, 'pass', JSON.stringify(report));
    assert.equal(report.verdict, 'BLOCKED'); assert.equal(report.cleanup.state, 'complete');
    assert.equal(fs.existsSync(f.workspace), false); assert.ok(persisted > 20);
    assert.ok(f.calls.filter(value => value.args.includes('--cgroup-manager=cgroupfs')).every(value => value.args.indexOf('--cgroup-manager=cgroupfs') === value.args.lastIndexOf('podman') + 1));
});
test('HLIVE.no-event-delta-is-failure-with-cleanup', async t => {
    const f = fixture(t);
    const provider = async (...args) => {
        const result = await f.provider(...args);
        if (args[1].some(arg => arg.includes('const names='))) result.stdout = result.stdout.replace(/\\n/g, '\\n').replace(/1\\n/g, '0\\n');
        return result;
    };
    const report = await executeLiveRun({ run: f.run, hostIdentity: f.profile.host, processProvider: provider });
    assert.equal(report.verdict, 'FAIL'); assert.equal(report.cleanup.state, 'complete');
});
test('HLIVE.destroy-failure-preserves-workspace-and-original-error', async t => {
    const f = fixture(t);
    const provider = async (binary, args, options) => {
        if (binary === f.profile.node.path) return { ...ok(''), status: 1 };
        const result = await f.provider(binary, args, options);
        if (args.some(arg => arg.includes('const names='))) result.stdout = '{}';
        return result;
    };
    const report = await executeLiveRun({ run: f.run, hostIdentity: f.profile.host, processProvider: provider });
    assert.equal(report.verdict, 'FAIL'); assert.ok(report.limitations.length); assert.equal(report.cleanup.state, 'failed');
    assert.ok(report.cleanup.failures.length); assert.ok(fs.existsSync(f.workspace));
});
test('HLIVE.foreign-replacement-blocks-cleanup-deletion', async t => {
    const f = fixture(t); const foreign = 'd'.repeat(64); let destroyed = false;
    const provider = async (binary, args, options) => {
        if (binary === f.profile.node.path) { destroyed = true; return ok(''); }
        if (destroyed && args.includes('ps')) return ok(foreign);
        if (destroyed && args.includes('inspect')) return ok(JSON.stringify({ ...f.box, id: foreign }));
        return f.provider(binary, args, options);
    };
    const report = await executeLiveRun({ run: f.run, hostIdentity: f.profile.host, action: 'cleanup', processProvider: provider });
    assert.equal(report.verdict, 'FAIL'); assert.ok(fs.existsSync(f.workspace));
});
test('HLIVE.cleanup-resumes-after-exact-box-already-absent', async t => {
    const f = fixture(t);
    const provider = async (binary, args, options) => args.includes('ps') ? ok('') : f.provider(binary, args, options);
    const report = await executeLiveRun({ run: f.run, hostIdentity: f.profile.host, action: 'cleanup', processProvider: provider });
    assert.equal(report.verdict, 'PASS'); assert.equal(fs.existsSync(f.workspace), false);
    assert.ok(!f.calls.some(value => value.binary === f.profile.node.path));
});
test('HLIVE.transport-timeout-output-bound-and-cancel', async t => {
    const { root } = fixture(t); const env = { PATH: process.env.PATH };
    const timeout = await runBoundedProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: root, env, deadlineMs: 20 });
    assert.equal(timeout.timedOut, true);
    const overflow = await runBoundedProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(10000))'], { cwd: root, env, maxBytes: 128 });
    assert.equal(overflow.truncated, true); assert.ok(overflow.stdout.length <= 128);
    const controller = new AbortController(); controller.abort();
    const cancel = await runBoundedProcess(process.execPath, [], { cwd: root, env, signal: controller.signal, spawnProcess: () => { throw Error('must not spawn'); } });
    assert.equal(cancel.cancelled, true);
});

const uuid = 'GPU-01234567-1234';
const xml = rows => `<nvidia_smi_log><gpu id="0000"><uuid>${uuid}</uuid><compute_mode>Default</compute_mode><processes>${rows}</processes></gpu></nvidia_smi_log>`;
const processXml = (pid, type) => `<process_info><pid>${pid}</pid><type>${type}</type></process_info>`;
test('HLIVE.gpu-graphics-busy-and-unknown-activity-block', async () => {
    await assert.rejects(requireGpuIdle({ query: async () => ok(xml(processXml(123, 'G'))), expectedUuid: uuid, initial: true }), /gpu_busy/);
    assert.throws(() => parseGpuInventory(ok(xml('N/A')), uuid));
    assert.throws(() => parseGpuInventory(ok(xml('').replace('Default', 'Exclusive_Process')), uuid));
    assert.throws(() => parseGpuInventory(ok(xml('').replace(uuid, 'GPU-87654321-1234')), uuid));
});
test('HLIVE.gpu-owned-pid-exact-and-reuse-proof', async () => {
    const record = { hostPid: 12, startIdentity: 'start', bootId: 'boot', role: 'mps-client' };
    const settings = { expectedUuid: uuid, owned: [record], bootId: 'boot', boxCgroupPrefix: '/owned', observe: async () => ({ ...record, cgroup: '/owned/client' }) };
    await requireGpuIdle({ ...settings, query: async () => ok(xml(processXml(12, 'C'))) });
    await assert.rejects(requireGpuIdle({ ...settings, query: async () => ok(xml(processXml(123, 'C'))) }), /gpu_busy/);
    await assert.rejects(requireGpuIdle({ ...settings, query: async () => ok(xml(processXml(12, 'C'))), observe: async () => ({ ...record, startIdentity: 'reused', cgroup: '/owned/client' }) }), /provenance/);
});

test('HLIVE.source-drift-blocks-before-process', async t => {
    const f = fixture(t); fs.writeFileSync(path.join(f.profile.source.root, 'import.mjs'), '// changed');
    const report = await executeLiveRun({ run: f.run, hostIdentity: f.profile.host, processProvider: f.provider });
    assert.equal(report.verdict, 'BLOCKED'); assert.equal(f.calls.length, 0);
});
test('HLIVE.leaf-inode-change-cannot-prove-enforcement', async t => {
    const f = fixture(t); let observations = 0;
    const provider = async (...args) => {
        const result = await f.provider(...args);
        if (args[1].some(arg => arg.includes('const names='))) {
            const leaf = JSON.parse(result.stdout); leaf.identity.ino = String(++observations); result.stdout = JSON.stringify(leaf);
        }
        return result;
    };
    const report = await executeLiveRun({ run: f.run, hostIdentity: f.profile.host, processProvider: provider });
    assert.equal(report.verdict, 'FAIL'); assert.match(report.cases.find(row => row.id === 'LIVE-C2').reason, /identity changed/);
});
test('HLIVE.host-state-left-behind-prevents-workspace-deletion', async t => {
    const f = fixture(t); const directory = path.join(f.profile.host.home, '.ploinky-box', 'hardware-limits');
    fs.mkdirSync(directory, { recursive: true }); const record = path.join(directory, f.profile.box.instance + '.json');
    fs.writeFileSync(record, '{}'); t.after(() => fs.rmSync(record, { force: true }));
    const report = await executeLiveRun({ run: f.run, hostIdentity: f.profile.host, action: 'cleanup', processProvider: f.provider });
    assert.equal(report.verdict, 'FAIL'); assert.ok(fs.existsSync(f.workspace));
    assert.match(report.cleanup.failures[0], /host state/);
});

test('HLIVE.R13-removal-intent-directory-substitution-is-preserved', async t => {
    const f = fixture(t); const original = f.workspace + '-original'; let replaced = false;
    const persist = () => {
        if (!replaced && f.run.cleanup.steps.some(step => step.id === 'workspace-removal' && step.state === 'intent')) {
            replaced = true; fs.renameSync(f.workspace, original); fs.mkdirSync(f.workspace);
            fs.writeFileSync(path.join(f.workspace, 'foreign.txt'), 'must remain');
        }
    };
    const report = await executeLiveRun({ run: f.run, hostIdentity: f.profile.host, action: 'cleanup', processProvider: f.provider, persist });
    assert.equal(report.verdict, 'FAIL');
    assert.equal(fs.readFileSync(path.join(f.workspace, 'foreign.txt'), 'utf8'), 'must remain');
    assert.ok(fs.existsSync(path.join(original, '.ploinky-hwl-owner')));
});

test('HLIVE.R16-inherited-pipe-grandchild-deadline', async t => {
    const { root } = fixture(t); const pidFile = path.join(root, 'grandchild_codex.json');
    // The grandchild holds the inherited output pipe far longer than the
    // deadline plus its bounded settlement, so returning within that bound
    // proves the runner does not wait for the pipe. The deadline leaves the
    // two node startups ample time to record the grandchild under CPU load.
    const grandchildLifetimeMs = 120000; const deadlineMs = 3000; const settlementBoundMs = 4000;
    const script = `const {spawn}=require("node:child_process");const fs=require("node:fs");const c=spawn(process.execPath,["-e","setTimeout(()=>{},${grandchildLifetimeMs})"],{stdio:["ignore","inherit","inherit"]});fs.writeFileSync(process.argv[1],JSON.stringify({pid:c.pid}));setInterval(()=>{},1000);`;
    let pid = null;
    t.after(() => { if(pid)try{process.kill(pid,'SIGKILL')}catch(e){if(e.code!=='ESRCH')throw e;} });
    const start = Date.now();
    const result = await runBoundedProcess(process.execPath, ['-e', script, pidFile], { cwd: root, env: { PATH: process.env.PATH }, deadlineMs });
    const elapsed = Date.now() - start;
    if (fs.existsSync(pidFile)) pid = JSON.parse(fs.readFileSync(pidFile)).pid;
    assert.equal(result.timedOut, true); assert.ok(pid, 'the grandchild started before the deadline');
    assert.ok(elapsed < deadlineMs + settlementBoundMs && elapsed < grandchildLifetimeMs / 2, `elapsed ${elapsed} ms`);
    let alive = true;
    for(let i=0;i<30;i++){
        try{process.kill(pid,0);if(process.platform==='linux'&&/^\d+ \(.*\) Z /.test(fs.readFileSync('/proc/'+pid+'/stat','utf8')))alive=false;}
        catch(e){if(e.code==='ESRCH'||e.code==='ENOENT')alive=false;else throw e;}
        if(!alive)break;await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.equal(alive,false,'owned grandchild still running'); pid=null;
});

function offlineSourceFixture(t, mutateDuringRun = false) {
    const f = fixture(t); const evidence = path.join(f.root, 'evidence'); fs.mkdirSync(evidence);
    const roots = Object.fromEntries(['ploinky', 'localLlms', 'explorer', 'images'].map(name => {
        const root = path.join(f.root, 'offline-' + name); fs.mkdirSync(root); return [name, root];
    }));
    const testDirectory = path.join(roots.explorer, 'tests'); fs.mkdirSync(testDirectory);
    const marker = path.join(evidence, 'executed_codex.json');
    const body = `import test from 'node:test';import fs from 'node:fs';test('source.leaf',()=>{fs.writeFileSync(${JSON.stringify(marker)},'{}');${mutateDuringRun ? "fs.writeFileSync(new URL('../drift.mjs',import.meta.url),'changed');" : ''}});`;
    fs.writeFileSync(path.join(testDirectory, 'source.test.mjs'), body);
    function sourceDigest(root) {
        const rows = [];
        const walk = (directory, relative = '') => {
            for (const name of fs.readdirSync(directory).sort()) {
                if(name==='.git')continue; const target = path.join(directory, name), rel = relative ? relative + '/' + name : name;
                const stat = fs.lstatSync(target);
                if(stat.isDirectory())walk(target,rel);
                else if(stat.isFile())rows.push(rel+'\0'+hash(fs.readFileSync(target)).slice(7));
                else if(stat.isSymbolicLink())rows.push(rel+'\0link:'+fs.readlinkSync(target));
            }
        };walk(root);return hash(rows.join('\n'));
    }
    const cases = {schema:1,cases:[{id:'source.leaf',phase:'p3',repo:'explorer',file:'tests/source.test.mjs',name:'source.leaf',kind:'offline',requires:[],expected:'pass'}]};
    const casesPath = path.join(evidence, 'cases_codex.json'); fs.writeFileSync(casesPath, JSON.stringify(cases), {mode:0o600});
    const config = {schema:1,runId:f.run.runId,createdAt:new Date().toISOString(),documentSuffix:'codex',node:{absoluteExecutable:fs.realpathSync(process.execPath),version:process.version},repos:{},dependencies:[],evidenceRoot:evidence,casesPath,casesDigest:hash(fs.readFileSync(casesPath)),engine:null,ssh:null};
    for(const [name,root] of Object.entries(roots))config.repos[name]={baselineRevision:'0'.repeat(40),baselineExport:root,baselineStage:root,candidateRoot:name==='images'?null:root,sourceDigest:sourceDigest(root),instructionDigests:{}};
    const configPath=path.join(evidence,'config_codex.json');fs.writeFileSync(configPath,JSON.stringify(config),{mode:0o600});
    const refresh = () => { for (const name of ['ploinky','localLlms','explorer']) config.repos[name].sourceDigest=sourceDigest(roots[name]); fs.writeFileSync(configPath,JSON.stringify(config),{mode:0o600}); };
    return { ...f, configPath, roots, marker, evidence, refresh };
}

test('HLIVE.R15-configure-then-source-mutation-blocked-before-suite', async t => {
    const f=offlineSourceFixture(t);fs.writeFileSync(path.join(f.roots.explorer,'changed.mjs'),'changed');
    const {main}=await import('../hardware-limits/verify.mjs');
    await assert.rejects(main(['offline','--config',f.configPath,'--phase','p3']),/candidate source changed/);
    assert.equal(fs.existsSync(f.marker),false);
});

test('HLIVE.R15-source-mutation-during-suite-invalidates-report', async t => {
    const f=offlineSourceFixture(t,true);const {main}=await import('../hardware-limits/verify.mjs');
    await assert.rejects(main(['offline','--config',f.configPath,'--phase','p3']),/candidate source changed/);
    assert.equal(fs.existsSync(f.marker),true);
    assert.equal(fs.existsSync(path.join(f.evidence,'report_offline-p3_codex.json')),false);
});


test('HLIVE.R18-Explorer-baseline-records-and-detects-removed-skipped', async t => {
    const f=offlineSourceFixture(t);const {main}=await import('../hardware-limits/verify.mjs');
    const files=[['explorer/tests/unit/settingsAccount.test.js','legacy.settings'],['workspaceMonitorAgent/tests/currentSnapshot.test.mjs','legacy.monitor'],['tests/smoke/lib/box-evidence.test.mjs','legacy.smoke']];
    for(const [file,name] of files){const target=path.join(f.roots.explorer,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,`import test from 'node:test';test('${name}',()=>{});`);}
    f.refresh();assert.equal(await main(['baseline','--config',f.configPath,'--phases','p3']),0);
    const recorded=JSON.parse(fs.readFileSync(path.join(f.evidence,'baseline-inventory-explorer.json')));
    assert.equal(Object.keys(recorded.tests).length,4);assert.ok(recorded.files.includes(files[0][0]));
    fs.writeFileSync(path.join(f.roots.explorer,files[0][0]),"import test from 'node:test';test('replacement.settings',()=>{});");
    fs.writeFileSync(path.join(f.roots.explorer,files[1][0]),"import test from 'node:test';test('legacy.monitor',{skip:true},()=>{});");
    f.refresh();assert.equal(await main(['offline','--config',f.configPath,'--phase','p3']),1);
    const report=JSON.parse(fs.readFileSync(path.join(f.evidence,'report_offline-p3_codex.json')));
    assert.ok(report.suites[0].removed.some(id=>id.endsWith('legacy.settings')));
    assert.ok(report.suites[0].newlySkipped.some(id=>id.endsWith('legacy.monitor')));
});

test('HLIVE.R18-empty-baseline-is-blocked', async t => {
    const f=offlineSourceFixture(t);fs.rmSync(path.join(f.roots.explorer,'tests'),{recursive:true});f.refresh();
    const {main}=await import('../hardware-limits/verify.mjs');
    assert.equal(await main(['baseline','--config',f.configPath,'--phases','p3']),2);
});


async function runC1(t, box, { agents = null } = {}) {
    const f=fixture(t);f.box.labels[BOX_LABELS.hardwareLimits]='f'.repeat(64);f.profile.box.contractDigest=jsonDigest({labels:f.box.labels,mounts:f.box.mounts});f.profile.cases=['LIVE-C1'];f.profile.fixtures={cpu:{ref:'test/cpu'}};
    if(agents)f.profile.agents=agents;
    const starts=[];const kinds=[];const persisted=[];
    // With a fake cgroupfs the fixed CORE_LAYOUT program runs against it, so
    // the proof is observed exactly as it would leave a Box.
    const provider=async(binary,args,options)=>{
        if(binary===f.profile.node.path&&args.includes('start')){starts.push(options.env.PLOINKY_BOX_HARDWARE_LIMITS);return ok('');}
        if(args.includes(PREPARE_SCRIPT_BOX_PATH)){kinds.push('preparation');throw new Error('the C1 proof must not run root preparation');}
        if(args.includes(CORE_LAYOUT)){kinds.push('layout');return ok(JSON.stringify(box.fake?observeLayout(observerFs(box.fake)):box.layout));}
        if(args.includes(PROCESS_MEMBERSHIP))return ok(JSON.stringify({pid:Number(args.at(-1)),start:'100',cgroup:args.at(-1)==='456'?'0::/ploinky/core\n':'0::/ploinky/agents/task\n'}));
        const result=await f.provider(binary,args,options);
        if(args.includes('inspect')&&args.includes('--cgroup-manager=cgroupfs')){const value=JSON.parse(result.stdout);value.conmonPid=456;result.stdout=JSON.stringify(value);}
        return result;
    };
    // Each persisted manifest is captured, so evidence persisted before the
    // assertion is visible exactly as a crash would leave it.
    const persist=()=>persisted.push(JSON.parse(JSON.stringify(f.run)));
    const report=await executeLiveRun({run:f.run,hostIdentity:f.profile.host,processProvider:provider,persist});
    const row=report.cases.find(entry=>entry.id==='LIVE-C1');
    return {report,starts,kinds,persisted,row,result:row.result};
}

test('HLIVE.C1-core-conmon-and-persisted-gate', async t => {
    const c1=await runC1(t,await productionBox());
    assert.equal(c1.result,'pass',JSON.stringify(c1.report));
    assert.deepEqual(c1.starts,['on',undefined]);assert.equal(c1.report.verdict,'BLOCKED');
    // Only the read-only observation runs; root preparation never does.
    assert.deepEqual(c1.kinds,['layout']);
    assert.deepEqual(c1.row.evidence.delegation.required,['cpu','memory','pids']);
    // A layout that is not settled fails C1, with the observation attached.
    const unsettled=await productionBox();unsettled.layout.paths['/ploinky'].files['cgroup.subtree_control'].value='\n';
    const failed=await runC1(t,{layout:unsettled.layout});
    assert.equal(failed.result,'fail');assert.deepEqual(failed.kinds,['layout']);
    assert.deepEqual(failed.row.evidence.layout,unsettled.layout);
});

test('HLIVE.A1-held-allocation-swap-before-pressure', async t => {
    const f=fixture(t);f.run.block='apparatus-cpu';f.profile.cases=['LIVE-A1'];let released=false,finishAllocation;
    const provider=async(binary,args,options)=>{
        if(args.includes(PROCESS_MEMBERSHIP))return ok(JSON.stringify({pid:123,start:'100',cgroup:'0::/ploinky/agents/task\n'}));
        if(args.includes(HELD_ALLOCATION))return new Promise(resolve=>{finishAllocation=()=>resolve({...ok(''),status:137});});
        if(args.includes(ALLOCATION_HANDSHAKE)){if(args.at(-1)==='release')released=true;return ok(JSON.stringify({pid:789,bytes:16777216}));}
        const result=await f.provider(binary,args,options);
        if(args.some(value=>value.includes('const names='))){const sample=JSON.parse(result.stdout);sample['memory.current']='33554432';sample['memory.swap.current']='0';sample['memory.events']='oom_kill '+(released?'1':'0')+'\n';result.stdout=JSON.stringify(sample);if(released)setTimeout(finishAllocation,2);}
        return result;
    };
    const report=await executeLiveRun({run:f.run,hostIdentity:f.profile.host,processProvider:provider});
    assert.equal(report.verdict,'PASS',JSON.stringify(report));
    assert.equal(report.cases[0].evidence.aliveSamples.length,3);assert.equal(released,true);
});

// O10: the kernel can report a kill after the pressure or allocation process
// has exited, so the leaf is observed again once the process settles.
function withShortPostExit(fn) {
    return async t => {
        const saved = { ...postExitObservation };
        postExitObservation.windowMs = 300; postExitObservation.intervalMs = 20;
        try { await fn(t); } finally { Object.assign(postExitObservation, saved); }
    };
}
// A1 provider: the counter follows the allocation process exit state.
function a1ProviderAfterExit(f, { counterAfterExit = true, vanishAfterExit = false } = {}) {
    let released = false; let exited = false; let finishAllocation;
    return async (binary, args, options) => {
        if (args.includes(PROCESS_MEMBERSHIP)) return ok(JSON.stringify({ pid: 123, start: '100', cgroup: '0::/ploinky/agents/task\n' }));
        if (args.includes(HELD_ALLOCATION)) return new Promise(resolve => { finishAllocation = () => { exited = true; resolve({ ...ok(''), status: 137 }); }; });
        if (args.includes(ALLOCATION_HANDSHAKE)) { if (args.at(-1) === 'release') released = true; return ok(JSON.stringify({ pid: 789, bytes: 16777216 })); }
        const result = await f.provider(binary, args, options);
        if (args.some(value => value.includes('const names='))) {
            if (vanishAfterExit && exited) return { ...ok(''), status: 1 };
            const sample = JSON.parse(result.stdout);
            sample['memory.current'] = '33554432'; sample['memory.swap.current'] = '0';
            sample['memory.events'] = `oom_kill ${counterAfterExit && exited ? 1 : 0}\n`;
            result.stdout = JSON.stringify(sample);
            if (released && !exited) setTimeout(finishAllocation, 2);
        }
        return result;
    };
}
function a1Fixture(t) { const f = fixture(t); f.run.block = 'apparatus-cpu'; f.profile.cases = ['LIVE-A1']; return f; }

test('HLIVE.A1-oom-counter-moving-only-after-the-allocation-exits-passes', withShortPostExit(async t => {
    const f = a1Fixture(t);
    const report = await executeLiveRun({ run: f.run, hostIdentity: f.profile.host, processProvider: a1ProviderAfterExit(f) });
    assert.equal(report.verdict, 'PASS', JSON.stringify(report));
    const evidence = report.cases[0].evidence;
    assert.ok(evidence.postExitSamples.length >= 1, 'post-exit samples are part of the evidence');
    assert.ok(evidence.pressureSamples.every(sample => sample['memory.events'] === 'oom_kill 0\n'), 'no in-flight sample saw the kill');
    assert.equal(evidence.postExitSamples.at(-1)['memory.events'], 'oom_kill 1\n');
}));

test('HLIVE.A1-oom-counter-never-moving-fails-with-the-same-message', withShortPostExit(async t => {
    const f = a1Fixture(t);
    const report = await executeLiveRun({ run: f.run, hostIdentity: f.profile.host, processProvider: a1ProviderAfterExit(f, { counterAfterExit: false }) });
    assert.equal(report.verdict, 'FAIL', JSON.stringify(report));
    assert.equal(report.cases[0].result, 'fail');
    assert.equal(report.cases[0].reason, 'No same-leaf pressure OOM evidence');
}));

test('HLIVE.A1-leaf-vanishing-after-exit-is-a-distinct-recorded-failure', withShortPostExit(async t => {
    const f = a1Fixture(t);
    const report = await executeLiveRun({ run: f.run, hostIdentity: f.profile.host, processProvider: a1ProviderAfterExit(f, { vanishAfterExit: true }) });
    assert.equal(report.verdict, 'FAIL', JSON.stringify(report));
    assert.equal(report.cases[0].result, 'fail');
    assert.equal(report.cases[0].reason, POST_EXIT_VANISHED);
    assert.match(report.cases[0].evidence.leafVanished, /Live command failed/);
    assert.ok(Array.isArray(report.cases[0].evidence.aliveSamples) && report.cases[0].evidence.aliveSamples.length === 3, 'the evidence so far is kept');
}));

// C2: the same for the cpu case (memory oom_kill, cpu nr_throttled, pids max).
function c2ProviderAfterExit(f, { counterAfterExit = true, vanishAfterExit = false } = {}) {
    let exited = false;
    return async (binary, args, options) => {
        const script = args.includes('-e') ? args[args.indexOf('-e') + 1] : null;
        const observer = script?.includes('const names=');
        const membership = script?.includes('const pid=');
        if (observer && vanishAfterExit && exited) return { ...ok(''), status: 1 };
        const result = await f.provider(binary, args, options);
        if (membership) exited = false;
        if (observer) {
            const sample = JSON.parse(result.stdout);
            const value = counterAfterExit && exited ? 1 : 0;
            sample['memory.events'] = `oom_kill ${value}\n`; sample['cpu.stat'] = `nr_throttled ${value}\n`; sample['pids.events'] = `max ${value}\n`;
            result.stdout = JSON.stringify(sample);
        } else if (args.includes('exec') && script && !membership) exited = true;
        return result;
    };
}

test('HLIVE.C2-counter-moving-only-after-the-pressure-exits-passes', withShortPostExit(async t => {
    const f = fixture(t);
    const report = await executeLiveRun({ run: f.run, hostIdentity: f.profile.host, processProvider: c2ProviderAfterExit(f) });
    const row = report.cases.find(value => value.id === 'LIVE-C2');
    assert.equal(row.result, 'pass', JSON.stringify(report));
    assert.equal(row.evidence.length, 3);
    for (const entry of row.evidence) {
        assert.ok(entry.postExitSamples.length >= 1, entry.role);
        assert.ok(entry.samples.every(sample => /(oom_kill|nr_throttled|max) 0\n/.test(sample['memory.events'] + sample['cpu.stat'] + sample['pids.events'])), entry.role);
    }
}));

test('HLIVE.C2-counter-never-moving-fails-with-the-same-message', withShortPostExit(async t => {
    const f = fixture(t);
    const report = await executeLiveRun({ run: f.run, hostIdentity: f.profile.host, processProvider: c2ProviderAfterExit(f, { counterAfterExit: false }) });
    const row = report.cases.find(value => value.id === 'LIVE-C2');
    assert.equal(row.result, 'fail', JSON.stringify(report));
    assert.equal(row.reason, 'No same-leaf oom_kill delta');
}));

test('HLIVE.C2-leaf-vanishing-after-exit-is-a-distinct-recorded-failure', withShortPostExit(async t => {
    const f = fixture(t);
    const report = await executeLiveRun({ run: f.run, hostIdentity: f.profile.host, processProvider: c2ProviderAfterExit(f, { vanishAfterExit: true }) });
    const row = report.cases.find(value => value.id === 'LIVE-C2');
    assert.equal(row.result, 'fail', JSON.stringify(report));
    assert.equal(row.reason, POST_EXIT_VANISHED);
    assert.match(row.evidence.leafVanished, /Live command failed/);
    assert.equal(row.evidence.role, 'memory');
}));

test('HLIVE.remote-pins-fixed-argv-and-no-fallback', async t => {
    const f=fixture(t);const ssh=path.join(f.root,'ssh');const known=path.join(f.root,'known_hosts');fs.writeFileSync(ssh,'fixture');fs.writeFileSync(known,'fixture public key');
    f.run.target.ssh={expectedAddress:'192.168.1.63',expectedHostKeyAlias:'192.168.1.63'};
    f.run.target.remote={sshBinary:ssh,sshDigest:hash(fs.readFileSync(ssh)),address:'192.168.1.63',hostKeyAlias:'192.168.1.63',user:'test',knownHosts:known,knownHostsDigest:hash(fs.readFileSync(known)),identityFile:null,runPath:'/tmp/run_codex.json',authorizationPath:'/tmp/auth_codex.json'};
    let argsSeen;
    const report=await dispatchRemoteRun({run:f.run,action:'live',cwd:f.root,manifestDigest:hash('manifest'),processProvider:async(binary,args)=>{assert.equal(binary,ssh);argsSeen=args;return {...ok(JSON.stringify({runId:f.run.runId,exitCode:2,verdict:'BLOCKED',cases:[]})),status:2};}});
    assert.equal(report.verdict,'BLOCKED');assert.ok(argsSeen.includes('StrictHostKeyChecking=yes'));assert.ok(argsSeen.includes('192.168.1.63'));assert.ok(argsSeen.includes('--expected-manifest-digest'));assert.ok(argsSeen.includes('/dev/null'));
    assert.equal(assertRemoteArrival(f.run,'10.0.0.2 45678 192.168.1.63 22'),true);
    assert.throws(()=>assertRemoteArrival(f.run,'10.0.0.2 45678 100.76.22.69 22'));
    f.profile.source.root='/tmp/bad;command';await assert.rejects(dispatchRemoteRun({run:f.run,action:'live',cwd:f.root,manifestDigest:hash('manifest'),processProvider:()=>{throw Error('must not call');}}),/path cannot/);
});


test('HLIVE.R15-unpinned-source-symlink-blocks-before-suite', async t => {
    const f=offlineSourceFixture(t);const outside=path.join(f.root,'outside.mjs');fs.writeFileSync(outside,'export default 1;');
    fs.symlinkSync(outside,path.join(f.roots.explorer,'alias.mjs'));f.refresh();
    const {main}=await import('../hardware-limits/verify.mjs');
    await assert.rejects(main(['offline','--config',f.configPath,'--phase','p3']),/unpinned symlink/);
    assert.equal(fs.existsSync(f.marker),false);
});

test('HLIVE.R13-quarantine-substitution-is-preserved', async t => {
    const f=fixture(t);let quarantine=null;let original=null;
    const persist=()=>{
        const step=f.run.cleanup.steps.find(value=>value.id==='workspace-removal'&&value.quarantine);
        if(step&&!quarantine){quarantine=step.quarantine;original=quarantine+'-original';fs.renameSync(quarantine,original);fs.mkdirSync(quarantine);fs.writeFileSync(path.join(quarantine,'foreign.txt'),'preserve');}
    };
    const report=await executeLiveRun({run:f.run,hostIdentity:f.profile.host,action:'cleanup',processProvider:f.provider,persist});
    assert.equal(report.verdict,'FAIL');assert.equal(fs.readFileSync(path.join(quarantine,'foreign.txt'),'utf8'),'preserve');assert.ok(fs.existsSync(path.join(original,'.ploinky-hwl-owner')));
});

test('HLIVE.R14-baseline-diagnostic-proof-survives-runner-roundtrip', async t => {
    const f=offlineSourceFixture(t);const {main}=await import('../hardware-limits/verify.mjs');
    const files=['explorer/tests/unit/settingsAccount.test.js','workspaceMonitorAgent/tests/currentSnapshot.test.mjs','tests/smoke/lib/box-evidence.test.mjs'];
    for(const [i,file] of files.entries()){const target=path.join(f.roots.explorer,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,`import test from 'node:test';test('legacy.${i}',()=>{});`);}
    const failing=path.join(f.roots.explorer,files[0]);
    const failure=expected=>`import test from 'node:test';import assert from 'node:assert/strict';test('legacy.0',()=>assert.equal(1,${expected}));`;
    fs.writeFileSync(failing,failure(2));f.refresh();assert.equal(await main(['baseline','--config',f.configPath,'--phases','p3']),0);
    const baseline=JSON.parse(fs.readFileSync(path.join(f.evidence,'baseline-inventory-explorer.json')));
    assert.match(baseline.failureSignatures[files[0]+'::legacy.0'].signature,/^[a-f0-9]{64}$/);
    assert.equal(await main(['offline','--config',f.configPath,'--phase','p3']),0);
    let report=JSON.parse(fs.readFileSync(path.join(f.evidence,'report_offline-p3_codex.json')));
    assert.equal(report.counts.baselineFailures,1);
    fs.writeFileSync(failing,failure(3));f.refresh();assert.equal(await main(['offline','--config',f.configPath,'--phase','p3']),1);
    report=JSON.parse(fs.readFileSync(path.join(f.evidence,'report_offline-p3_codex.json')));
    assert.equal(report.counts.newFailures,1);assert.equal(report.counts.baselineFailures,0);
});

test('HLIVE.R18-baseline-import-failure-is-blocked-without-inventory', async t => {
    const f=offlineSourceFixture(t);fs.writeFileSync(path.join(f.roots.explorer,'tests/source.test.mjs'),"import './missing.mjs';");f.refresh();
    const {main}=await import('../hardware-limits/verify.mjs');
    assert.equal(await main(['baseline','--config',f.configPath,'--phases','p3']),2);
    assert.equal(fs.existsSync(path.join(f.evidence,'baseline-inventory-explorer.json')),false);
});

// --- C1 delegation proof over the read-only observation -------------------
// productionBox() runs the production root preparation and the production
// uid-1000 parent creation over the in-memory cgroup hierarchy, then runs the
// fixed CORE_LAYOUT observer program over it. The proof evaluates only that
// observation; it never asks production for a claim.
const INTERFACE_FILES = Object.freeze({ 'cpu.max': ['cpu', 'max 100000'], 'memory.max': ['memory', 'max'], 'pids.max': ['pids', 'max'] });
function observerFs(fake) {
    // The kernel shows a controller's interface file wherever the controller
    // is available; production chowns to 1000:1000, so gid follows uid here.
    const interfaceFile = (target) => {
        const located = fake.resolve(target);
        const group = located?.file && fake.groups.get(located.rel);
        const known = group && INTERFACE_FILES[located.file];
        return known && group.available.has(known[0]) ? { group, value: known[1] } : null;
    };
    // Owner, group and mode come from the hierarchy; interface files the
    // fake does not track get the kernel's default mode.
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
        // A real observer has the whole fs module; any write it attempts
        // reaches the hierarchy, where the snapshot comparison sees it.
        writeFileSync: (...args) => fake.writeFileSync(...args),
        mkdirSync: (...args) => fake.mkdirSync(...args),
        chownSync: (...args) => fake.chownSync(...args),
        rmdirSync: (...args) => fake.rmdirSync(...args),
    };
}
function observeLayout(fsApi) {
    let output = '';
    vm.runInNewContext(CORE_LAYOUT, { require: (name) => { assert.equal(name, 'node:fs'); return fsApi; }, process: { stdout: { write: (text) => { output += text; } } } });
    return JSON.parse(output);
}
async function productionBox({ available = ['cpu', 'io', 'memory', 'pids'], afterParents = () => {} } = {}) {
    const fake = new FakeCgroupFs({ controllers: available });
    const prepare = () => prepareCgroupDelegation({ argv: ['prepare'], getuid: () => 0, fsApi: fake, sleep: async () => {} });
    const first = await prepare();
    assert.equal(first.exitCode, 0, JSON.stringify(first.result));
    fake.actorUid = 1000;
    const structural = readStructuralDelegation({ fsApi: fake });
    assert.equal(structural.structurallyPrepared, true, structural.reason);
    ensureAgentCgroupParents({ fsApi: fake, controllers: structural.controllers });
    afterParents(fake);
    return { fake, structural, firstReport: `${JSON.stringify(first.result)}\n`, layout: observeLayout(observerFs(fake)) };
}
const rejects = (box, pattern, options) => assert.throws(() => assertCoreLayout(box.layout, options), pattern);
// The exact layout of the reviewer's delegatedRootOwnedFiles probe.
function reviewerRootOwnedLayout() {
    const layout = { pid1: '0::/ploinky/core\n', self: '0::/ploinky/core\n', mounts: [mountinfoLine().split('\n')[1]], paths: {} };
    for (const suffix of ['/', '/ploinky/core', '/ploinky', '/ploinky/agents', '/ploinky/system']) {
        layout.paths[suffix] = { uid: suffix === '/' || suffix === '/ploinky/core' ? 0 : 1000, files: { 'memory.max': { uid: 0, value: 'max' }, 'cpu.max': { uid: 0, value: 'max 100000' }, 'pids.max': { uid: 0, value: 'max' }, 'cgroup.procs': { uid: 0, value: '' }, 'cgroup.subtree_control': { uid: 0, value: '' } } };
    }
    return layout;
}

test('C1.layout-full-controllers-pass', async () => {
    const box = await productionBox();
    const delegation = assertCoreLayout(box.layout, { fixtureControllers: ['cpu', 'memory', 'pids'] });
    assert.deepEqual([...delegation.required], ['cpu', 'memory', 'pids']); assert.deepEqual(delegation.missing, []);
    for (const name of ['cgroup.procs', 'cgroup.subtree_control', 'cgroup.threads']) {
        assert.deepEqual([box.layout.paths['/ploinky'].files[name].uid, box.layout.paths['/ploinky'].files[name].gid], [1000, 1000]);
    }
});

test('C1.layout-partial-controllers-pass', async () => {
    const box = await productionBox({ available: ['io', 'memory', 'pids'] });
    const delegation = assertCoreLayout(box.layout, { fixtureControllers: ['memory', 'pids'] });
    assert.deepEqual([...delegation.required], ['memory', 'pids']);
    assert.deepEqual(delegation.missing, [{ controller: 'cpu', reason: 'not offered by the root cgroup.controllers' }]);
    assert.equal(box.layout.paths['/ploinky/agents'].files['cpu.max'].present, false);
    // A fixture that needs cpu on this host is BLOCKED, never passed.
    assert.throws(() => assertCoreLayout(box.layout, { fixtureControllers: ['cpu', 'memory', 'pids'] }),
        (error) => error.code === 'LIVE_PREREQUISITE_MISSING' && /needs controller cpu/.test(error.message));
});

test('C1.observer-records-delegation-files-and-absence', async () => {
    const box = await productionBox({ afterParents: (fake) => fake.groups.delete('/ploinky/system') });
    for (const name of ['cgroup.procs', 'cgroup.subtree_control', 'cgroup.threads', 'cgroup.controllers']) {
        const file = box.layout.paths['/ploinky'].files[name];
        assert.equal(file.present, true); assert.equal(typeof file.value, 'string');
        assert.ok(Number.isSafeInteger(file.uid) && Number.isSafeInteger(file.gid) && Number.isSafeInteger(file.mode), name);
    }
    assert.ok(Number.isSafeInteger(box.layout.paths['/ploinky'].mode));
    assert.deepEqual(box.layout.paths['/ploinky/system'], { present: false });
    assert.equal(box.layout.paths['/ploinky/core'].files['memory.max'].present, true);
    assert.equal(box.layout.mounts.length, 1); assert.match(box.layout.mounts[0], / \/sys\/fs\/cgroup .* - cgroup2 cgroup2 rw,nsdelegate/);
    rejects(box, /Missing cgroup evidence for \/ploinky\/system/);
});

// A4: the engine leaves the Box root's interface files (other than its
// directory and the three delegation files) owned by the engine user, who is
// uid 1000 inside the keep-id Box. The observed real-engine pattern passes;
// anything else at the root, and any non-root file under /ploinky/core, fails.
test('C1.layout-root-interface-files-owned-by-the-box-runtime-uid-pass', async () => {
    const box = await productionBox();
    const root = box.layout.paths['/'].files;
    const observed = ['cgroup.controllers', 'cpu.max', 'memory.max', 'pids.max'].filter(name => root[name]?.present !== false);
    assert.ok(observed.length >= 1, 'the fixture observes interface files at the root');
    for (const name of observed) root[name].uid = 1000;
    for (const name of ['cgroup.procs', 'cgroup.subtree_control', 'cgroup.threads']) if (root[name]?.present !== false) assert.equal(root[name].uid, 0, `${name} stays root-owned`);
    assert.equal(box.layout.paths['/'].uid, 0);
    const delegation = assertCoreLayout(box.layout, { fixtureControllers: ['cpu', 'memory', 'pids'] });
    assert.deepEqual([...delegation.required], ['cpu', 'memory', 'pids']);
});

test('C1.layout-root-delegation-file-owned-by-1000-rejected', async () => {
    for (const name of ['cgroup.procs', 'cgroup.subtree_control', 'cgroup.threads']) {
        const box = await productionBox();
        if (box.layout.paths['/'].files[name]?.present === false) continue;
        box.layout.paths['/'].files[name].uid = 1000;
        rejects(box, /Root\/core cgroup ownership mismatch/);
    }
    const directory = await productionBox();
    directory.layout.paths['/'].uid = 1000;
    rejects(directory, /Root\/core cgroup ownership mismatch/);
});

test('C1.layout-root-interface-file-owned-by-another-uid-rejected', async () => {
    for (const uid of [1001, 65534, 1]) {
        const box = await productionBox();
        const name = ['cgroup.controllers', 'cpu.max', 'memory.max', 'pids.max'].find(value => box.layout.paths['/'].files[value]?.present !== false);
        box.layout.paths['/'].files[name].uid = uid;
        rejects(box, /Root\/core cgroup ownership mismatch/);
    }
});

test('C1.layout-core-file-owned-by-1000-rejected', async () => {
    const box = await productionBox();
    const name = Object.keys(box.layout.paths['/ploinky/core'].files).find(value => box.layout.paths['/ploinky/core'].files[value]?.present !== false && value !== 'cgroup.procs');
    box.layout.paths['/ploinky/core'].files[name].uid = 1000;
    rejects(box, /Root\/core cgroup ownership mismatch/);
    const procs = await productionBox();
    procs.layout.paths['/ploinky/core'].files['cgroup.procs'].uid = 1000;
    rejects(procs, /Root\/core cgroup ownership mismatch/);
});

test('C1.layout-root-owned-delegation-files-rejected', async () => {
    const box = await productionBox();
    for (const name of ['cgroup.procs', 'cgroup.subtree_control', 'cgroup.threads']) Object.assign(box.layout.paths['/ploinky'].files[name], { uid: 0, gid: 0 });
    rejects(box, /Delegated cgroup ownership mismatch: \/ploinky\/cgroup\.procs is owned by uid 0/);
    // The same drift observed on the hierarchy itself fails the same way.
    const actual = await productionBox({ afterParents: (fake) => { fake.groups.get('/ploinky').fileUids['cgroup.procs'] = 0; } });
    rejects(actual, /Delegated cgroup ownership mismatch: \/ploinky\/cgroup\.procs is owned by uid 0/);
});

test('C1.layout-root-owned-cgroup-threads-rejected', async () => {
    const box = await productionBox();
    Object.assign(box.layout.paths['/ploinky'].files['cgroup.threads'], { uid: 0, gid: 0 });
    rejects(box, /\/ploinky\/cgroup\.threads is owned by uid 0/);
});

test('C1.layout-missing-cgroup-threads-rejected', async () => {
    const box = await productionBox();
    box.layout.paths['/ploinky'].files['cgroup.threads'] = { present: false };
    rejects(box, /Missing cgroup evidence for \/ploinky\/cgroup\.threads/);
    delete box.layout.paths['/ploinky'].files['cgroup.threads'];
    rejects(box, /Missing cgroup evidence for \/ploinky\/cgroup\.threads/);
});

test('C1.layout-empty-subtree-control-rejected', async () => {
    for (const suffix of ['/', '/ploinky', '/ploinky/agents', '/ploinky/system']) {
        const box = await productionBox();
        box.layout.paths[suffix].files['cgroup.subtree_control'].value = '\n';
        rejects(box, new RegExp(`Required controller (cpu|memory|pids) is not enabled in ${suffix.replaceAll('/', '\\/')}$`));
    }
    const empty = await productionBox();
    empty.layout.paths['/ploinky'].files['cgroup.subtree_control'] = { present: false };
    rejects(empty, /Missing cgroup evidence for \/ploinky\/cgroup\.subtree_control/);
});

test('C1.layout-claimed-controller-missing-rejected', async () => {
    for (const suffix of ['/', '/ploinky', '/ploinky/agents', '/ploinky/system']) {
        for (const controller of ['cpu', 'memory', 'pids']) {
            const box = await productionBox();
            const file = box.layout.paths[suffix].files['cgroup.subtree_control'];
            file.value = `${file.value.split(/\s+/).filter((value) => value && value !== controller).join(' ')}\n`;
            rejects(box, new RegExp(`Required controller ${controller} is not enabled in ${suffix.replaceAll('/', '\\/')}$`));
        }
    }
    // A required controller's aggregate interface file is evidence too.
    const box = await productionBox();
    box.layout.paths['/ploinky/agents'].files['pids.max'] = { present: false };
    rejects(box, /Missing cgroup evidence for \/ploinky\/agents\/pids\.max/);
});

test('C1.layout-mode-without-owner-write-rejected', async () => {
    for (const [label, mutate] of [
        ['/ploinky/cgroup.procs', (layout) => { layout.paths['/ploinky'].files['cgroup.procs'].mode = 0o444; }],
        ['/ploinky/cgroup.threads', (layout) => { layout.paths['/ploinky'].files['cgroup.threads'].mode = 0o044; }],
        ['/ploinky', (layout) => { layout.paths['/ploinky'].mode = 0o555; }],
    ]) {
        const box = await productionBox(); mutate(box.layout);
        rejects(box, new RegExp(`not owner-writable: ${label.replaceAll('/', '\\/').replaceAll('.', '\\.')}$`));
    }
    const box = await productionBox(); box.layout.paths['/ploinky'].files['cgroup.subtree_control'].gid = 0;
    rejects(box, /group mismatch: \/ploinky\/cgroup\.subtree_control has gid 0/);
});

test('C1.layout-nonroot-root-or-core-procs-rejected', async () => {
    for (const suffix of ['/', '/ploinky/core']) {
        const box = await productionBox(); box.layout.paths[suffix].files['cgroup.procs'].uid = 1000;
        rejects(box, /Root\/core cgroup ownership mismatch/);
        const missing = await productionBox(); missing.layout.paths[suffix].files['cgroup.procs'] = { present: false };
        rejects(missing, new RegExp(`Missing cgroup evidence for ${suffix.replaceAll('/', '\\/')}\\/cgroup\\.procs`));
    }
});

test('C1.layout-reviewer-delegated-root-owned-files-rejected', async () => {
    const layout = reviewerRootOwnedLayout();
    assert.throws(() => assertCoreLayout(layout), /\/ploinky\/cgroup\.procs is owned by uid 0/);
    assert.throws(() => assertCoreLayout(layout, { fixtureControllers: ['cpu', 'memory', 'pids'] }), /\/ploinky\/cgroup\.procs is owned by uid 0/);
    assert.throws(() => assertCoreLayout(layout, { fixtureControllers: ['io'] }), /Invalid fixture controller requirement/);
});

test('C1.layout-mount-must-be-rw-cgroup2-nsdelegate', async () => {
    for (const mount of [{ fstype: 'cgroup' }, { mountRw: false }, { superRw: false }, { nsdelegate: false }]) {
        const box = await productionBox();
        box.layout.mounts = [mountinfoLine(mount).split('\n')[1]];
        rejects(box, /not cgroup2 mounted rw with nsdelegate/, { fixtureControllers: ['cpu', 'memory', 'pids'] });
    }
    for (const mounts of [[], undefined, [mountinfoLine().split('\n')[1], mountinfoLine().split('\n')[1]]]) {
        const box = await productionBox(); box.layout.mounts = mounts;
        rejects(box, /Missing cgroup mount evidence/);
    }
});

// Every file's content, owner and mode in the fake hierarchy, PID placement
// and the fake's own write, chown and mkdir logs, so even a write that leaves
// the same bytes is visible.
function cgroupSnapshot(fake) {
    const groups = {};
    for (const rel of [...fake.groups.keys()].sort()) {
        const directory = rel === '/' ? fake.cgroupRoot : `${fake.cgroupRoot}${rel}`;
        const stat = fake.lstatSync(directory);
        const group = fake.groups.get(rel);
        const files = {};
        for (const name of ['cgroup.procs', 'cgroup.subtree_control', 'cgroup.threads', 'cgroup.controllers', ...[...group.values.keys()].sort()]) {
            const file = `${directory}/${name}`;
            const fileStat = fake.lstatSync(file);
            files[name] = { content: fake.readFileSync(file), uid: fileStat.uid, gid: fileStat.gid, mode: fileStat.mode };
        }
        groups[rel] = { uid: stat.uid, gid: stat.gid, mode: stat.mode, files };
    }
    return JSON.stringify({ groups, pids: [...fake.pidGroup.entries()].sort(), writes: fake.writes, chowns: fake.chowns, mkdirs: fake.mkdirs });
}
// A write-trapping view: every mutating call is recorded and then applied to
// the hierarchy, so a proof that writes is caught both by the recorded
// attempts and by the byte-identical snapshot comparison.
const MUTATING = new Set(['writeFileSync', 'mkdirSync', 'chownSync', 'rmdirSync', 'chmodSync', 'renameSync', 'unlinkSync', 'rmSync', 'appendFileSync', 'symlinkSync', 'linkSync', 'openSync']);
function writeTrap(fake) {
    const attempts = [];
    const view = new Proxy(fake, {
        get(target, property) {
            const value = Reflect.get(target, property, target);
            if (MUTATING.has(property)) return (...args) => { attempts.push([property, String(args[0])]); return value.apply(target, args); };
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
    return { view, attempts };
}
// Runs the C1 proof against the fake through the write trap and proves the
// fixture byte-identical afterwards.
async function proveOnFake(t, fake, options) {
    const before = cgroupSnapshot(fake);
    const trap = writeTrap(fake);
    const c1 = await runC1(t, { fake: trap.view }, options);
    assert.equal(cgroupSnapshot(fake), before, 'the C1 proof changed the cgroup fixture');
    assert.deepEqual(trap.attempts, []);
    assert.ok(!c1.kinds.includes('preparation'));
    return c1;
}
// The persisted pre-assertion observation and the report's evidence are the
// same layout the hierarchy showed.
function assertEvidencePersisted(c1, fake) {
    const layout = observeLayout(observerFs(fake));
    assert.deepEqual(c1.row.evidence.layout, layout);
    const persisted = c1.persisted.find((run) => run.operations.some((op) => op.kind === 'core-layout' && op.observation));
    assert.ok(persisted, 'the observation was not persisted');
    assert.deepEqual(persisted.operations.find((op) => op.kind === 'core-layout').observation, layout);
    assert.equal(persisted.cleanup.state, 'not-started', 'the observation must be persisted before the assertion and cleanup');
}
function unpreparedFake() {
    return new FakeCgroupFs();
}
async function driftedFake() {
    // A Box task strayed back into the namespace root after preparation.
    const fake = (await productionBox()).fake;
    fake.placePid(77, '/');
    return fake;
}

test('C1.proof-unprepared-box-fails-unchanged', async t => {
    const fake = unpreparedFake();
    const c1 = await proveOnFake(t, fake);
    assert.equal(c1.result, 'fail'); assert.equal(c1.report.verdict, 'FAIL');
    assert.match(c1.row.reason, /placement mismatch|Missing cgroup evidence/);
    assertEvidencePersisted(c1, fake);
    assert.deepEqual(c1.row.evidence.layout.paths['/ploinky'], { present: false });
    // Negative control: a repairing call through the same snapshot is seen.
    const before = cgroupSnapshot(fake);
    await prepareCgroupDelegation({ argv: ['prepare'], getuid: () => 0, fsApi: fake, sleep: async () => {} });
    assert.notEqual(cgroupSnapshot(fake), before);
});

test('C1.proof-drifted-box-fails-unchanged', async t => {
    const fake = await driftedFake();
    const c1 = await proveOnFake(t, fake);
    assert.equal(c1.result, 'fail'); assert.match(c1.row.reason, /^\/ has direct processes$/);
    assertEvidencePersisted(c1, fake);
    assert.match(c1.row.evidence.layout.paths['/'].files['cgroup.procs'].value, /^77$/m);
});

test('C1.proof-wrong-delegation-fails-unchanged', async t => {
    for (const [corrupt, pattern] of [
        [(fake) => { for (const name of ['cgroup.procs', 'cgroup.subtree_control', 'cgroup.threads']) fake.groups.get('/ploinky').fileUids[name] = 0; }, /\/ploinky\/cgroup\.procs is owned by uid 0/],
        [(fake) => { fake.groups.get('/ploinky').subtree.clear(); }, /Required controller cpu is not enabled in \/ploinky$/],
    ]) {
        const fake = (await productionBox()).fake; corrupt(fake);
        const c1 = await proveOnFake(t, fake);
        assert.equal(c1.result, 'fail'); assert.match(c1.row.reason, pattern);
        assertEvidencePersisted(c1, fake);
    }
});

test('C1.proof-full-controllers-pass-unchanged', async t => {
    const fake = (await productionBox()).fake;
    const c1 = await proveOnFake(t, fake);
    assert.equal(c1.result, 'pass', JSON.stringify(c1.report));
    assert.deepEqual([...c1.row.evidence.delegation.required], ['cpu', 'memory', 'pids']);
    assert.equal(c1.row.evidence.agents.length, 3);
    assertEvidencePersisted(c1, fake);
});

test('C1.proof-partial-controllers-pass-unchanged', async t => {
    // cpu is genuinely unavailable at the root: the delegation proof passes
    // for what the root offers, and the owned C1 fixture, which also limits
    // cpu, is BLOCKED on this host rather than passed or failed.
    const fake = (await productionBox({ available: ['io', 'memory', 'pids'] })).fake;
    const before = cgroupSnapshot(fake);
    const trap = writeTrap(fake);
    const delegation = assertCoreLayout(observeLayout(observerFs(trap.view)), { fixtureControllers: ['memory', 'pids'] });
    assert.deepEqual([...delegation.required], ['memory', 'pids']); assert.deepEqual(trap.attempts, []);
    assert.equal(cgroupSnapshot(fake), before);
    const c1 = await proveOnFake(t, fake);
    assert.equal(c1.result, 'blocked'); assert.match(c1.row.reason, /needs controller cpu/);
    assertEvidencePersisted(c1, fake);
});

test('C1.zero-agents-blocked-unchanged', async t => {
    const fake = (await productionBox()).fake;
    const c1 = await proveOnFake(t, fake, { agents: [] });
    assert.equal(c1.result, 'blocked'); assert.match(c1.row.reason, /owned fixture instance/);
    assert.notEqual(c1.report.verdict, 'PASS'); assert.deepEqual(c1.kinds, []); assert.deepEqual(c1.starts, []);
});

test('C1.empty-claim-with-available-controllers-fails-unchanged', async t => {
    // Nothing enabled while the root offers every controller: the required
    // set is the kernel's, so an empty delegation fails instead of passing.
    const fake = (await productionBox()).fake;
    for (const rel of ['/', '/ploinky', '/ploinky/agents', '/ploinky/system']) fake.groups.get(rel).subtree.clear();
    const c1 = await proveOnFake(t, fake);
    assert.equal(c1.result, 'fail'); assert.match(c1.row.reason, /Required controller cpu is not enabled in \/$/);
    assertEvidencePersisted(c1, fake);
    // A root that offers no wanted controller cannot prove the fixture.
    const io = (await productionBox({ available: ['io'] })).fake;
    const ioRun = await proveOnFake(t, io);
    assert.equal(ioRun.result, 'blocked'); assert.match(ioRun.row.reason, /needs controller cpu, memory, pids/);
});

test('C1.proof-agrees-with-production-already-check', async () => {
    // The observation predicates and production's own already-prepared
    // decision agree on every fixture. Production runs on a copy, because
    // its prepare verb repairs whatever it does not find settled.
    const copyOf = (fake) => Object.assign(Object.create(Object.getPrototypeOf(fake)), structuredClone({ ...fake, hooks: {} }));
    const fixtures = {
        full: async () => (await productionBox()).fake,
        partial: async () => (await productionBox({ available: ['io', 'memory', 'pids'] })).fake,
        unprepared: async () => unpreparedFake(),
        drifted: driftedFake,
        rootOwnedDelegation: async () => { const fake = (await productionBox()).fake; fake.groups.get('/ploinky').fileUids['cgroup.procs'] = 0; return fake; },
        emptySubtree: async () => { const fake = (await productionBox()).fake; fake.groups.get('/ploinky').subtree.clear(); return fake; },
    };
    for (const [name, build] of Object.entries(fixtures)) {
        const fake = await build();
        let observed = true;
        try { assertCoreLayout(observeLayout(observerFs(fake))); } catch { observed = false; }
        const copy = copyOf(fake);
        const production = await prepareCgroupDelegation({ argv: ['prepare'], getuid: () => 0, fsApi: copy, sleep: async () => {} });
        assert.equal(observed, production.result.already === true, name);
        assert.equal(['full', 'partial'].includes(name), observed, name);
    }
});

// --- C1 parent delegation (uid 1000 must be able to use both parents) -----

const PARENTS = Object.freeze(['/ploinky/agents', '/ploinky/system']);
const escape = (text) => text.replaceAll('/', '\\/').replaceAll('.', '\\.');

test('C1.layout-parent-delegation-files-rejected', async () => {
    for (const parent of PARENTS) {
        for (const name of ['cgroup.subtree_control', 'cgroup.procs']) {
            // Owned 0:0 with mode 0644: uid 1000 cannot write it.
            const rootOwned = await productionBox();
            Object.assign(rootOwned.layout.paths[parent].files[name], { uid: 0, gid: 0, mode: 0o644 });
            rejects(rootOwned, new RegExp(`Delegated cgroup ownership mismatch: ${escape(`${parent}/${name}`)} is owned by uid 0$`));
            // Owned by 1000 but not owner-writable.
            const readOnly = await productionBox();
            readOnly.layout.paths[parent].files[name].mode = 0o444;
            rejects(readOnly, new RegExp(`Delegated cgroup mode is not owner-writable: ${escape(`${parent}/${name}`)}$`));
            const absent = await productionBox();
            absent.layout.paths[parent].files[name] = { present: false };
            rejects(absent, new RegExp(`Missing cgroup evidence for ${escape(`${parent}/${name}`)}$`));
        }
    }
});

test('C1.layout-parent-directory-mode-and-group-rejected', async () => {
    for (const parent of PARENTS) {
        // 0555 cannot create children; 0600 cannot be searched.
        for (const mode of [0o555, 0o600, 0o455]) {
            const box = await productionBox();
            box.layout.paths[parent].mode = mode;
            rejects(box, new RegExp(`Delegated cgroup parent is not owner-writable and searchable: ${escape(parent)}$`));
        }
        const group = await productionBox();
        group.layout.paths[parent].gid = 0;
        rejects(group, new RegExp(`Delegated cgroup group mismatch: ${escape(parent)} has gid 0$`));
        const owner = await productionBox();
        owner.layout.paths[parent].uid = 0;
        rejects(owner, new RegExp(`Delegated cgroup ownership mismatch: ${escape(parent)} is owned by uid 0$`));
    }
    // Production's own parents (created by uid 1000, mode 0755) pass.
    const box = await productionBox();
    for (const parent of PARENTS) assert.deepEqual([box.layout.paths[parent].uid, box.layout.paths[parent].gid, box.layout.paths[parent].mode], [1000, 1000, 0o755]);
    assert.doesNotThrow(() => assertCoreLayout(box.layout, { fixtureControllers: ['cpu', 'memory', 'pids'] }));
});

test('C1.proof-parent-delegation-fails-unchanged', async t => {
    for (const [corrupt, pattern] of [
        // The reviewer's two accepted states.
        [(fake) => { const group = fake.groups.get('/ploinky/agents'); group.fileUids['cgroup.subtree_control'] = 0; group.fileGids['cgroup.subtree_control'] = 0; group.fileModes['cgroup.subtree_control'] = 0o644; },
            /^Delegated cgroup ownership mismatch: \/ploinky\/agents\/cgroup\.subtree_control is owned by uid 0$/],
        [(fake) => { fake.groups.get('/ploinky/agents').mode = 0o555; }, /^Delegated cgroup parent is not owner-writable and searchable: \/ploinky\/agents$/],
        [(fake) => { fake.groups.get('/ploinky/system').mode = 0o555; }, /^Delegated cgroup parent is not owner-writable and searchable: \/ploinky\/system$/],
        [(fake) => { fake.groups.get('/ploinky/system').fileUids['cgroup.procs'] = 0; }, /^Delegated cgroup ownership mismatch: \/ploinky\/system\/cgroup\.procs is owned by uid 0$/],
        [(fake) => { fake.groups.get('/ploinky/system').fileModes['cgroup.subtree_control'] = 0o444; }, /^Delegated cgroup mode is not owner-writable: \/ploinky\/system\/cgroup\.subtree_control$/],
        [(fake) => { fake.groups.get('/ploinky/agents').gid = 0; }, /^Delegated cgroup group mismatch: \/ploinky\/agents has gid 0$/],
    ]) {
        const fake = (await productionBox()).fake; corrupt(fake);
        const c1 = await proveOnFake(t, fake);
        assert.equal(c1.result, 'fail', String(pattern)); assert.match(c1.row.reason, pattern);
        assertEvidencePersisted(c1, fake);
    }
});

// --- C1 classification order: delegation before missing controllers -------

test('C1.proof-broken-delegation-with-missing-controller-fails-unchanged', async t => {
    // The root offers memory and pids only, and /ploinky delegates nothing:
    // broken delegation of the offered controllers fails C1 even though the
    // fixture also needs cpu, which this host cannot provide.
    for (const broken of [['/ploinky'], ['/ploinky/agents'], ['/', '/ploinky', '/ploinky/agents', '/ploinky/system']]) {
        const fake = (await productionBox({ available: ['io', 'memory', 'pids'] })).fake;
        for (const rel of broken) fake.groups.get(rel).subtree.clear();
        const layout = observeLayout(observerFs(fake));
        assert.throws(() => assertCoreLayout(layout, { fixtureControllers: ['cpu', 'memory', 'pids'] }),
            (error) => error.code !== 'LIVE_PREREQUISITE_MISSING' && /^Required controller memory is not enabled in /.test(error.message));
        const c1 = await proveOnFake(t, fake);
        assert.equal(c1.result, 'fail', broken.join(','));
        assert.match(c1.row.reason, new RegExp(`^Required controller memory is not enabled in ${escape(broken[0])}$`));
        assertEvidencePersisted(c1, fake);
    }
    // Broken parent ownership on such a host fails too, before the BLOCKED prerequisite.
    const owned = (await productionBox({ available: ['io', 'memory', 'pids'] })).fake;
    owned.groups.get('/ploinky/agents').mode = 0o555;
    const ownedRun = await proveOnFake(t, owned);
    assert.equal(ownedRun.result, 'fail'); assert.match(ownedRun.row.reason, /not owner-writable and searchable: \/ploinky\/agents$/);
});

test('C1.proof-valid-partial-host-blocked-unchanged', async t => {
    // The same host with correct delegation of memory and pids cannot support
    // a fixture that limits cpu: BLOCKED, with the observation retained.
    const fake = (await productionBox({ available: ['io', 'memory', 'pids'] })).fake;
    const layout = observeLayout(observerFs(fake));
    assert.throws(() => assertCoreLayout(layout, { fixtureControllers: ['cpu', 'memory', 'pids'] }),
        (error) => error.code === 'LIVE_PREREQUISITE_MISSING' && error.message === 'The fixture needs controller cpu, which the root cgroup does not offer');
    assert.deepEqual([...assertCoreLayout(layout, { fixtureControllers: ['memory', 'pids'] }).required], ['memory', 'pids']);
    const c1 = await proveOnFake(t, fake);
    assert.equal(c1.result, 'blocked'); assert.match(c1.row.reason, /needs controller cpu/);
    assertEvidencePersisted(c1, fake);
});
