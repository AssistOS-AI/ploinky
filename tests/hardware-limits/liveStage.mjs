// Remote staging for apparatus blocks. Over the pinned SSH transport only
// (liveRemote.mjs sshOptions), it creates a new private remote root
// ~/.cache/ploinky-hwlimits/RUN_ID, stages the frozen candidate payload, the
// exact authorized manifest bytes and the authorization binding, verifies
// every digest on arrival, dispatches the fixed remote runner, fetches the
// updated manifest and report back with digest proof, and removes only that
// owned root, only after the remote cleanup passed. A local side journal makes
// staging resumable; a mismatch or incomplete transport preserves everything.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EXIT, validateRunManifest } from './fixtures.mjs';
import { runBoundedProcess } from './liveProcess.mjs';
import { assertLocalSshPins, dispatchRemoteRun, safePath, sshOptions, validateRemoteTarget } from './liveRemote.mjs';
import { HASH, OWNER_MARKER, RUN_ID, digest, jsonDigest, keys } from './liveCommon.mjs';

const WORD = /^[A-Za-z0-9_./:=,%+@-]+$/;
export const REMOTE_PARENT = '.cache/ploinky-hwlimits';

export function remoteReportName(action) { return `report_${action}.json`; }

// ---------------------------------------------------------------------------
// Deterministic ustar archive of the frozen candidate root. Regular files and
// directories only; owner 0, mtime 0, sorted entries, exec bit preserved.

function octal(value, length) {
    const text = value.toString(8);
    if (text.length > length - 1) throw new Error('ustar field overflow');
    return text.padStart(length - 1, '0') + '\0';
}

function ustarHeader(name, { size, mode, directory }) {
    const header = Buffer.alloc(512, 0);
    let prefix = '', base = name;
    if (Buffer.byteLength(name) > 100) {
        const split = name.lastIndexOf('/', name.length - 2);
        prefix = name.slice(0, split); base = name.slice(split + 1);
        if (split < 0 || Buffer.byteLength(base) > 100 || Buffer.byteLength(prefix) > 155) throw new Error(`Path cannot be represented in ustar: ${name}`);
    }
    header.write(base, 0, 100, 'utf8');
    header.write(octal(mode, 8), 100, 8, 'ascii');
    header.write(octal(0, 8), 108, 8, 'ascii');
    header.write(octal(0, 8), 116, 8, 'ascii');
    header.write(octal(size, 12), 124, 12, 'ascii');
    header.write(octal(0, 12), 136, 12, 'ascii');
    header.write('        ', 148, 8, 'ascii');
    header.write(directory ? '5' : '0', 156, 1, 'ascii');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    header.write(prefix, 345, 155, 'utf8');
    let sum = 0; for (const byte of header) sum += byte;
    header.write(octal(sum, 7) + ' ', 148, 8, 'ascii');
    return header;
}

export function writeUstar(root, output) {
    if (fs.realpathSync(root) !== root) throw new Error('Noncanonical payload root');
    const fd = fs.openSync(output, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    let files = 0, total = 0;
    try {
        const walk = (directory, relative) => {
            for (const name of fs.readdirSync(directory).sort()) {
                if (name === '.git') continue;
                const absolutePath = path.join(directory, name);
                const rel = relative ? `${relative}/${name}` : name;
                const stat = fs.lstatSync(absolutePath);
                if (stat.isSymbolicLink()) throw new Error(`Payload must not contain symlinks: ${rel}`);
                if (++files > 60000) throw new Error('Payload entry bound exceeded');
                if (stat.isDirectory()) {
                    fs.writeSync(fd, ustarHeader(`${rel}/`, { size: 0, mode: 0o755, directory: true }));
                    walk(absolutePath, rel);
                } else if (stat.isFile()) {
                    const bytes = fs.readFileSync(absolutePath);
                    total += bytes.length;
                    if (total > 512 * 1024 * 1024) throw new Error('Payload size bound exceeded');
                    fs.writeSync(fd, ustarHeader(rel, { size: bytes.length, mode: stat.mode & 0o111 ? 0o755 : 0o644, directory: false }));
                    fs.writeSync(fd, bytes);
                    const pad = (512 - (bytes.length % 512)) % 512;
                    if (pad) fs.writeSync(fd, Buffer.alloc(pad, 0));
                } else throw new Error(`Payload must contain only files and directories: ${rel}`);
            }
        };
        walk(root, '');
        fs.writeSync(fd, Buffer.alloc(1024, 0));
        fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    const bytes = fs.readFileSync(output);
    return { digest: digest(bytes), bytes: bytes.length };
}

// ---------------------------------------------------------------------------

export function remoteRoot(home, runId) {
    if (!safePath(home) || !RUN_ID.test(runId)) throw new Error('Invalid remote root input');
    return `${home}/${REMOTE_PARENT}/${runId}`;
}

export function validateStage(run) {
    const stage = run.target.stage;
    keys(stage, ['root', 'payloadPath', 'payloadDigest', 'payloadBytes'], 'remote stage');
    const profile = run.target.execution;
    const root = remoteRoot(profile.host.home, run.runId);
    if (stage.root !== root || !path.isAbsolute(stage.payloadPath) || path.normalize(stage.payloadPath) !== stage.payloadPath
        || !HASH.test(stage.payloadDigest) || !Number.isSafeInteger(stage.payloadBytes) || stage.payloadBytes <= 0) throw new Error('Invalid remote stage pins');
    const remote = validateRemoteTarget(run);
    if (profile.source.root !== `${root}/source` || path.dirname(remote.runPath) !== `${root}/run`
        || path.dirname(remote.authorizationPath) !== `${root}/run` || profile.provision?.workspace.parent !== root
        || profile.provision?.workspace.parentMode !== 'staged') throw new Error('Remote stage paths are not inside the run root');
    return { stage, remote, root };
}

function writePrivateBytes(target, bytes) {
    const directory = path.dirname(target);
    const temporary = path.join(directory, `.${path.basename(target)}.${crypto.randomBytes(8).toString('hex')}.tmp`);
    const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, target);
}

function parseSums(stdout, files) {
    const lines = String(stdout).split('\n').filter(Boolean);
    const sums = new Map();
    for (const line of lines) {
        const match = /^([a-f0-9]{64}) [ *](\/[^\n]+)$/.exec(line);
        if (!match) throw new Error('Malformed remote digest output');
        sums.set(match[2], `sha256:${match[1]}`);
    }
    if (files.some(file => !sums.has(file)) || sums.size !== files.length) throw new Error('Remote digest output does not name the staged files');
    return sums;
}

// The configured document suffix of this run: the one its manifest names for
// the remote run file, else the one of the local run file's name.
export function documentSuffixOf(run, runPath) {
    const match = /_(claude|codex)\.json$/.exec(path.basename(String(run.target?.remote?.runPath || '')))
        || /_(claude|codex)\.json$/.exec(path.basename(String(runPath || '')));
    if (!match) throw new Error('The run manifest names no configured document suffix (claude or codex)');
    return match[1];
}

export async function stageAndDispatch({ run, bytes, authorizationBytes, action, runPath, processProvider = runBoundedProcess, signal }) {
    const report = { schema: 1, runId: run.runId, action, verdict: 'BLOCKED', exitCode: EXIT.BLOCKED, cases: [], cleanup: run.cleanup, limitations: [] };
    let stage, remote, root, suffix;
    try { ({ stage, remote, root } = validateStage(run)); assertLocalSshPins(remote); suffix = documentSuffixOf(run, runPath); }
    catch (error) { report.limitations.push(error.message); return report; }
    const profile = run.target.execution;
    const runDirectory = path.dirname(runPath);
    const journalPath = path.join(runDirectory, `staging_${run.runId}_${suffix}.json`);
    let journal;
    try { journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; journal = { schema: 1, runId: run.runId, root, rootIntent: false, identity: null, staged: false, dispatches: [], removal: null }; }
    if (journal.runId !== run.runId || journal.root !== root) throw new Error('Staging journal belongs to another run');
    const save = () => writePrivateBytes(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
    const deadline = (name, fallback) => (Number.isInteger(run.deadlines?.[name]) ? run.deadlines[name] : fallback);
    const env = { PATH: '/usr/bin:/bin', HOME: process.env.HOME, ...(process.env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK } : {}) };
    const call = async (words, { deadlineMs = 30000, maxBytes = 65536, stdinPath = null, allowFailure = false } = {}) => {
        if (!Array.isArray(words) || !words.length || words.some(word => typeof word !== 'string' || !WORD.test(word))) throw new Error('Unsafe remote command word');
        const result = await processProvider(remote.sshBinary, [...sshOptions(remote), remote.address, ...words], { cwd: runDirectory, env, deadlineMs, maxBytes, signal, ...(stdinPath ? { stdinPath } : {}) });
        if (!result || result.errorCode || result.signal || result.timedOut || result.truncated || result.cancelled || result.settlementForced
            || !Number.isInteger(result.status)) throw new Error('Remote staging transport incomplete; staging state preserved');
        if (result.status !== 0 && !allowFailure) throw new Error(`Remote staging command ${words[0]} failed`);
        return result;
    };
    const temporary = name => path.join(runDirectory, `.stage-${run.runId}-${name}`);
    const upload = async (bytesToSend, destination) => {
        const file = temporary(path.basename(destination));
        fs.writeFileSync(file, bytesToSend, { flag: 'wx', mode: 0o600 });
        try { await call(['dd', `of=${destination}`, 'conv=excl,fsync', 'status=none'], { stdinPath: file, deadlineMs: deadline('stagingMs', 600000) }); }
        finally { fs.rmSync(file, { force: true }); }
    };
    const verifyRoot = async () => {
        const stat = (await call(['stat', '-c', '%d:%i:%u:%a', '--', root])).stdout.trim();
        const marker = (await call(['cat', '--', `${root}/${OWNER_MARKER}`])).stdout;
        const [dev, ino, uid, mode] = stat.split(':');
        if (!journal.identity || dev !== journal.identity.dev || ino !== journal.identity.ino || uid !== journal.identity.uid || mode !== '700'
            || marker !== run.runId) throw new Error('Remote staging root identity changed; preserving it');
    };
    try {
        const hostname = (await call(['uname', '-n'])).stdout.trim();
        if (hostname !== profile.host.hostname) throw new Error('Remote host identity mismatch; nothing staged or dispatched');
        if (action === 'cleanup' && (!journal.rootIntent || journal.removal)) {
            if (journal.rootIntent) await removeStaging();
            report.verdict = 'PASS'; report.exitCode = EXIT.PASS;
            report.limitations.push(journal.rootIntent ? 'The owned staging root removal was resumed' : 'Nothing was staged for this run');
            return report;
        }
        if (!journal.rootIntent) {
            if (action !== 'provision') throw new Error('Nothing is staged; only provision may create the remote root');
            journal.rootIntent = true; save();
            await call(['mkdir', '-p', '-m', '0700', '--', path.dirname(root)]);
            const created = await call(['mkdir', '-m', '0700', '--', root], { allowFailure: true });
            if (created.status !== 0) throw new Error('Refusing a pre-existing or uncreatable remote staging root');
            await upload(run.runId, `${root}/${OWNER_MARKER}`);
            const [dev, ino, uid] = (await call(['stat', '-c', '%d:%i:%u:%a', '--', root])).stdout.trim().split(':');
            journal.identity = { dev, ino, uid }; save();
        }
        await verifyRoot();
        // With no remote run ever dispatched, the owned root holds only what
        // staging put there; cleanup proves and removes it directly.
        if (action === 'cleanup' && !journal.dispatches.length) {
            await removeStaging();
            report.verdict = 'PASS'; report.exitCode = EXIT.PASS; report.limitations.push('No remote run was dispatched; only the owned staging root was removed');
            return report;
        }
        if (!journal.staged) {
            if (action !== 'provision') throw new Error('The candidate payload was never staged; only provision may stage it');
            const payload = fs.readFileSync(stage.payloadPath);
            if (payload.length !== stage.payloadBytes || digest(payload) !== stage.payloadDigest) throw new Error('Local candidate payload changed since prepare-live');
            await call(['mkdir', '-m', '0700', '--', `${root}/source`, `${root}/run`]);
            const remotePayload = `${root}/payload.tar`;
            const file = temporary('payload.tar');
            fs.copyFileSync(stage.payloadPath, file, fs.constants.COPYFILE_EXCL);
            try { await call(['dd', `of=${remotePayload}`, 'conv=excl,fsync', 'status=none'], { stdinPath: file, deadlineMs: deadline('stagingMs', 600000) }); }
            finally { fs.rmSync(file, { force: true }); }
            const sums = parseSums((await call(['sha256sum', '--', remotePayload], { deadlineMs: deadline('stagingMs', 600000) })).stdout, [remotePayload]);
            if (sums.get(remotePayload) !== stage.payloadDigest) throw new Error('Remote payload digest mismatch; nothing extracted or dispatched');
            await call(['tar', '-x', '--no-same-owner', '-f', remotePayload, '-C', `${root}/source`], { deadlineMs: deadline('stagingMs', 600000) });
            journal.staged = true; save();
        }
        // The remote manifest is exactly the authorized bytes; a remote copy
        // that has advanced is fetched for a new authorization, never overwritten.
        const manifestDigest = digest(bytes);
        const present = await call(['sha256sum', '--', remote.runPath], { allowFailure: true });
        if (present.status === 0) {
            if (parseSums(present.stdout, [remote.runPath]).get(remote.runPath) !== manifestDigest) {
                await fetchManifest();
                throw new Error('The remote manifest has advanced; it was fetched for a new authorization of this action');
            }
        } else {
            await upload(bytes, remote.runPath);
            await call(['chmod', '0600', '--', remote.runPath]);
            if (parseSums((await call(['sha256sum', '--', remote.runPath])).stdout, [remote.runPath]).get(remote.runPath) !== manifestDigest) throw new Error('Remote manifest digest mismatch');
        }
        const authorizationPath = `${root}/run/authorization_${action}_${digest(authorizationBytes).slice(7, 23)}.json`;
        const existing = await call(['sha256sum', '--', authorizationPath], { allowFailure: true });
        if (existing.status !== 0) {
            await upload(authorizationBytes, authorizationPath);
            await call(['chmod', '0600', '--', authorizationPath]);
        }
        if (parseSums((await call(['sha256sum', '--', authorizationPath])).stdout, [authorizationPath]).get(authorizationPath) !== digest(authorizationBytes)) throw new Error('Remote authorization digest mismatch');
        journal.dispatches.push({ action, state: 'intent', manifestDigest }); save();
        let remoteReport;
        try { remoteReport = await dispatchRemoteRun({ run, action, cwd: runDirectory, signal, manifestDigest, processProvider, authorizationPath }); }
        catch (error) { journal.dispatches.at(-1).state = 'incomplete'; save(); throw error; }
        journal.dispatches.at(-1).state = 'returned'; save();
        const fetched = await fetchManifest();
        const reportFile = `${root}/run/${remoteReportName(action)}`;
        const reportSums = parseSums((await call(['sha256sum', '--', reportFile])).stdout, [reportFile]);
        const reportText = (await call(['cat', '--', reportFile], { maxBytes: 1048576 })).stdout;
        if (digest(Buffer.from(reportText, 'utf8')) !== reportSums.get(reportFile)) throw new Error('Fetched remote report digest mismatch');
        if (jsonDigest(JSON.parse(reportText)) !== jsonDigest(remoteReport)) throw new Error('Fetched remote report differs from the dispatched result');
        writePrivateBytes(path.join(runDirectory, `report_${action}_remote_${suffix}.json`), Buffer.from(reportText, 'utf8'));
        let removed = false;
        if (action === 'cleanup' && remoteReport.verdict === 'PASS' && fetched.state === 'complete' && fetched.cleanup.state === 'complete') {
            await removeStaging(); removed = true;
        }
        return { ...remoteReport, staging: { root, removed } };
    } catch (error) {
        report.limitations.push(error.message);
        return report;
    }

    // Fetch the remote manifest with digest proof; it must be this run with
    // the same pins, and it replaces the local manifest byte for byte.
    async function fetchManifest() {
        const sums = parseSums((await call(['sha256sum', '--', remote.runPath])).stdout, [remote.runPath]);
        const text = (await call(['cat', '--', remote.runPath], { maxBytes: 1048576 })).stdout;
        const fetchedBytes = Buffer.from(text, 'utf8');
        if (digest(fetchedBytes) !== sums.get(remote.runPath)) throw new Error('Fetched remote manifest digest mismatch');
        const fetched = validateRunManifest(JSON.parse(text));
        for (const key of ['runId', 'block', 'configDigest', 'casesDigest']) if (fetched[key] !== run[key]) throw new Error('Fetched remote manifest is not this run');
        for (const key of ['ssh', 'remote', 'stage']) if (jsonDigest(fetched.target[key]) !== jsonDigest(run.target[key])) throw new Error('Fetched remote manifest changed its pins');
        writePrivateBytes(runPath, fetchedBytes);
        return fetched;
    }

    // A resumed removal accepts an already absent root only after its own
    // recorded intent; otherwise the root must still prove its identity.
    async function removeStaging() {
        if (journal.removal === 'complete') return;
        const resumed = journal.removal === 'intent';
        journal.removal = 'intent'; save();
        const probe = await call(['stat', '-c', '%d:%i:%u:%a', '--', root], { allowFailure: true });
        if (probe.status !== 0) {
            if (!resumed || !/No such file/.test(probe.stderr)) throw new Error('Remote staging root cannot be proved; preserving the journal');
            journal.removal = 'complete'; save();
            return;
        }
        await verifyRoot();
        await call(['rm', '-rf', '--', root], { deadlineMs: deadline('cleanupMs', 300000) });
        const after = await call(['stat', '-c', '%d:%i:%u:%a', '--', root], { allowFailure: true });
        if (after.status === 0 || !/No such file/.test(after.stderr)) throw new Error('Remote staging root remains after removal');
        journal.removal = 'complete'; save();
    }
}

