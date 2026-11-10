import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// In-Box driver for webttyHomeMountBrokerNative.test.mjs. It runs as the Box
// user (uid 1000) against the read-only /opt/ploinky checkout and exercises the
// real createHomeMountBroker() against a nested rootless Podman target. All
// evidence leaves the Box as JSON lines on stdout.
// `--crash-child <spec-json>` re-runs this file as a separate broker process whose
// prepare is killed from outside (step 9); every other invocation is the driver.
// `--store-child <spec-json>` is the same with a real RuntimeRecordStore journal (step 10).
const isCrashChild = process.argv[2] === '--crash-child';
const isStoreChild = process.argv[2] === '--store-child';
const workspace = isCrashChild || isStoreChild ? process.env.PLOINKY_WORKSPACE_ROOT : process.argv[2];
process.env.PLOINKY_WORKSPACE_ROOT = workspace;

const PODMAN = '/usr/bin/podman';
// The Box's nested store starts empty; the host test seeds the pinned node image
// from the host store by local save/load (no pull), so it is addressed by its ID.
const NODE_IMAGE_ID = '07fd7e99fa11ca9bab2f06792e94fff2952bb30fcc8f6703227e96cde64fa7f1';
const NODE_IMAGE = NODE_IMAGE_ID;
const CORE = '/opt/ploinky/cli/server/webtty';
const DESTINATION_PREFIX = '/run/ploinky-webtty-home-';
const core = (name) => import(`/opt/ploinky/${name}`);

const [{ managedImageUserNamespace }, { controllerGuardMounts, controllerGuardTargets },
    { createHomeMountBroker }, { RuntimeRecordStore, readLinuxProcessIdentity }] = await Promise.all([
    core('cli/sandbox/routerAuthorityAttestation.js'), core('cli/utils/runtime/controllerStateGuards.js'),
    core('cli/server/webtty/homeMountBroker.mjs'), core('cli/server/webtty/runtimeRecords.mjs'),
]);

if (isCrashChild) {
    const spec = JSON.parse(process.argv[3]);
    // The parent plays the durable journal: every state/receipt is written to the
    // pipe (synchronously) before the callback reports success.
    const line = (kind, value) => process.stdout.write(`${JSON.stringify({ kind, value })}\n`);
    const journalReceipt = async (receipt) => { line('receipt', receipt); return true; };
    try {
        await createHomeMountBroker().prepare({
            ...spec,
            onHelper: async (state) => { line('helper', state); return true; },
            onIntent: journalReceipt,
            onDirectory: journalReceipt,
            onPrepared: journalReceipt,
            // Never resolves: the parent kills this process between attach and finish.
            onAttached: async (receipt) => { line('receipt', receipt); await new Promise(() => {}); },
        });
        line('done', null);
    } catch (error) { line('error', { code: error.code, message: error.message, reason: error.reason }); }
    process.exit(0);
}

if (isStoreChild) {
    const spec = JSON.parse(process.argv[3]);
    const line = (kind, value) => process.stdout.write(`${JSON.stringify({ kind, value })}\n`);
    try {
        // The real durable journal, written exactly as sessionManager writes it.
        const broker = createHomeMountBroker();
        const store = new RuntimeRecordStore({ directory: spec.directory, homeMountBroker: broker });
        const own = await readLinuxProcessIdentity(process.pid);
        const handle = await store.create({
            routerEpoch: crypto.randomBytes(18).toString('base64url'), marker: crypto.randomBytes(24).toString('base64url'),
            targetKind: 'agent', target: spec.recordTarget,
            worker: { pid: process.pid, startToken: own.startToken, uid: own.uid },
        });
        line('created', handle.fileName);
        const persistProjection = async (receipt) => {
            await store.update(handle, { ...handle.record, homeProjection: receipt });
            return true;
        };
        const onHelper = async (state) => {
            await store.update(handle, { ...handle.record, homeProjectionHelper: state ?? undefined });
            line('helper', state);
            // Variant B: die right after the nonce-only ownership is durable, before the spawn.
            if (spec.variant === 'B' && state && !state.pid) process.kill(process.pid, 'SIGKILL');
            return true;
        };
        await broker.prepare({
            target: spec.target, home: spec.home, sessionId: spec.sessionId, onHelper,
            onIntent: persistProjection, onDirectory: persistProjection, onPrepared: persistProjection,
            // Never resolves: the parent kills this process after the attached receipt is durable.
            onAttached: async (receipt) => { await persistProjection(receipt); line('attached', receipt); await new Promise(() => {}); },
        });
        line('done', null);
    } catch (error) { line('error', { code: error.code, message: error.message, reason: error.reason }); }
    process.exit(0);
}

const checks = [];
const steps = {};
const stamp = crypto.randomBytes(8).toString('hex');
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const clone = (value) => (value === null || value === undefined ? value : JSON.parse(JSON.stringify(value)));
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function emit(phase, values = {}) { process.stdout.write(`${JSON.stringify({ phase, at: Date.now(), ...values })}\n`); }
function check(step, name, ok, detail) {
    const entry = { step, name, ok: ok === true, ...(detail === undefined ? {} : { detail }) };
    checks.push(entry);
    emit('check', entry);
    return entry.ok;
}
function must(step, name, ok, detail) {
    if (!check(step, name, ok, detail)) throw new Error(`required check failed: ${step}: ${name}`);
}

function podman(args, { allowFailure = false, timeout = 120_000 } = {}) {
    const result = spawnSync(PODMAN, args, { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 });
    if (!allowFailure && result.status !== 0) {
        throw new Error(`podman ${args[0]} failed: ${result.stderr || result.error || result.signal}`);
    }
    return result;
}
function inspect(id) { return JSON.parse(podman(['container', 'inspect', id]).stdout)[0]; }
function inspectAbsent(result, id) {
    if (!result || result.status !== 125 || result.signal || result.error) return false;
    const stdout = String(result.stdout || '').trim();
    if (stdout !== '' && stdout !== '[]') return false;
    return new RegExp(`^(?:error:\\s*)?(?:no container with name or id ["']?${id}["']? found|no such container:?\\s+["']?${id}["']?|container ["']?${id}["']? does not exist)\\.?$`, 'i')
        .test(String(result.stderr || '').trim());
}
function identity(file) { const stat = fs.statSync(file, { bigint: true }); return { dev: String(stat.dev), ino: String(stat.ino) }; }
function ownership(file) { const stat = fs.statSync(file); return { uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o7777 }; }

// In-target probes run as uid 1000 inside the nested target container.
function inTarget(containerId, script, ...args) {
    const result = podman(['container', 'exec', '--user', '1000:1000', containerId, '/bin/sh', '-c', script, 'probe', ...args], { allowFailure: true });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
function targetMountPoints(containerId) {
    const text = podman(['container', 'exec', containerId, '/bin/cat', '/proc/1/mountinfo']).stdout;
    return text.split('\n').filter(Boolean).map((line) => {
        const fields = line.split(' ');
        return { mountId: fields[0], point: fields[4].replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8))) };
    });
}

// Own /proc reader (the product reader does not return ppid).
function readProc(pid) {
    try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        const uid = Number(/^Uid:\s+(\d+)/m.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))[1]);
        const argv = fs.readFileSync(`/proc/${pid}/cmdline`).toString('utf8').split('\0').filter(Boolean);
        return { pid, state: rest[0], ppid: Number(rest[1]), pgrp: Number(rest[2]), sid: Number(rest[3]), uid,
            startToken: `linux-proc:${rest[19]}`, argv };
    } catch { return null; }
}
function scanProc(predicate) {
    const found = [];
    for (const name of fs.readdirSync('/proc')) {
        if (!/^[1-9][0-9]*$/.test(name)) continue;
        const observed = readProc(Number(name));
        if (observed && observed.pid !== process.pid && predicate(observed)) found.push(observed);
    }
    return found;
}
function withNonce(nonce) { return scanProc((p) => p.argv.includes(nonce)); }

class Recorder {
    constructor() { this.seen = new Map(); this.nonce = null; this.leader = null; this.timer = null; }
    begin(nonce) {
        this.nonce = nonce;
        this.timer = setInterval(() => this.sample('interval'), 20);
    }
    sample(tag) {
        if (!this.nonce) return;
        for (const p of scanProc((q) => q.argv.includes(this.nonce) || (this.leader && q.sid === this.leader))) {
            const key = `${p.pid}:${p.startToken}`;
            const entry = this.seen.get(key) || { pid: p.pid, ppid: p.ppid, pgrp: p.pgrp, sid: p.sid, uid: p.uid,
                startToken: p.startToken, argv: p.argv, states: [], firstSeen: tag };
            if (!entry.states.includes(p.state)) entry.states.push(p.state);
            entry.ppid = p.ppid;
            // A zombie reports an empty argv; keep the last real one.
            if (p.argv.length) entry.argv = p.argv;
            entry.lastSeen = tag;
            this.seen.set(key, entry);
        }
    }
    stop() { clearInterval(this.timer); this.sample('final'); return [...this.seen.values()]; }
}

// In-memory fake journal: records every helper state and receipt, and every
// callback returns exactly true as the broker requires.
function makeJournal(label, hooks = {}) {
    const journal = { label, helperStates: [], receipts: [], recorder: new Recorder() };
    const stage = (name) => async (receipt) => {
        journal.receipts.push({ at: Date.now(), stage: receipt.stage, receipt: clone(receipt) });
        journal.recorder.sample(`receipt:${receipt.stage}`);
        await hooks[name]?.(receipt, journal);
        return true;
    };
    journal.onHelper = async (state) => {
        journal.helperStates.push({ at: Date.now(), state: clone(state) });
        if (state && !journal.recorder.nonce) journal.recorder.begin(state.nonce);
        if (state?.pid) journal.recorder.leader = state.pid;
        journal.recorder.sample(`helper:${state ? (state.pid ? 'pid' : 'nonce') : 'null'}`);
        await hooks.onHelper?.(state, journal);
        return true;
    };
    journal.onIntent = stage('onIntent');
    journal.onDirectory = stage('onDirectory');
    journal.onPrepared = stage('onPrepared');
    journal.onAttached = stage('onAttached');
    journal.callbacks = { onHelper: journal.onHelper, onIntent: journal.onIntent, onDirectory: journal.onDirectory,
        onPrepared: journal.onPrepared, onAttached: journal.onAttached };
    journal.summary = () => ({ label, helperStates: journal.helperStates.map((e) => e.state),
        receiptStages: journal.receipts.map((e) => e.stage), tree: journal.recorder.stop() });
    return journal;
}

async function findPython(nonce, leader, waitMs = 15_000) {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
        const hits = scanProc((p) => p.argv[0] === '/usr/bin/python3' && p.argv.includes(nonce) && p.sid === leader && p.state !== 'Z');
        if (hits.length === 1) return hits[0];
        await sleep(10);
    }
    throw new Error('python helper member was not found');
}
async function stopPython(nonce, leader) {
    const python = await findPython(nonce, leader);
    process.kill(python.pid, 'SIGSTOP');
    const deadline = Date.now() + 3_000;
    let observed = readProc(python.pid);
    while (observed && observed.state !== 'T' && Date.now() < deadline) { await sleep(10); observed = readProc(python.pid); }
    return { python, afterStop: observed };
}

const createdTargets = [];
const signals = [];
const signalling = (pid, name) => { signals.push({ at: Date.now(), pid, name }); return process.kill(pid, name); };
function makeBroker(options = {}) { return createHomeMountBroker({ signal: signalling, ...options }); }

async function expectRejection(promise) {
    try { await promise; } catch (error) { return error; }
    return null;
}

try {
    emit('start', { workspace, uid: process.getuid(), pid: process.pid });
    steps.sources = Object.fromEntries(fs.readdirSync(CORE).filter((n) => /\.(?:mjs|js|py)$/.test(n)).sort()
        .map((n) => [n, sha256(path.join(CORE, n))]));
    steps.driver = sha256('/opt/ploinky/tests/integration/webttyHomeMountBrokerNative.driver.mjs');

    const image = JSON.parse(podman(['image', 'inspect', NODE_IMAGE]).stdout)[0];
    must('setup', 'nested store holds the pinned node image id', image.Id.replace(/^sha256:/, '') === NODE_IMAGE_ID, { id: image.Id, digest: image.Digest, names: image.RepoDigests });

    // Fixture layout mirrors the composed terminal fixture.
    const privateRoot = path.join(workspace, '.data/.private/brokerNative');
    const home = path.join(privateRoot, 'robots/robot-a/home');
    const siblingHome = path.join(privateRoot, 'robots/robot-b/home');
    const project = path.join(workspace, 'projects', 'broker-native', 'nested');
    const nonce = crypto.randomBytes(16).toString('hex');
    const siblingNonce = crypto.randomBytes(16).toString('hex');
    const parentNonce = crypto.randomBytes(16).toString('hex');
    for (const directory of [home, siblingHome]) { fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); fs.chmodSync(directory, 0o700); }
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(home, 'original-marker'), nonce, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(siblingHome, 'sibling-marker'), siblingNonce, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(workspace, '.data/.private/parent-marker'), parentNonce, { flag: 'wx', mode: 0o600 });
    fs.symlinkSync(path.join(workspace, '.data/.private/parent-marker'), path.join(home, 'escape'));
    const homeEntries = fs.readdirSync(home).sort();
    const originalHome = identity(home);
    const originalOwnership = ownership(home);
    must('setup', 'home directory is 0700', originalOwnership.mode === 0o700, originalOwnership);

    // Nested rootless target, as in the composed fixture.
    const bindings = [{ hostPath: workspace, runtimePath: workspace, readOnly: false },
        { hostPath: project, runtimePath: project, readOnly: false }];
    const guards = controllerGuardMounts(controllerGuardTargets(bindings, { workspaceRoot: workspace }), { workspaceRoot: workspace, bindings });
    const mounts = ['-v', `${workspace}:${workspace}:rw`, '-v', `${project}:${project}:rw`];
    for (const guard of guards) mounts.push('-v', `${guard.source}:${guard.target}:${guard.readOnly ? 'ro' : 'rw'}`);
    const createTarget = (label) => {
        const name = `broker-native-${stamp}-${label}`;
        const id = podman(['container', 'create', '--name', name, '--init', '--entrypoint', '/bin/sh',
            '--userns', managedImageUserNamespace('1000:1000'), ...mounts, NODE_IMAGE, '-c', 'exec sleep 900']).stdout.trim();
        must('setup', `target container id (${label})`, /^[a-f0-9]{64}$/.test(id), id);
        createdTargets.push({ id, name });
        podman(['container', 'start', id]);
        const running = inspect(id);
        must('setup', `target ${label} runs the pinned image`, running.State.Running === true && running.Image.replace(/^sha256:/, '') === NODE_IMAGE_ID, { pid: running.State.Pid });
        return { id, name, initPid: running.State.Pid };
    };
    const main = createTarget('main');
    const containerId = main.id;
    steps.target = { containerId, name: main.name, initPid: main.initPid, guards: guards.length };
    const target = { runtime: 'podman', containerId, translatedCwd: project };
    const homeInput = { absolutePath: home, identity: originalHome };
    const sessionId = crypto.randomBytes(24).toString('base64url');
    const destination = `${DESTINATION_PREFIX}${sessionId}`;

    // ---- Step 1: prepare -------------------------------------------------
    const broker = makeBroker();
    const prepareJournal = makeJournal('prepare');
    const prepared = await broker.prepare({ target, home: homeInput, sessionId, ...prepareJournal.callbacks });
    const prepareSummary = prepareJournal.summary();
    steps.prepare = { ...prepareSummary, destination: prepared.home, signals: clone(signals) };
    check('1.prepare', 'returns the destination path', prepared.home === destination, prepared.home);
    check('1.prepare', 'receipt stages are intent,directory,prepared,attached',
        JSON.stringify(prepareSummary.receiptStages) === JSON.stringify(['intent', 'directory', 'prepared', 'attached']), prepareSummary.receiptStages);
    const states = prepareSummary.helperStates;
    check('1.prepare', 'onHelper sequence is nonce, nonce+pid, null',
        states.length === 3 && states[2] === null
        && Object.keys(states[0]).sort().join() === 'nonce,operation' && states[0].operation === 'prepare'
        && Object.keys(states[1]).sort().join() === 'nonce,operation,pid,startToken,uid'
        && states[1].nonce === states[0].nonce && states[1].operation === 'prepare'
        && states[1].uid === process.getuid() && states[1].pid > 1 && /^linux-proc:\d+$/.test(states[1].startToken), states);
    const tree = prepareSummary.tree;
    const leader = tree.find((p) => p.pid === states[1]?.pid);
    check('1.prepare', 'helper tree includes a podman session leader (sid==pgrp==pid)',
        Boolean(leader && leader.sid === leader.pid && leader.pgrp === leader.pid && leader.argv[0] === '/usr/bin/podman' && leader.argv[1] === 'unshare'), leader);
    check('1.prepare', 'helper tree includes the python member in the leader session',
        tree.some((p) => p.argv[0] === '/usr/bin/python3' && p.sid === states[1]?.pid), tree.map((p) => `${p.pid}/${p.ppid}/${p.sid}`));
    check('1.prepare', 'no helper process remains after prepare', withNonce(states[0].nonce).length === 0);

    const finalReceipt = prepared.receipt;
    const inode = inTarget(containerId, 'stat -Lc %d:%i "$1"', destination);
    check('1.prepare', 'target stat of destination equals the source identity',
        inode.status === 0 && inode.stdout.trim() === `${originalHome.dev}:${originalHome.ino}`, { target: inode.stdout.trim(), source: originalHome });
    const listing = inTarget(containerId, 'ls -A "$1"', destination);
    check('1.prepare', 'destination lists exactly the home entries',
        listing.status === 0 && JSON.stringify(listing.stdout.split('\n').filter(Boolean).sort()) === JSON.stringify(homeEntries), listing.stdout);
    const marker = inTarget(containerId, 'cat "$1/original-marker"', destination);
    check('1.prepare', 'original marker readable through the projection', marker.stdout === nonce, marker.stderr);
    const writeNonce = crypto.randomBytes(16).toString('hex');
    const write = inTarget(containerId, 'printf %s "$2" > "$1/browser-writeback"', destination, writeNonce);
    check('1.prepare', 'write-back from the target succeeds', write.status === 0, write.stderr);
    check('1.prepare', 'write-back visible on the source side (in Box)',
        fs.existsSync(path.join(home, 'browser-writeback')) && fs.readFileSync(path.join(home, 'browser-writeback'), 'utf8') === writeNonce);
    steps.writeNonce = writeNonce;
    const sibling = inTarget(containerId, 'test ! -r "$1"; echo $?', path.join(siblingHome, 'sibling-marker'));
    check('1.prepare', 'sibling marker is unreadable in the target', sibling.stdout.trim() === '0', sibling);
    const siblingScan = inTarget(containerId, 'grep -rlF "$1" /run 2>/dev/null; echo done', siblingNonce);
    check('1.prepare', 'sibling nonce is nowhere under target /run', siblingScan.stdout.trim() === 'done', siblingScan.stdout);
    const parent = inTarget(containerId, 'test ! -r "$1"; echo $?', path.join(workspace, '.data/.private/parent-marker'));
    check('1.prepare', 'parent marker is unreadable in the target', parent.stdout.trim() === '0', parent);
    const escape = inTarget(containerId, 'test ! -r "$1/escape"; echo $?', destination);
    check('1.prepare', 'escape symlink is unreadable through the projection', escape.stdout.trim() === '0', escape);
    const privateView = inTarget(containerId, 'ls -A "$1" 2>&1; echo rc=$?', path.join(workspace, '.data/.private'));
    steps.targetPrivateView = privateView.stdout;
    const mountEntry = targetMountPoints(containerId).filter((m) => m.point === destination);
    check('1.prepare', 'target mountinfo has one mount at the destination with the receipt mount id',
        mountEntry.length === 1 && mountEntry[0].mountId === finalReceipt.mountId, { mountEntry, mountId: finalReceipt.mountId });
    check('1.prepare', 'source owner/mode/identity unchanged',
        JSON.stringify(ownership(home)) === JSON.stringify(originalOwnership) && JSON.stringify(identity(home)) === JSON.stringify(originalHome),
        { before: originalOwnership, after: ownership(home) });
    steps.mountedReceipt = finalReceipt;

    // ---- Step 2: validate --------------------------------------------------
    const validateJournal = makeJournal('validate');
    const validated = await broker.validate({ target, receipt: finalReceipt, home: homeInput, onHelper: validateJournal.onHelper });
    steps.validate = validateJournal.summary();
    check('2.validate', 'returns true', validated === true, validated);
    const vs = steps.validate.helperStates;
    check('2.validate', 'onHelper sequence is nonce, nonce+pid, null',
        vs.length === 3 && vs[2] === null && vs[0].operation === 'validate' && vs[1].operation === 'validate' && vs[1].pid > 1 && vs[1].nonce === vs[0].nonce, vs);
    check('2.validate', 'mount still present after validate', targetMountPoints(containerId).some((m) => m.point === destination));

    // ---- Step 3: release ----------------------------------------------------
    const releaseJournal = makeJournal('release');
    const released = await broker.release({ target, receipt: finalReceipt, home: homeInput, onHelper: releaseJournal.onHelper });
    steps.release = releaseJournal.summary();
    check('3.release', 'returns true', released === true, released);
    const rs = steps.release.helperStates;
    check('3.release', 'onHelper sequence is nonce, nonce+pid, null',
        rs.length === 3 && rs[2] === null && rs[0].operation === 'release' && rs[1].pid > 1, rs);
    const gone = inTarget(containerId, 'test ! -e "$1" && test ! -L "$1"', destination);
    check('3.release', 'destination absent in the target', gone.status === 0, gone);
    check('3.release', 'destination not in target mountinfo', !targetMountPoints(containerId).some((m) => m.point === destination));
    check('3.release', 'source intact (marker, write-back, identity, owner/mode)',
        fs.readFileSync(path.join(home, 'original-marker'), 'utf8') === nonce
        && fs.readFileSync(path.join(home, 'browser-writeback'), 'utf8') === writeNonce
        && JSON.stringify(identity(home)) === JSON.stringify(originalHome) && JSON.stringify(ownership(home)) === JSON.stringify(originalOwnership));
    check('3.release', 'no helper process remains after release', withNonce(rs[0].nonce).length === 0);

    // ---- Step 4a: R7 stall at the pid state --------------------------------
    {
        const sid = crypto.randomBytes(24).toString('base64url');
        const dest = `${DESTINATION_PREFIX}${sid}`;
        const before = signals.length;
        let stalled = null;
        const journal = makeJournal('r7-pid-stall', {
            async onHelper(state) {
                if (state?.pid && !stalled) {
                    stalled = await stopPython(state.nonce, state.pid);
                    // Negative control: the scan can see the stopped member.
                    stalled.visibleStopped = withNonce(state.nonce).some((p) => p.state === 'T' && p.pid === stalled.python.pid);
                }
            },
        });
        const stalledBroker = makeBroker({ timeoutMs: 5_000 });
        const started4 = Date.now();
        const error = await expectRejection(stalledBroker.prepare({ target, home: homeInput, sessionId: sid, ...journal.callbacks }));
        const elapsed = Date.now() - started4;
        const summary = journal.summary();
        const sent = signals.slice(before);
        steps.r7PidStall = { ...summary, elapsedMs: elapsed, error: error && { code: error.code, message: error.message, reason: error.reason },
            stalledPython: stalled && { pid: stalled.python.pid, argv: stalled.python.argv, afterStop: stalled.afterStop, visibleStopped: stalled.visibleStopped }, signals: sent };
        check('4a.r7-stall', 'python member was SIGSTOPped (state T) and visible to the nonce scan', stalled?.afterStop?.state === 'T' && stalled.visibleStopped === true, stalled?.afterStop);
        check('4a.r7-stall', 'prepare rejected with WEBTTY_HOME_PROJECTION_UNPROVEN', error?.code === 'WEBTTY_HOME_PROJECTION_UNPROVEN', error && { code: error.code, message: error.message });
        check('4a.r7-stall', 'rejection is the helper timeout, not an unproven exit', error?.reason !== 'helper_exit_unproven' && /timed out/.test(error?.message || ''), error && { message: error.message, reason: error.reason });
        check('4a.r7-stall', 'SIGTERM then SIGKILL were sent and SIGKILL reached the stopped python',
            sent.some((s) => s.name === 'SIGTERM') && sent.some((s) => s.name === 'SIGKILL' && s.pid === stalled?.python.pid), sent);
        const states4 = summary.helperStates;
        check('4a.r7-stall', 'onHelper ended with null after the nonce and pid states',
            states4.length === 3 && states4[2] === null && states4[1]?.pid > 1, states4);
        check('4a.r7-stall', 'no process in /proc carries the nonce afterwards', withNonce(states4[0].nonce).length === 0, withNonce(states4[0].nonce));
        const dir = inTarget(containerId, 'test ! -e "$1" && test ! -L "$1"', dest);
        const leftover = dir.status === 0 ? 'absent' : 'present';
        steps.r7PidStall.destination = leftover;
        if (leftover === 'present') {
            const last = journal.receipts.at(-1);
            const recoverJournal = makeJournal('r7-pid-stall-recover');
            const recovered = last ? await stalledBroker.recover({ target, receipt: last.receipt, home: homeInput, onHelper: recoverJournal.onHelper }) : false;
            check('4a.r7-stall', 'partial destination recovered from the last journaled receipt', recovered === true, last?.stage);
            check('4a.r7-stall', 'destination absent after recovery', inTarget(containerId, 'test ! -e "$1" && test ! -L "$1"', dest).status === 0);
        } else {
            check('4a.r7-stall', 'no partial destination (stall preceded directory creation)', true, { receiptStages: summary.receiptStages });
        }
        check('4a.r7-stall', 'no destination mount in target', !targetMountPoints(containerId).some((m) => m.point === dest));
    }

    // ---- Step 4b: stall after the directory exists, recover by release --------
    {
        const sid = crypto.randomBytes(24).toString('base64url');
        const dest = `${DESTINATION_PREFIX}${sid}`;
        const before = signals.length;
        let stalled = null;
        const journal = makeJournal('r7-directory-stall', {
            async onDirectory() {
                if (!stalled) stalled = await stopPython(journal.recorder.nonce, journal.recorder.leader);
            },
        });
        const stalledBroker = makeBroker({ timeoutMs: 5_000 });
        const error = await expectRejection(stalledBroker.prepare({ target, home: homeInput, sessionId: sid, ...journal.callbacks }));
        const summary = journal.summary();
        const sent = signals.slice(before);
        steps.r7DirectoryStall = { ...summary, error: error && { code: error.code, message: error.message, reason: error.reason }, signals: sent };
        check('4b.r7-directory', 'prepare rejected with WEBTTY_HOME_PROJECTION_UNPROVEN after the directory receipt',
            error?.code === 'WEBTTY_HOME_PROJECTION_UNPROVEN' && error?.reason !== 'helper_exit_unproven' && summary.receiptStages.at(-1) === 'directory', { code: error?.code, message: error?.message, stages: summary.receiptStages });
        check('4b.r7-directory', 'SIGKILL reached the stopped python', sent.some((s) => s.name === 'SIGKILL' && s.pid === stalled?.python.pid), sent);
        check('4b.r7-directory', 'no process carries the nonce afterwards', withNonce(summary.helperStates[0].nonce).length === 0);
        const present = inTarget(containerId, 'test -d "$1" && ls -A "$1" | wc -l', dest);
        check('4b.r7-directory', 'partially created destination directory is still present and empty (journaled)', present.status === 0 && present.stdout.trim() === '0', present);
        const last = journal.receipts.at(-1);
        const recoverJournal = makeJournal('r7-directory-recover');
        const recovered = await stalledBroker.release({ target, receipt: last.receipt, home: homeInput, onHelper: recoverJournal.onHelper });
        steps.r7DirectoryRecover = recoverJournal.summary();
        check('4b.r7-directory', 'release on the last journaled receipt returns true', recovered === true, recovered);
        check('4b.r7-directory', 'destination absent after recovery', inTarget(containerId, 'test ! -e "$1" && test ! -L "$1"', dest).status === 0);
    }

    // ---- Step 5: spawn-gap recovery ---------------------------------------------
    {
        const absentNonce = crypto.randomBytes(24).toString('base64url');
        check('5.reclaim', 'fixture nonce is 32 base64url characters', /^[A-Za-z0-9_-]{32}$/.test(absentNonce));
        const absent = await makeBroker().reclaimHelper({ ownership: { nonce: absentNonce, operation: 'prepare' } });
        check('5.reclaim', 'nonce-only ownership for a never-spawned nonce reports absent (true)', absent === true, absent);
        const negative = await expectRejection(makeBroker().reclaimHelper({ ownership: { nonce: absentNonce, operation: 'prepare', pid: 4242, startToken: 'linux-proc:1', uid: 999 } }));
        check('5.reclaim', 'negative control: foreign uid ownership is refused as exit-unproven', negative?.reason === 'helper_exit_unproven', negative && { code: negative.code, reason: negative.reason });

        for (const form of ['complete', 'nonce-only']) {
            const sid = crypto.randomBytes(24).toString('base64url');
            const before = signals.length;
            let stalled = null;
            let reclaim = null;
            const journal = makeJournal(`live-${form}`, {
                async onHelper(state) {
                    if (!state?.pid || stalled) return;
                    stalled = await stopPython(state.nonce, state.pid);
                    // Simulated restart: a second broker reclaims the live, stopped helper.
                    const ownership = form === 'complete' ? clone(state) : { nonce: state.nonce, operation: state.operation };
                    reclaim = { ownership };
                    try { reclaim.result = await makeBroker().reclaimHelper({ ownership }); } catch (error) {
                        reclaim.error = { code: error.code, reason: error.reason, message: error.message,
                            cause: error.cause && { code: error.cause.code, message: error.cause.message } };
                    }
                    if (reclaim.error) {
                        reclaim.retryAfterFailure = { leftover: scanProc((p) => p.argv.includes(state.nonce)).map((p) => ({ pid: p.pid, ppid: p.ppid, sid: p.sid, state: p.state })) };
                        try { reclaim.retryAfterFailure.result = await makeBroker().reclaimHelper({ ownership }); } catch (error) {
                            reclaim.retryAfterFailure.error = { reason: error.reason, cause: error.cause && error.cause.message };
                        }
                    }
                    reclaim.leftover = scanProc((p) => p.argv.includes(state.nonce)).map((p) => ({ pid: p.pid, ppid: p.ppid, sid: p.sid, state: p.state, argv0: p.argv[0] }));
                },
            });
            const error = await expectRejection(makeBroker({ timeoutMs: 5_000 }).prepare({ target, home: homeInput, sessionId: sid, ...journal.callbacks }));
            const summary = journal.summary();
            steps[`reclaimLive_${form}`] = { ...summary, reclaim, error: error && { code: error.code, message: error.message, reason: error.reason },
                stalledPython: stalled && { pid: stalled.python.pid, argv: stalled.python.argv, afterStop: stalled.afterStop }, signals: signals.slice(before) };
            check(`5.reclaim-${form}`, 'python was stopped (T) before reclaim', stalled?.afterStop?.state === 'T', stalled?.afterStop);
            check(`5.reclaim-${form}`, 'reclaimHelper on the live stopped helper returns true with no process left',
                reclaim?.result === true && reclaim.leftover.length === 0, reclaim);
            check(`5.reclaim-${form}`, 'SIGKILL was delivered to the stopped python by the reclaiming broker',
                signals.slice(before).some((s) => s.name === 'SIGKILL' && s.pid === stalled?.python.pid), signals.slice(before));
            check(`5.reclaim-${form}`, 'the original prepare rejects without an unproven exit and its journal ends in null',
                Boolean(error) && error.reason !== 'helper_exit_unproven' && summary.helperStates.at(-1) === null, error && { code: error.code, message: error.message, reason: error.reason });
            check(`5.reclaim-${form}`, 'no process carries the nonce afterwards', withNonce(summary.helperStates[0].nonce).length === 0);
            check(`5.reclaim-${form}`, 'no destination left behind', inTarget(containerId, 'test ! -e "$1"', `${DESTINATION_PREFIX}${sid}`).status === 0);
        }
    }

    // ---- Step 6: two concurrent prepares, same target and same home -------------
    {
        const sids = [crypto.randomBytes(24).toString('base64url'), crypto.randomBytes(24).toString('base64url')];
        const dests = sids.map((id) => `${DESTINATION_PREFIX}${id}`);
        const entriesBefore = fs.readdirSync(home).sort();
        const journals = sids.map((_, i) => makeJournal(`concurrent-${i}`));
        const concurrentBroker = makeBroker();
        const settled = await Promise.allSettled(sids.map((sid, i) => concurrentBroker.prepare({ target, home: homeInput, sessionId: sid, ...journals[i].callbacks })));
        const summaries = journals.map((journal) => journal.summary());
        const fulfilled = settled.every((result) => result.status === 'fulfilled');
        steps.concurrent = { summaries, outcomes: settled.map((r) => (r.status === 'fulfilled' ? { home: r.value.home, mountId: r.value.receipt.mountId }
            : { code: r.reason?.code, message: r.reason?.message, reason: r.reason?.reason })) };
        check('6.concurrent', 'both concurrent prepares attached', fulfilled, steps.concurrent.outcomes);
        const attached = settled.filter((r) => r.status === 'fulfilled').map((r) => r.value.receipt);
        if (fulfilled) {
            const [a, b] = attached;
            const times = summaries.map((_, i) => ({ start: journals[i].helperStates[1]?.at, end: journals[i].helperStates.at(-1)?.at }));
            check('6.concurrent', 'the two prepares overlapped in time', times[0].start < times[1].end && times[1].start < times[0].end, times);
            check('6.concurrent', 'destinations are distinct and match the session ids', a.destination.path === dests[0] && b.destination.path === dests[1] && dests[0] !== dests[1], dests);
            check('6.concurrent', 'mount ids are distinct', a.mountId !== b.mountId, [a.mountId, b.mountId]);
            check('6.concurrent', 'helper nonces are distinct', summaries[0].helperStates[0].nonce !== summaries[1].helperStates[0].nonce);
            check('6.concurrent', 'each journal has the full stage and helper-state sequence',
                summaries.every((s) => JSON.stringify(s.receiptStages) === JSON.stringify(['intent', 'directory', 'prepared', 'attached'])
                    && s.helperStates.length === 3 && s.helperStates[2] === null && s.helperStates[1].pid > 1), summaries.map((s) => s.receiptStages));
            const mountsNow = targetMountPoints(containerId);
            check('6.concurrent', 'target mountinfo has one mount per destination with the receipt mount id',
                dests.every((d, i) => mountsNow.filter((m) => m.point === d).length === 1 && mountsNow.find((m) => m.point === d).mountId === attached[i].mountId), mountsNow.filter((m) => m.point.startsWith(DESTINATION_PREFIX)));
            const tokenA = crypto.randomBytes(8).toString('hex');
            const tokenB = crypto.randomBytes(8).toString('hex');
            const viaA = inTarget(containerId, 'printf %s "$3" > "$1/concurrent-marker" && cat "$2/concurrent-marker"', dests[0], dests[1], tokenA);
            check('6.concurrent', 'a write through destination A is visible through destination B', viaA.status === 0 && viaA.stdout === tokenA, viaA);
            check('6.concurrent', 'the write is visible at the source', fs.readFileSync(path.join(home, 'concurrent-marker'), 'utf8') === tokenA);
            const viaB = inTarget(containerId, 'printf %s "$3" > "$2/concurrent-marker" && cat "$1/concurrent-marker"', dests[0], dests[1], tokenB);
            check('6.concurrent', 'a write through destination B is visible through destination A and at the source',
                viaB.status === 0 && viaB.stdout === tokenB && fs.readFileSync(path.join(home, 'concurrent-marker'), 'utf8') === tokenB, viaB);
            const releaseA = makeJournal('concurrent-release-A');
            check('6.concurrent', 'release of A returns true', await makeBroker().release({ target, receipt: a, home: homeInput, onHelper: releaseA.onHelper }) === true);
            steps.concurrentReleaseA = releaseA.summary();
            check('6.concurrent', 'destination A is absent and not mounted', inTarget(containerId, 'test ! -e "$1" && test ! -L "$1"', dests[0]).status === 0
                && !targetMountPoints(containerId).some((m) => m.point === dests[0]));
            check('6.concurrent', 'destination B is still mounted and readable',
                targetMountPoints(containerId).some((m) => m.point === dests[1])
                && inTarget(containerId, 'cat "$1/original-marker"', dests[1]).stdout === nonce
                && inTarget(containerId, 'cat "$1/concurrent-marker"', dests[1]).stdout === tokenB);
            const validateB = makeJournal('concurrent-validate-B');
            check('6.concurrent', 'validate of B still returns true after A is released', await makeBroker().validate({ target, receipt: b, home: homeInput, onHelper: validateB.onHelper }) === true);
            steps.concurrentValidateB = validateB.summary();
            const releaseB = makeJournal('concurrent-release-B');
            check('6.concurrent', 'release of B returns true', await makeBroker().release({ target, receipt: b, home: homeInput, onHelper: releaseB.onHelper }) === true);
            steps.concurrentReleaseB = releaseB.summary();
        } else {
            // Best-effort recovery of whatever the failed run left, from the journals.
            for (const journal of journals) {
                const last = journal.receipts.at(-1);
                if (last) await makeBroker().release({ target, receipt: last.receipt, home: homeInput, onHelper: makeJournal('concurrent-recover').onHelper }).catch(() => {});
            }
            for (const receipt of attached) await makeBroker().release({ target, receipt, home: homeInput, onHelper: makeJournal('concurrent-recover').onHelper }).catch(() => {});
        }
        fs.rmSync(path.join(home, 'concurrent-marker'), { force: true });
        check('6.concurrent', 'both destinations are absent and nothing is mounted under /run',
            dests.every((d) => inTarget(containerId, 'test ! -e "$1" && test ! -L "$1"', d).status === 0)
            && !targetMountPoints(containerId).some((m) => m.point.startsWith(DESTINATION_PREFIX)));
        check('6.concurrent', 'no helper process remains', summaries.every((s) => withNonce(s.helperStates[0].nonce).length === 0));
        check('6.concurrent', 'source entries, identity and owner/mode are unchanged',
            JSON.stringify(fs.readdirSync(home).sort()) === JSON.stringify(entriesBefore)
            && JSON.stringify(identity(home)) === JSON.stringify(originalHome) && JSON.stringify(ownership(home)) === JSON.stringify(originalOwnership));
    }

    // ---- Step 7: source home deleted and recreated while attached -------------------
    {
        const sid = crypto.randomBytes(24).toString('base64url');
        const dest = `${DESTINATION_PREFIX}${sid}`;
        const old = `${home}.old`;
        const entriesBefore = fs.readdirSync(home).sort();
        const prepareJournal = makeJournal('replace-prepare');
        const prepared7 = await makeBroker().prepare({ target, home: homeInput, sessionId: sid, ...prepareJournal.callbacks });
        steps.replacePrepare = prepareJournal.summary();
        check('7.replace', 'prepare attached before the replacement', prepared7.receipt.stage === 'attached' && prepared7.home === dest);
        let released7 = false;
        let newIdentity = null;
        let newOwnership = null;
        try {
            fs.renameSync(home, old);
            fs.mkdirSync(home, { mode: 0o700 });
            fs.chmodSync(home, 0o700);
            newIdentity = identity(home);
            newOwnership = ownership(home);
            check('7.replace', 'the replacement is a different inode at the same path', newIdentity.ino !== originalHome.ino || newIdentity.dev !== originalHome.dev, { originalHome, newIdentity });
            const rejected = makeJournal('replace-validate');
            const rejection = await expectRejection(makeBroker().validate({ target, receipt: prepared7.receipt, home: homeInput, onHelper: rejected.onHelper }));
            steps.replaceValidate = { error: rejection && { code: rejection.code, message: rejection.message, reason: rejection.reason }, helperStates: rejected.helperStates.length };
            check('7.replace', 'validate rejects with a source identity change', rejection?.code === 'WEBTTY_HOME_PROJECTION_UNPROVEN' && /identity changed/.test(rejection?.message || ''), rejection && { code: rejection.code, message: rejection.message });
            check('7.replace', 'the rejected validate spawned no helper', rejected.helperStates.length === 0);
            const pinned = makeJournal('replace-validate-new-identity');
            const mismatch = await expectRejection(makeBroker().validate({ target, receipt: prepared7.receipt, home: { absolutePath: home, identity: newIdentity }, onHelper: pinned.onHelper }));
            check('7.replace', 'validate against the replacement identity is rejected as not matching the receipt',
                mismatch?.code === 'WEBTTY_HOME_PROJECTION_UNPROVEN' && /does not match receipt/.test(mismatch?.message || '') && pinned.helperStates.length === 0, mismatch && { code: mismatch.code, message: mismatch.message });
            const inode7 = inTarget(containerId, 'stat -Lc %d:%i "$1"', dest);
            check('7.replace', 'the projection still shows the OLD inode, not the replacement',
                inode7.stdout.trim() === `${originalHome.dev}:${originalHome.ino}` && inode7.stdout.trim() !== `${newIdentity.dev}:${newIdentity.ino}`, { target: inode7.stdout.trim(), originalHome, newIdentity });
            const listing7 = inTarget(containerId, 'ls -A "$1"', dest);
            check('7.replace', 'the projection still lists the OLD content', JSON.stringify(listing7.stdout.split('\n').filter(Boolean).sort()) === JSON.stringify(entriesBefore), listing7.stdout);
            check('7.replace', 'the old marker is readable through the projection', inTarget(containerId, 'cat "$1/original-marker"', dest).stdout === nonce);
            const token = crypto.randomBytes(8).toString('hex');
            const write7 = inTarget(containerId, 'printf %s "$2" > "$1/after-replace-writeback"', dest, token);
            check('7.replace', 'a write through the projection lands in the old directory, not the replacement',
                write7.status === 0 && fs.readFileSync(path.join(old, 'after-replace-writeback'), 'utf8') === token && fs.readdirSync(home).length === 0, write7);
            const releaseJournal = makeJournal('replace-release');
            const releaseResult = await makeBroker().release({ target, receipt: prepared7.receipt, home: homeInput, onHelper: releaseJournal.onHelper });
            released7 = releaseResult === true;
            steps.replaceRelease = releaseJournal.summary();
            check('7.replace', 'release with the receipt succeeds', releaseResult === true, releaseResult);
            check('7.replace', 'the destination is absent and not mounted after release', inTarget(containerId, 'test ! -e "$1" && test ! -L "$1"', dest).status === 0
                && !targetMountPoints(containerId).some((m) => m.point === dest));
            check('7.replace', 'the replacement directory is untouched (empty, same inode, owner/mode)',
                fs.readdirSync(home).length === 0 && JSON.stringify(identity(home)) === JSON.stringify(newIdentity) && JSON.stringify(ownership(home)) === JSON.stringify(newOwnership));
            check('7.replace', 'the old directory content is intact',
                fs.readFileSync(path.join(old, 'original-marker'), 'utf8') === nonce && fs.existsSync(path.join(old, 'after-replace-writeback')));
        } finally {
            if (!released7) await makeBroker().release({ target, receipt: prepared7.receipt, home: homeInput, onHelper: makeJournal('replace-recover').onHelper }).catch(() => {});
            let restored = false;
            try {
                fs.rmSync(path.join(old, 'after-replace-writeback'), { force: true });
                if (fs.existsSync(old)) {
                    if (fs.existsSync(home) && fs.readdirSync(home).length === 0) fs.rmdirSync(home);
                    fs.renameSync(old, home);
                }
                restored = JSON.stringify(identity(home)) === JSON.stringify(originalHome)
                    && JSON.stringify(fs.readdirSync(home).sort()) === JSON.stringify(entriesBefore);
            } catch (_) { restored = false; }
            check('7.replace', 'the original home is restored (same inode and entries)', restored);
        }
    }

    // ---- Step 8: failed start (target stopped) --------------------------------------
    {
        const second = createTarget('second');
        const secondTarget = { runtime: 'podman', containerId: second.id, translatedCwd: project };
        const noRunDestination = () => {
            const listing = inTarget(second.id, 'ls -A /run', 'probe');
            return listing.status === 0 && !listing.stdout.split('\n').some((entry) => entry.startsWith('ploinky-webtty-home-'));
        };
        const helperProcesses = () => scanProc((p) => p.argv.some((argument) => argument.endsWith('/homeMountHelper.py')));
        const restart = () => { podman(['container', 'start', second.id]); return inspect(second.id).State.Running === true; };

        // 8a: stopped before prepare.
        podman(['container', 'stop', '-t', '1', second.id]);
        check('8a.stopped-before', 'the second target is stopped', inspect(second.id).State.Running === false);
        const sidA = crypto.randomBytes(24).toString('base64url');
        const journalA = makeJournal('failed-start-before');
        const errorA = await expectRejection(makeBroker().prepare({ target: secondTarget, home: homeInput, sessionId: sidA, ...journalA.callbacks }));
        steps.failedStartBefore = { error: errorA && { code: errorA.code, message: errorA.message, reason: errorA.reason }, helperStates: journalA.helperStates.map((e) => e.state), receipts: journalA.receipts.map((e) => e.stage) };
        check('8a.stopped-before', 'prepare rejects because the target is not running', errorA?.code === 'WEBTTY_HOME_PROJECTION_UNPROVEN' && /target not running/.test(errorA?.message || ''), errorA && { code: errorA.code, message: errorA.message });
        check('8a.stopped-before', 'no helper ownership was recorded (no stale ownership) and no receipt', journalA.helperStates.length === 0 && journalA.receipts.length === 0);
        check('8a.stopped-before', 'no helper process exists', helperProcesses().length === 0, helperProcesses());
        check('8a.stopped-before', 'the target restarts', restart());
        check('8a.stopped-before', 'no /run destination exists after the restart', noRunDestination());

        // 8b: the target stops after the helper was spawned and recorded.
        const sidB = crypto.randomBytes(24).toString('base64url');
        let stoppedMidway = false;
        const journalB = makeJournal('failed-start-midway', {
            async onHelper(state) {
                if (state?.pid && !stoppedMidway) { stoppedMidway = true; podman(['container', 'stop', '-t', '1', second.id]); }
            },
        });
        const errorB = await expectRejection(makeBroker({ timeoutMs: 5_000 }).prepare({ target: secondTarget, home: homeInput, sessionId: sidB, ...journalB.callbacks }));
        const summaryB = journalB.summary();
        steps.failedStartMidway = { ...summaryB, error: errorB && { code: errorB.code, message: errorB.message, reason: errorB.reason } };
        check('8b.stopped-midway', 'the target was stopped after the helper was recorded', stoppedMidway && inspect(second.id).State.Running === false);
        check('8b.stopped-midway', 'prepare rejects without an unproven exit', errorB?.code === 'WEBTTY_HOME_PROJECTION_UNPROVEN' && errorB?.reason !== 'helper_exit_unproven', errorB && { code: errorB.code, message: errorB.message, reason: errorB.reason });
        check('8b.stopped-midway', 'the helper journal ends with null (no stale ownership) and no receipt was journaled',
            summaryB.helperStates.length === 3 && summaryB.helperStates.at(-1) === null && summaryB.receiptStages.length === 0, summaryB.helperStates);
        check('8b.stopped-midway', 'no process carries the nonce and no helper process exists', withNonce(summaryB.helperStates[0].nonce).length === 0 && helperProcesses().length === 0);
        check('8b.stopped-midway', 'the target restarts', restart());
        check('8b.stopped-midway', 'no /run destination exists after the restart', noRunDestination());
    }

    // ---- Step 9: broker crash between attach and finish ----------------------------------
    for (const variant of ['stopped-helper', 'plain-kill']) {
        const step = `9.crash-${variant}`;
        const sid = crypto.randomBytes(24).toString('base64url');
        const dest = `${DESTINATION_PREFIX}${sid}`;
        const entriesBefore = fs.readdirSync(home).sort();
        const lines = [];
        let pending = '';
        let childStderr = '';
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--crash-child', JSON.stringify({ target, home: homeInput, sessionId: sid })], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
            pending += chunk;
            let index;
            while ((index = pending.indexOf('\n')) >= 0) { lines.push(JSON.parse(pending.slice(0, index))); pending = pending.slice(index + 1); }
        });
        child.stderr.on('data', (chunk) => { childStderr = (childStderr + chunk).slice(-4000); });
        const exited = new Promise((resolve) => child.once('exit', (code, sig) => resolve({ code, sig })));
        try {
            const deadline = Date.now() + 90_000;
            while (Date.now() < deadline && child.exitCode === null
                && !lines.some((l) => l.kind === 'receipt' && l.value.stage === 'attached')) await sleep(20);
            const helperStates = lines.filter((l) => l.kind === 'helper').map((l) => l.value);
            const receipts = lines.filter((l) => l.kind === 'receipt').map((l) => l.value);
            const recorded = helperStates.filter(Boolean).at(-1);
            const lastReceipt = receipts.at(-1);
            must(step, 'the broker child reached the attached receipt', lastReceipt?.stage === 'attached' && recorded?.pid > 1, { lines: lines.length, stderr: childStderr });
            check(step, 'the child journaled intent, directory, prepared, attached and a complete helper ownership',
                JSON.stringify(receipts.map((r) => r.stage)) === JSON.stringify(['intent', 'directory', 'prepared', 'attached']) && Object.keys(recorded).length === 5, { stages: receipts.map((r) => r.stage), recorded });
            let stalled = null;
            if (variant === 'stopped-helper') {
                stalled = await stopPython(recorded.nonce, recorded.pid);
                check(step, 'python helper is stopped (T) while the mount is attached', stalled.afterStop?.state === 'T', stalled.afterStop);
            }
            check(step, 'the attached mount exists in the target before the crash', targetMountPoints(containerId).filter((m) => m.point === dest && m.mountId === lastReceipt.mountId).length === 1);
            child.kill('SIGKILL');
            const exit = await exited;
            check(step, 'the broker child was killed', exit.sig === 'SIGKILL', exit);
            let settledAfterCrash = [];
            if (variant === 'plain-kill') {
                const waitUntil = Date.now() + 20_000;
                while (Date.now() < waitUntil && withNonce(recorded.nonce).length) await sleep(100);
            } else {
                await sleep(1_500);
            }
            settledAfterCrash = withNonce(recorded.nonce).map((p) => ({ pid: p.pid, ppid: p.ppid, sid: p.sid, state: p.state, argv0: p.argv[0] }));
            const mountedAfterCrash = targetMountPoints(containerId).some((m) => m.point === dest);
            steps[`crash_${variant}`] = { helperStates, receiptStages: receipts.map((r) => r.stage), recorded, settledAfterCrash, mountedAfterCrash, childExit: exit };
            if (variant === 'stopped-helper') {
                check(step, 'after the crash the stopped helper survives and the mount remains (recovery is required)',
                    settledAfterCrash.some((p) => p.state === 'T') && mountedAfterCrash, { settledAfterCrash, mountedAfterCrash });
            }
            const before = signals.length;
            const fresh = makeBroker();
            check(step, 'reclaimHelper(recorded ownership) from a fresh broker returns true', await fresh.reclaimHelper({ ownership: recorded }) === true);
            if (variant === 'stopped-helper') check(step, 'SIGKILL was delivered to the stopped python', signals.slice(before).some((s) => s.name === 'SIGKILL' && s.pid === stalled.python.pid), signals.slice(before));
            check(step, 'no process carries the nonce after reclaim', withNonce(recorded.nonce).length === 0);
            const recovery = makeJournal(`crash-release-${variant}`);
            check(step, 'release of the last (attached) receipt returns true', await fresh.release({ target, receipt: lastReceipt, home: homeInput, onHelper: recovery.onHelper }) === true);
            steps[`crash_${variant}_release`] = recovery.summary();
            check(step, 'the destination is absent and not mounted', inTarget(containerId, 'test ! -e "$1" && test ! -L "$1"', dest).status === 0 && !targetMountPoints(containerId).some((m) => m.point === dest));
            check(step, 'no helper process carries the nonce', withNonce(recorded.nonce).length === 0);
            check(step, 'source is intact', JSON.stringify(fs.readdirSync(home).sort()) === JSON.stringify(entriesBefore)
                && JSON.stringify(identity(home)) === JSON.stringify(originalHome) && JSON.stringify(ownership(home)) === JSON.stringify(originalOwnership));
        } finally {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }
    }

    // ---- Step 10: restart recovery through the real RuntimeRecordStore --------------------
    {
        const directory = path.join(workspace, '.ploinky', 'broker-native-records');
        const recordTarget = { runtime: 'podman', containerId, containerName: main.name, instanceId: 'broker-native-instance', enableGeneration: 'broker-native-generation' };
        const recordFiles = () => (fs.existsSync(directory) ? fs.readdirSync(directory) : []);
        for (const variant of ['A', 'B']) {
            const step = `10.store-${variant}`;
            const sid = crypto.randomBytes(24).toString('base64url');
            const dest = `${DESTINATION_PREFIX}${sid}`;
            const entriesBefore = fs.readdirSync(home).sort();
            check(step, 'the record directory starts empty', recordFiles().length === 0, recordFiles());
            const lines = [];
            let pending = '';
            let childStderr = '';
            const spec = { directory, variant, target, home: homeInput, sessionId: sid, recordTarget };
            const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--store-child', JSON.stringify(spec)], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
            child.stdout.setEncoding('utf8');
            child.stdout.on('data', (chunk) => {
                pending += chunk;
                let index;
                while ((index = pending.indexOf('\n')) >= 0) { lines.push(JSON.parse(pending.slice(0, index))); pending = pending.slice(index + 1); }
            });
            child.stderr.on('data', (chunk) => { childStderr = (childStderr + chunk).slice(-4000); });
            const exited = new Promise((resolve) => child.once('exit', (code, sig) => resolve({ code, sig })));
            try {
                const deadline = Date.now() + 90_000;
                const ready = () => (variant === 'A' ? lines.some((l) => l.kind === 'attached') : false);
                while (Date.now() < deadline && child.exitCode === null && child.signalCode === null && !ready()) await sleep(20);
                const helperStates = lines.filter((l) => l.kind === 'helper').map((l) => l.value);
                let stalled = null;
                let nonceSeen = helperStates[0]?.nonce;
                if (variant === 'A') {
                    const recorded = helperStates.filter(Boolean).at(-1);
                    must(step, 'the store child reached the durable attached receipt', lines.some((l) => l.kind === 'attached') && recorded?.pid > 1, { lines: lines.length, stderr: childStderr });
                    stalled = await stopPython(recorded.nonce, recorded.pid);
                    check(step, 'python helper is stopped (T) while the mount is attached', stalled.afterStop?.state === 'T', stalled.afterStop);
                    child.kill('SIGKILL');
                }
                const exit = await Promise.race([exited, sleep(30_000).then(() => null)]);
                check(step, 'the store child died by SIGKILL', exit?.sig === 'SIGKILL', { exit, stderr: childStderr });
                // What survives the crash: the durable record file and the helper/mount.
                const files = recordFiles();
                check(step, 'exactly one durable record file survives the crash', files.length === 1 && /^[A-Za-z0-9_-]+\.json$/.test(files[0]), files);
                const onDisk = files.length === 1 ? JSON.parse(fs.readFileSync(path.join(directory, files[0]), 'utf8')) : null;
                const recordSummary = onDisk && { ptyState: onDisk.ptyState, targetKind: onDisk.targetKind, worker: onDisk.worker, homeProjectionHelper: onDisk.homeProjectionHelper, homeProjectionStage: onDisk.homeProjection?.stage };
                if (variant === 'A') {
                    check(step, 'the record holds the complete helper ownership and the attached receipt', onDisk?.homeProjectionHelper?.pid === helperStates.filter(Boolean).at(-1).pid
                        && Object.keys(onDisk.homeProjectionHelper).length === 5 && onDisk.homeProjection?.stage === 'attached', recordSummary);
                    check(step, 'after the crash the stopped helper survives and the mount remains', withNonce(nonceSeen).some((p) => p.state === 'T')
                        && targetMountPoints(containerId).some((m) => m.point === dest), withNonce(nonceSeen).map((p) => p.state));
                } else {
                    check(step, 'the record holds only the nonce-only ownership (no receipt)', onDisk?.homeProjectionHelper && Object.keys(onDisk.homeProjectionHelper).sort().join() === 'nonce,operation'
                        && onDisk.homeProjection === undefined, recordSummary);
                    nonceSeen = onDisk?.homeProjectionHelper?.nonce;
                    check(step, 'no helper was ever spawned for that nonce', withNonce(nonceSeen).length === 0 && !targetMountPoints(containerId).some((m) => m.point.startsWith(DESTINATION_PREFIX)));
                }
                // Restart: a fresh store and broker recover from the directory alone.
                const before = signals.length;
                const freshStore = new RuntimeRecordStore({ directory, homeMountBroker: makeBroker() });
                const started10 = Date.now();
                const result = await freshStore.recover();
                steps[`store_${variant}`] = { record: recordSummary, recoverResult: result, recoverMs: Date.now() - started10, signals: signals.slice(before), childExit: exit, helperStates };
                check(step, 'recover() returns ok:true', result.ok === true, result);
                check(step, 'recover() reports no quarantined target and the agent provider available',
                    result.ok === true && result.agentAvailable === true && Array.isArray(result.quarantinedTargets) && result.quarantinedTargets.length === 0, result);
                check(step, 'recover() evidence reports a verified reclaim', Array.isArray(result.evidence) && result.evidence.length === 1 && /reclaimed|removed/.test(result.evidence[0]), result.evidence);
                check(step, 'the record file is gone', recordFiles().length === 0, recordFiles());
                check(step, 'no process carries the nonce', withNonce(nonceSeen).length === 0);
                check(step, 'the destination is absent and nothing is mounted under /run',
                    inTarget(containerId, 'test ! -e "$1" && test ! -L "$1"', dest).status === 0 && !targetMountPoints(containerId).some((m) => m.point.startsWith(DESTINATION_PREFIX)));
                if (variant === 'A') check(step, 'SIGKILL was delivered to the stopped python during recovery', signals.slice(before).some((s) => s.name === 'SIGKILL' && s.pid === stalled.python.pid), signals.slice(before));
                check(step, 'source is intact', JSON.stringify(fs.readdirSync(home).sort()) === JSON.stringify(entriesBefore)
                    && JSON.stringify(identity(home)) === JSON.stringify(originalHome) && JSON.stringify(ownership(home)) === JSON.stringify(originalOwnership));
            } finally {
                if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
            }
        }
        try { fs.rmdirSync(directory); } catch (_) { /* left for the workspace removal */ }
    }
} catch (error) {
    emit('error', { message: String(error?.stack || error) });
    checks.push({ step: 'driver', name: 'uncaught driver error', ok: false, detail: String(error?.message || error) });
} finally {
    const cleanup = { attempted: createdTargets.length > 0, targets: [] };
    if (createdTargets.length) {
        let allOk = true;
        for (const created of [...createdTargets].reverse()) {
            const entry = { id: created.id, name: created.name };
            try {
                const state = inspect(created.id);
                entry.running = state.State.Running === true;
                entry.destinationMountsLeft = entry.running
                    ? targetMountPoints(created.id).filter((m) => m.point.startsWith(DESTINATION_PREFIX)) : [];
                podman(['container', 'rm', '-f', created.id]);
                entry.absent = inspectAbsent(podman(['container', 'inspect', created.id], { allowFailure: true }), created.id);
            } catch (error) { entry.error = String(error?.message || error); }
            if (!entry.absent || entry.error || entry.destinationMountsLeft?.length) allOk = false;
            cleanup.targets.push(entry);
        }
        try {
            const list = podman(['ps', '-a', '--format', '{{.ID}}']).stdout.trim();
            cleanup.nestedContainersLeft = list ? list.split('\n') : [];
        } catch (error) { cleanup.nestedContainersLeft = [`error: ${error.message}`]; }
        checks.push({ step: 'cleanup', name: 'every nested target removed with proven absence', ok: allOk && cleanup.nestedContainersLeft.length === 0, detail: cleanup });
    }
    const failed = checks.filter((c) => !c.ok);
    process.stdout.write(`${JSON.stringify({ phase: 'summary', at: Date.now(), total: checks.length, failed: failed.length, checks, steps, cleanup, signals })}\n`,
        () => process.exit(failed.length ? 1 : 0));
}
