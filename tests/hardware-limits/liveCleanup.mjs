// Crash-resumable owned cleanup (plan §15.6). Every step is journaled in the
// run manifest before it mutates, and a fresh process resumes from the
// manifest alone: the workspace receipt and owner marker, the quarantine name
// derived from the run ID, the recorded Box and the exact recorded host
// records. Nothing unproven is ever removed recursively; a failed identity
// proof or destruction preserves every remaining resource.
import fs from 'node:fs';
import path from 'node:path';
import { BOX_LABELS } from '../../ploinky-box/constants.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { requireTransport, runBoundedProcess } from './liveProcess.mjs';
import {
    HOST_RECORD_DIRECTORIES, ID, INSPECT, OWNER_MARKER, assertOwnedDirectory, assertWorkspace, boxPsArgv, candidateEnv, checkedJson, commandTails, hostRecordPaths,
    jsonDigest, liveSourceDigest, observeEngineIdentity, quarantinePath,
} from './liveCommon.mjs';

// One journaled command: the intent is persisted before the process starts and
// the observed status after it ends. Output stays out of the journal; a command
// named with `capture` writes bounded, redacted tails as a run artifact. A `box`
// identity ({ name, pathHash }) is stored on the intent, so it is durable
// before the command that creates that Box can run.
export function createJournal({ run, persist, processProvider = runBoundedProcess, signal, artifacts = () => {} }) {
    return async function journaled(kind, binary, args, { cwd, env, deadlineMs = 30000, stress = false, resourceIds = [], stdinPath = null, box = null, capture = null } = {}) {
        if (run.operations.length >= 512 || Buffer.byteLength(JSON.stringify(run)) > 190000) throw new Error('Live journal bound exceeded');
        const op = { id: `live-${run.operations.length + 1}`, kind, state: 'intent', resourceIds, argvDigest: jsonDigest([binary, ...args]), resultArtifact: null, ...(box ? { box } : {}) };
        run.operations.push(op); persist();
        const result = await processProvider(binary, args, { cwd, env, deadlineMs, maxBytes: 65536, signal, ...(stdinPath ? { stdinPath } : {}) });
        op.state = 'observed';
        op.result = { status: result.status, signal: result.signal, timedOut: result.timedOut, truncated: result.truncated, cancelled: result.cancelled, errorCode: result.errorCode, settlementForced: Boolean(result.settlementForced) };
        persist();
        // A command named for capture keeps the bounded, redacted tails of both
        // streams as a run artifact before its transport is judged, so a failed
        // or truncated command leaves its own evidence.
        if (capture) {
            try { artifacts(capture, { operation: op.id, kind, ...commandTails(result) }); op.artifact = capture; }
            catch (error) { op.artifactError = String(error?.message || error).slice(0, 256); }
            persist();
        }
        requireTransport(result, { stress });
        return result;
    };
}

function lstatOrNull(target) {
    try { return fs.lstatSync(target); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// A recorded host record is removed only when it is still the recorded kind
// of object with the recorded owner; a directory also keeps its inode. A JSON
// record is replaced atomically by production, so its inode may change.
function assertRecordedHostRecord(entry, stat) {
    if (stat.isSymbolicLink() || stat.uid !== entry.uid) throw new Error(`Recorded host state changed owner or kind: ${entry.path}`);
    if (entry.type === 'file') {
        if (!stat.isFile() || stat.nlink !== 1) throw new Error(`Recorded host state is no longer one regular file: ${entry.path}`);
    } else if (!stat.isDirectory() || fs.realpathSync(entry.path) !== entry.path
        || String(stat.dev) !== entry.dev || String(stat.ino) !== entry.ino) throw new Error(`Recorded host state directory identity changed: ${entry.path}`);
}

export function recordedHostRecords(run) {
    return run.ownedPaths.filter(entry => entry.role === 'host-record');
}

// Record every exact host record of the instance that now exists. Called only
// after an owned candidate command for this fresh workspace, whose instance
// was proved to have no host records before provisioning.
export function recordHostRecords(run, profile, instance) {
    let changed = false;
    for (const target of hostRecordPaths(profile.host.home, instance)) {
        const stat = lstatOrNull(target);
        if (!stat || run.ownedPaths.some(entry => entry.path === target)) continue;
        if (stat.isSymbolicLink() || !(stat.isFile() || stat.isDirectory())) throw new Error(`Unexpected host record kind: ${target}`);
        run.ownedPaths.push({ path: target, role: 'host-record', type: stat.isDirectory() ? 'directory' : 'file', uid: stat.uid, dev: String(stat.dev), ino: String(stat.ino) });
        changed = true;
    }
    // A shared host-record directory that the provisioning preflight saw
    // absent, and that exists now, was created by this run's candidate
    // commands: it is recorded so that cleanup can remove it once empty.
    for (const directory of HOST_RECORD_DIRECTORIES) {
        const target = path.join(profile.host.home, '.ploinky-box', directory);
        const absentBefore = run.operations.some(op => op.kind === 'host-directory-preflight' && op.directory === directory && op.existed === false);
        if (!absentBefore || run.ownedPaths.some(entry => entry.path === target)) continue;
        const stat = lstatOrNull(target);
        if (!stat) continue;
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unexpected host record directory kind: ${target}`);
        run.ownedPaths.push({ path: target, role: 'host-created-directory', type: 'directory', uid: stat.uid, dev: String(stat.dev), ino: String(stat.ino) });
        changed = true;
    }
    return changed;
}

export async function runOwnedCleanup({ run, profile, persist = () => {}, processProvider = runBoundedProcess, signal, platform = profile.host.platform }) {
    const journaled = createJournal({ run, persist, processProvider, signal });
    const env = candidateEnv(profile);
    const engine = (kind, args, options = {}) => journaled(kind, profile.engine.path, args, { cwd: profile.host.home, env, ...options });
    const step = id => run.cleanup.steps.find(entry => entry.id === id);
    const begin = id => {
        let entry = step(id);
        if (!entry) { entry = { id, state: 'intent', artifact: null }; run.cleanup.steps.push(entry); persist(); }
        return entry;
    };
    const complete = entry => { entry.state = 'complete'; persist(); };
    const workspacePath = profile.workspace?.path || run.operations.find(op => op.kind === 'workspace-create')?.path || null;
    const pathHash = profile.box?.pathHash || run.workspace?.pathHash || (workspacePath ? buildWorkspaceIdentity(workspacePath).pathHash : null);
    const instance = profile.box?.instance || run.workspace?.instance || (workspacePath ? buildWorkspaceIdentity(workspacePath).instance : null);

    // 1. Only bounded, awaited commands exist; no extra owned processes.
    // Only registered GPU processes may be recorded (they are never signalled by
    // cleanup; the final GPU observation proves them gone). Anything else cannot be proved.
    if (run.ownedProcesses.some(entry => entry?.kind !== 'gpu-process')) throw new Error('Cleanup cannot prove extra recorded processes');

    // 2. Revalidate the exact engine and the workspace identity. Every cleanup run does this, a resumed one again, and
    // the proof is journaled: a failed proof leaves the step at 'intent' and nothing after it runs.
    const revalidation = step('revalidate-identity') || begin('revalidate-identity');
    if (revalidation.state !== 'intent') { revalidation.state = 'intent'; persist(); }
    if (await observeEngineIdentity((kind, argv) => engine(kind, argv)) !== profile.engine.identityDigest) throw new Error('Engine service identity changed');
    const workspace = classifyWorkspace();
    complete(revalidation);

    // 4. Destroy with the candidate, then prove the exact Box absent.
    const destroyStep = step('destroy-box');
    if (destroyStep?.state !== 'complete') {
        const ids = await listIds('cleanup-inventory');
        const target = await findOwnedBox(ids, workspace);
        const entry = destroyStep || begin('destroy-box');
        if (target) {
            if (workspace.state !== 'present') throw new Error('An owned Box exists but its workspace is not proven; preserving everything');
            if (target.recorded) await inspectRecordedBox();
            assertWorkspace(profile);
            if (liveSourceDigest(profile.source.root) !== profile.source.digest) throw new Error('Candidate source changed');
            await journaled('destroy-box', profile.node.path, [profile.candidate.path, 'destroy', '--delete-cache'], {
                cwd: profile.workspace.path, env, deadlineMs: deadline('destroyMs', 300000), resourceIds: [target.id],
            });
        }
        await proveBoxAbsent();
        complete(entry);
    } else {
        await proveBoxAbsent();
    }

    // 5. Exact recorded host records, only after Box absence is proven.
    const records = step('host-records') || begin('host-records');
    if (records.state !== 'complete') {
        removeHostRecords();
        complete(records);
    }

    // 6. The workspace tree, through a run-derived quarantine.
    await removeWorkspace(workspace);

    // The task-owned temporary parent, when this run created one.
    const parent = run.ownedPaths.find(entry => entry.role === 'workspace-parent');
    const parentIntent = run.operations.find(op => op.kind === 'workspace-parent-create');
    if (parent || parentIntent) {
        const entry = step('workspace-parent-removal') || begin('workspace-parent-removal');
        if (entry.state !== 'complete') { removeParent(parent, parentIntent); complete(entry); }
    }

    // 7. Nothing owned remains.
    const verify = step('verify-absent') || begin('verify-absent');
    const remaining = await listIds('final-inventory');
    if (profile.box?.id && remaining.includes(profile.box.id)) throw new Error('Exact Box absence not proved at final verification');
    if (Array.isArray(run.preInventory.containers)
        && jsonDigest([...remaining].sort()) !== jsonDigest(run.preInventory.containers.map(value => value.id).sort())) {
        throw new Error('Unrelated container inventory changed at final verification; preserve evidence and do not undo it');
    }
    const leftovers = [workspacePath, workspacePath && quarantinePath(workspacePath, run.runId), parent?.path || parentIntent?.path,
        ...(instance ? hostRecordPaths(profile.host.home, instance) : [])].filter(Boolean).filter(target => lstatOrNull(target));
    if (leftovers.length) throw new Error(`Owned paths remain after cleanup: ${leftovers.map(value => path.basename(value)).join(', ')}`);
    complete(verify);

    function deadline(name, fallback) {
        const value = run.deadlines?.[name];
        return Number.isInteger(value) && value > 0 && value <= 1800000 ? value : fallback;
    }

    async function listIds(kind) {
        const result = await engine(kind, ['container', 'ps', '--all', '--no-trunc', '--format', '{{.ID}}']);
        const ids = result.stdout.trim() ? result.stdout.trim().split(/\s+/) : [];
        if (ids.length > 256 || ids.some(id => !ID.test(id))) throw new Error('Unsupported cleanup inventory');
        return ids;
    }

    async function inspectRecordedBox() {
        const box = checkedJson(await engine('inspect-box', ['container', 'inspect', '--format', INSPECT, profile.box.id]));
        const identity = assertWorkspace(profile);
        if (box.id !== profile.box.id || box.created !== profile.box.created || box.image !== profile.box.image
            || box.labels?.[BOX_LABELS.pathHash] !== identity.pathHash || box.labels?.[BOX_LABELS.role] !== 'box'
            || jsonDigest({ labels: box.labels, mounts: box.mounts }) !== profile.box.contractDigest) throw new Error('Box identity/contract changed');
    }

    // The recorded Box; or, when start was attempted but the Box receipt was
    // never persisted (for example its post-create inspect failed), the one
    // container found by the identity recorded on the `fixture-start`
    // operation: the deterministic instance name and the workspace path-hash
    // label, through a minimal `ps` query that parses no inspect document. It
    // must carry exactly that name and label, the Box role and a mount of
    // exactly this workspace. Anything else preserves everything.
    async function findOwnedBox(ids, workspaceState) {
        if (profile.box?.id) return ids.includes(profile.box.id) ? { id: profile.box.id, recorded: true } : null;
        const started = run.operations.find(op => op.kind === 'fixture-start');
        if (!started || workspaceState.state !== 'present') return null;
        if (started.box?.name !== instance || started.box?.pathHash !== pathHash) throw new Error('The recorded fixture-start Box identity is not this workspace\'s; preserving everything');
        const before = new Set((run.preInventory.containers || []).map(value => value.id));
        const listed = await engine('cleanup-candidate-ps', boxPsArgv(started.box.pathHash));
        const rows = listed.stdout.split('\n').filter(line => line.trim()).map(line => /^([a-f0-9]{64}) (\S+)$/.exec(line.trim()));
        if (rows.length > 16 || rows.some(row => !row)) throw new Error('Unsupported Box identity query output');
        const found = [];
        for (const [, id, name] of rows.filter(row => !before.has(row[1]))) {
            if (name !== started.box.name) throw new Error('A container with this workspace\'s path-hash label has another name; preserving everything');
            const value = checkedJson(await engine('cleanup-candidate', ['container', 'inspect', '--format', INSPECT, id]));
            if (value.id !== id || value.labels?.[BOX_LABELS.pathHash] !== started.box.pathHash || value.labels?.[BOX_LABELS.role] !== 'box') throw new Error('A container with this Box name is not a Box of this workspace; preserving everything');
            if (!Array.isArray(value.mounts) || !value.mounts.some(mount => mount.Source === profile.workspace.path)) throw new Error('A Box with this path hash does not mount the owned workspace');
            found.push(value.id);
        }
        if (found.length > 1) throw new Error('More than one Box claims the owned workspace');
        return found.length ? { id: found[0], recorded: false } : null;
    }

    // Prove the exact Box absent, no replacement under this workspace identity
    // and no container mounting the workspace or its quarantine; compare the
    // unrelated immutable inventory without altering it.
    async function proveBoxAbsent() {
        const ids = await listIds('remaining-containers');
        if (profile.box?.id && ids.includes(profile.box.id)) throw new Error('Exact Box absence not proved');
        const owned = workspacePath ? [workspacePath, quarantinePath(workspacePath, run.runId)] : [];
        const unrelated = [];
        for (const id of ids) {
            const value = checkedJson(await engine('remaining-mounts', ['container', 'inspect', '--format', INSPECT, id]));
            if (pathHash && value.labels?.[BOX_LABELS.pathHash] === pathHash) throw new Error('Foreign replacement Box occupies workspace');
            if (!Array.isArray(value.mounts) || value.mounts.some(mount => typeof mount.Source !== 'string'
                || owned.some(target => mount.Source === target || mount.Source.startsWith(`${target}/`)))) throw new Error('Workspace remains mounted or mount inventory unsupported');
            unrelated.push({ id: value.id, created: value.created, image: value.image });
        }
        if (Array.isArray(run.preInventory.containers)) {
            const sort = values => [...values].sort((a, b) => a.id.localeCompare(b.id));
            if (jsonDigest(sort(unrelated)) !== jsonDigest(sort(run.preInventory.containers))) throw new Error('Unrelated container inventory changed; preserve evidence and do not undo it');
        }
    }

    // Every exact host record name is checked before anything is removed: an
    // unrecorded one refuses the whole step, and a recorded one must still be
    // the recorded object. No glob or substring match is ever used.
    function removeHostRecords() {
        if (!instance) return;
        const recorded = new Map(recordedHostRecords(run).map(entry => [entry.path, entry]));
        const present = [];
        for (const target of hostRecordPaths(profile.host.home, instance)) {
            const stat = lstatOrNull(target);
            if (!stat) continue;
            const entry = recorded.get(target);
            if (!entry) throw new Error(`Unrecorded host state remains at ${path.basename(path.dirname(target))}/${path.basename(target)}; preserve workspace for cleanup`);
            assertRecordedHostRecord(entry, stat);
            present.push(entry);
        }
        for (const entry of present) {
            assertRecordedHostRecord(entry, fs.lstatSync(entry.path));
            if (entry.type === 'file') fs.unlinkSync(entry.path);
            else fs.rmSync(entry.path, { recursive: true, force: false });
        }
        removeCreatedHostDirectories();
    }

    // A shared host-record directory this run created is removed only while it
    // is still the recorded directory and empty; a directory that existed
    // before the run, or that holds anything now, is never touched.
    function removeCreatedHostDirectories() {
        for (const entry of run.ownedPaths.filter(value => value.role === 'host-created-directory')) {
            const stat = lstatOrNull(entry.path);
            if (!stat) continue;
            assertRecordedHostRecord(entry, stat);
            if (fs.readdirSync(entry.path).length === 0) fs.rmdirSync(entry.path);
        }
    }

    function classifyWorkspace() {
        const removal = step('workspace-removal');
        if (!profile.workspace) {
            const intent = run.operations.find(op => op.kind === 'workspace-create');
            if (!intent) return { state: 'never-created' };
            const stat = lstatOrNull(intent.path);
            if (!stat) return { state: 'never-created' };
            assertUnreceipted(intent.path, stat);
            return { state: 'unreceipted', path: intent.path };
        }
        const quarantine = quarantinePath(profile.workspace.path, run.runId);
        if (!lstatOrNull(profile.workspace.path)) {
            if (!lstatOrNull(quarantine)) {
                if (removal) return { state: 'absent' };
                throw new Error('Recorded workspace vanished without a removal record; preserving evidence');
            }
            if (!removal) throw new Error('Cleanup quarantine exists without a removal record; retain ownership evidence');
            assertOwnedDirectory(quarantine, profile.workspace, { allowMissingMarker: true });
            return { state: 'quarantined', quarantine };
        }
        assertWorkspace(profile);
        return { state: 'present' };
    }

    // A directory created before its receipt was persisted is removed only
    // while it is empty or holds nothing but this run's exact owner marker.
    function assertUnreceipted(target, stat) {
        if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(target) !== target
            || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new Error(`Unreceipted path is not provably owned; preserving it: ${target}`);
        const names = fs.readdirSync(target);
        if (names.some(name => name !== OWNER_MARKER)) throw new Error(`Unreceipted path has content; preserving it: ${target}`);
        if (names.length && fs.readFileSync(path.join(target, OWNER_MARKER), 'utf8') !== run.runId) throw new Error(`Unreceipted path has a foreign marker; preserving it: ${target}`);
    }

    function removeUnreceipted(target) {
        const stat = lstatOrNull(target);
        if (!stat) return;
        assertUnreceipted(target, stat);
        if (lstatOrNull(path.join(target, OWNER_MARKER))) fs.unlinkSync(path.join(target, OWNER_MARKER));
        fs.rmdirSync(target);
    }

    async function removeWorkspace(state) {
        if (state.state === 'never-created') return;
        const entry = step('workspace-removal');
        if (entry?.state === 'complete') return;
        if (state.state === 'unreceipted') {
            const removal = entry || begin('workspace-removal');
            removeUnreceipted(state.path);
            complete(removal);
            return;
        }
        if (state.state === 'absent') { complete(entry); return; }
        const quarantine = quarantinePath(profile.workspace.path, run.runId);
        let removal = entry;
        if (state.state === 'present') {
            removal = entry || begin('workspace-removal');
            // Persist callbacks may expose a scheduling/interruption boundary.
            // Revalidate after intent, quarantine by rename, then prove the
            // inode again before deleting. A substituted path is never removed.
            assertWorkspace(profile);
            if (lstatOrNull(quarantine)) throw new Error('Cleanup quarantine already exists; retain ownership evidence');
            fs.renameSync(profile.workspace.path, quarantine);
        }
        assertOwnedDirectory(quarantine, profile.workspace, { allowMissingMarker: true });
        if (removal.quarantine !== quarantine) { removal.quarantine = quarantine; persist(); }
        assertOwnedDirectory(quarantine, profile.workspace, { allowMissingMarker: true });
        await removeQuarantine(quarantine);
        complete(removal);
    }

    // Remove every entry but the owner marker first, so an interruption still
    // leaves the identity proof; subordinate-owned files on Linux are removed
    // through a bounded `podman unshare`, only inside the proved quarantine.
    async function removeQuarantine(quarantine) {
        for (const name of fs.readdirSync(quarantine).sort()) {
            if (name === OWNER_MARKER) continue;
            const target = path.join(quarantine, name);
            try { fs.rmSync(target, { recursive: true, force: false }); }
            catch (error) {
                if (!['EACCES', 'EPERM', 'ENOTEMPTY'].includes(error.code) || platform !== 'linux') throw error;
                assertOwnedDirectory(quarantine, profile.workspace);
                if (path.dirname(target) !== quarantine) throw new Error('Unshare removal target escaped the quarantine');
                await journaled('unshare-remove', profile.engine.path, ['unshare', '/bin/rm', '-rf', '--', target], {
                    cwd: profile.host.home, env, deadlineMs: deadline('cleanupMs', 300000),
                });
                if (lstatOrNull(target)) throw new Error('Subordinate-owned workspace content remains after unshare removal');
            }
        }
        if (fs.readdirSync(quarantine).some(name => name !== OWNER_MARKER)) throw new Error('Quarantine gained content during removal');
        if (lstatOrNull(path.join(quarantine, OWNER_MARKER))) fs.unlinkSync(path.join(quarantine, OWNER_MARKER));
        fs.rmdirSync(quarantine);
    }

    function removeParent(entry, intent) {
        if (!entry) { removeUnreceipted(intent.path); return; }
        if (!lstatOrNull(entry.path)) return;
        assertOwnedDirectory(entry.path, entry, { allowMissingMarker: true });
        const names = fs.readdirSync(entry.path);
        if (names.some(name => name !== OWNER_MARKER)) throw new Error('The task-owned parent has unexpected content; preserving it');
        if (names.length) fs.unlinkSync(path.join(entry.path, OWNER_MARKER));
        fs.rmdirSync(entry.path);
    }
}
