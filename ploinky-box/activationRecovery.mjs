import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
    ACTIVATION_INTENT_MAX_BYTES,
    ACTIVATION_MARKER_MAX_BYTES,
    ACTIVATION_MARKER_NAME,
    ACTIVATION_RECEIPT_MAX_BYTES,
    EDGE_ROUTING_SEGMENTS,
    parseActivationIntent,
    parseActivationReceipt,
} from '../cli/sandbox/activationRecords.mjs';
import {
    parseSealedEdgeSelector,
    sameSelectorIdentity,
    selectorIdentity,
} from '../cli/sandbox/edgeSelectorRecord.mjs';
import { boxWorkspaceEnvironment, boxWorkspaceExecOptions } from './contract/workspace-root.mjs';

// Host side of Q30 activation recovery: read the in-Box evidence after the
// in-Box writer is proven stopped, decide whether a failed start, restart or
// update may be rolled back, and keep the in-Box barrier marker. The trade-off
// rule: when in doubt keep the graph behind a barrier. A false barrier costs
// one `ploinky restart`; a false rollback stops a serving version.

// Engine statuses that name a stopped Box container (no process can run).
export const STOPPED_BOX_STATUSES = new Set(['exited', 'stopped', 'created', 'configured', 'initialized', 'dead']);

const SELECTOR_MAX_BYTES = 64 * 1024;
const MARKER_ENTRYPOINT = '/opt/ploinky/ploinky-box/entrypoint/activation-barrier-marker.mjs';

function hostUid() {
    return typeof process.getuid === 'function' ? process.getuid() : null;
}

function entry(state, extra = {}) {
    return Object.freeze({ state, ...extra });
}

// The workspace root, `.ploinky` and `.ploinky/data` are user directories
// whose modes follow the user's umask; they only have to be real directories
// (and the root its selected inode). The controller-only edge-routing subtree
// is created by Ploinky with fixed modes, so it must be owned by this host
// user with no group or world write.
function inspectEvidenceDirectories(identity, { fsApi = fs, uid = hostUid() } = {}) {
    const root = identity.workspaceRoot;
    const plain = [root, path.join(root, '.ploinky'), path.join(root, '.ploinky', 'data')];
    const controller = [
        path.join(root, ...EDGE_ROUTING_SEGMENTS),
        path.join(root, ...EDGE_ROUTING_SEGMENTS, 'activations'),
    ];
    const absentFrom = (index) => ({ valid: true, present: index });
    for (const [index, directory] of plain.entries()) {
        let stat;
        try {
            stat = fsApi.lstatSync(directory);
        } catch (error) {
            if (error?.code === 'ENOENT' && index > 0) return absentFrom(index);
            return { valid: false, reason: `cannot inspect ${directory}` };
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()) return { valid: false, reason: `${directory} is not a real directory` };
        if (index === 0 && identity.rootFingerprint
            && (String(stat.dev) !== String(identity.rootFingerprint.device)
                || String(stat.ino) !== String(identity.rootFingerprint.inode))) {
            return { valid: false, reason: 'the workspace root changed' };
        }
    }
    for (const [index, directory] of controller.entries()) {
        let stat;
        try {
            stat = fsApi.lstatSync(directory);
        } catch (error) {
            if (error?.code === 'ENOENT') return absentFrom(plain.length + index);
            return { valid: false, reason: `cannot inspect ${directory}` };
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()) return { valid: false, reason: `${directory} is not a real directory` };
        if ((uid !== null && stat.uid !== uid) || (stat.mode & 0o022) !== 0) {
            return { valid: false, reason: `${directory} is not a private directory owned by this user` };
        }
    }
    return { valid: true, present: plain.length + controller.length };
}

// O_NOFOLLOW, a regular file with one link, owned by this user, no group or
// world write, size-capped, and the same inode and size after the read.
function readBoundedOwnedFile(file, limit, { fsApi = fs, uid = hostUid() } = {}) {
    let fd;
    try {
        fd = fsApi.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    } catch (error) {
        if (error?.code === 'ENOENT') return entry('absent');
        return entry('invalid', { reason: error?.code === 'ELOOP' ? 'symlink' : 'unreadable' });
    }
    try {
        const before = fsApi.fstatSync(fd);
        if (!before.isFile()) return entry('invalid', { reason: 'not a regular file' });
        if (before.nlink !== 1) return entry('invalid', { reason: 'linked' });
        if ((uid !== null && before.uid !== uid) || (before.mode & 0o022) !== 0) return entry('invalid', { reason: 'not private' });
        if (before.size > limit) return entry('invalid', { reason: 'oversized' });
        const bytes = Buffer.alloc(before.size);
        let offset = 0;
        while (offset < bytes.length) {
            const count = fsApi.readSync(fd, bytes, offset, bytes.length - offset, offset);
            if (count <= 0) break;
            offset += count;
        }
        const after = fsApi.fstatSync(fd);
        let named;
        try { named = fsApi.lstatSync(file); } catch (_) { named = null; }
        if (offset !== before.size || after.size !== before.size || after.ino !== before.ino || after.dev !== before.dev
            || !named || named.ino !== before.ino || named.dev !== before.dev) {
            return entry('invalid', { reason: 'changed during read' });
        }
        return entry('read', { text: bytes.toString('utf8') });
    } catch (_) {
        return entry('invalid', { reason: 'unreadable' });
    } finally {
        try { fsApi.closeSync(fd); } catch (_) {}
    }
}

function readLiveEntry(identity, options) {
    const file = path.join(identity.workspaceRoot, ...EDGE_ROUTING_SEGMENTS, 'active.json');
    const read = readBoundedOwnedFile(file, SELECTOR_MAX_BYTES, options);
    if (read.state !== 'read') return read;
    const selector = parseSealedEdgeSelector(read.text);
    return selector ? entry('valid', { value: selector }) : entry('invalid', { reason: 'not a sealed selector' });
}

/**
 * The host's verified view of the in-Box activation evidence:
 * `{ directories, live, intent, receipt }`, each `{ state, value?, reason? }`.
 * Pass `operationId: null` to read only the live selector (a baseline).
 */
export function readActivationEvidence(identity, operationId, expectedContext, options = {}) {
    const directories = inspectEvidenceDirectories(identity, options);
    if (!directories.valid) {
        const unknown = entry('invalid', { reason: directories.reason });
        return Object.freeze({ directories: unknown, live: unknown, intent: unknown, receipt: unknown });
    }
    const edgePresent = directories.present >= 4;
    const activationsPresent = directories.present >= 5;
    const live = edgePresent ? readLiveEntry(identity, options) : entry('absent');
    if (!operationId) return Object.freeze({ directories: entry('valid'), live, intent: entry('absent'), receipt: entry('absent') });
    const recordFile = (kind) => path.join(identity.workspaceRoot, ...EDGE_ROUTING_SEGMENTS, 'activations', `${operationId}.${kind}.json`);
    let intent = entry('absent');
    let receipt = entry('absent');
    if (activationsPresent) {
        const intentRead = readBoundedOwnedFile(recordFile('intent'), ACTIVATION_INTENT_MAX_BYTES, options);
        if (intentRead.state === 'read') {
            const parsed = parseActivationIntent(intentRead.text, { operationId, expectedContext });
            intent = parsed.state === 'valid'
                ? entry('valid', { value: parsed.value, digest: parsed.digest })
                : entry('invalid', { reason: parsed.reason });
        } else {
            intent = intentRead;
        }
        const receiptRead = readBoundedOwnedFile(recordFile('receipt'), ACTIVATION_RECEIPT_MAX_BYTES, options);
        if (receiptRead.state === 'read') {
            const parsed = parseActivationReceipt(receiptRead.text, {
                operationId, intentDigest: intent.state === 'valid' ? intent.digest : null,
            });
            receipt = parsed.state === 'valid'
                ? entry('valid', { value: parsed.value })
                : entry('invalid', { reason: parsed.reason });
        } else {
            receipt = receiptRead;
        }
    }
    return Object.freeze({ directories: entry('valid'), live, intent, receipt });
}

/** The baseline identity before launch: null when absent, 'unknown' when unreadable. */
export function baselineFromEvidence(evidence) {
    if (evidence?.live?.state === 'absent') return null;
    if (evidence?.live?.state === 'valid') return selectorIdentity(evidence.live.value);
    return 'unknown';
}

function verdict(row, value, reason) {
    return Object.freeze({ row, verdict: value, reason });
}

/**
 * Decide a failed activation from evidence read after the in-Box writer was
 * proven stopped. Only a proven predecessor allows a rollback; anything else
 * keeps the graph (R7 is the catch-all).
 */
export function classifyFailedActivation({ evidence, baseline }) {
    if (evidence?.directories?.state !== 'valid') {
        return verdict('R1', 'kept-indeterminate', `the activation evidence could not be verified (${evidence?.directories?.reason || 'unknown'})`);
    }
    const { live, intent, receipt } = evidence;
    const liveSelector = live.state === 'valid' ? live.value : null;
    if (intent.state === 'absent') {
        if (live.state === 'absent' && baseline === null) return verdict('R2a', 'rollback', 'no intent and no selector');
        if (liveSelector?.state === 'inactive') return verdict('R2a', 'rollback', 'no intent and an inactive selector');
        if (liveSelector && baseline && baseline !== 'unknown' && sameSelectorIdentity(liveSelector, baseline)) {
            return verdict('R2a', 'rollback', 'no intent and the selector from before the launch');
        }
        return verdict('R7', 'kept-indeterminate', 'no intent, but the selector is not the one from before the launch');
    }
    if (intent.state !== 'valid') return verdict('R3', 'kept-indeterminate', `the activation intent is invalid (${intent.reason})`);
    const { intended, predecessor } = intent.value;
    const receiptValid = receipt.state === 'valid';
    if (liveSelector && sameSelectorIdentity(liveSelector, intended) && (receiptValid || receipt.state === 'absent')) {
        return verdict('R4', 'kept-activated', 'the live selector is the intended one');
    }
    const notCommitted = receiptValid && receipt.value.outcome === 'not-committed';
    if (notCommitted && liveSelector?.state === 'inactive') {
        return verdict('R5', 'rollback', 'not committed and the selector is inactive');
    }
    if ((receipt.state === 'absent' || notCommitted) && liveSelector && predecessor
        && sameSelectorIdentity(liveSelector, predecessor)) {
        return verdict('R6', 'rollback', 'the live selector is the predecessor');
    }
    return verdict('R7', 'kept-indeterminate', receipt.state === 'invalid'
        ? `the activation receipt is invalid (${receipt.reason})`
        : 'the live selector is neither the intended one nor the proven predecessor');
}

/**
 * Whether the selector after the host's graph stop is the one this stop
 * wrote: the in-Box stop's inactive selector (`cli-workspace-stop`, with the
 * `previousGeneration` derived from `pre` as edgeGeneration.js derives it),
 * or the preserved selector, unchanged. `pre` is the pre-stop selector.
 */
export function postStopSelectorBound(pre, post) {
    if (!post || post.state !== 'inactive') return false;
    const expectedPrevious = pre?.state === 'active' ? pre.generation : (pre?.previousGeneration || '');
    if (post.reason === 'cli-workspace-stop' && (post.previousGeneration || '') === (expectedPrevious || '')) return true;
    return Boolean(pre) && sameSelectorIdentity(post, pre);
}

/**
 * Stop proof by exact container id: absent, or a status in
 * STOPPED_BOX_STATUSES. Paused, stopping, running, unknown and an inspect
 * failure are not proof.
 */
export function proveBoxStopped({ runner, engine, containerId }) {
    const inspected = runner.query(String(engine?.name || engine || ''), [
        'container', 'inspect', '--format', '{{.State.Status}}', containerId,
    ]);
    if (!inspected?.ok) {
        return /no such (container|object)/i.test(String(inspected?.stderr || ''))
            ? Object.freeze({ proven: true, state: 'absent' })
            : Object.freeze({ proven: false, state: 'unknown', detail: String(inspected?.stderr || inspected?.status || '').trim() });
    }
    const status = String(inspected.stdout || '').trim().toLowerCase();
    if (STOPPED_BOX_STATUSES.has(status)) return Object.freeze({ proven: true, state: 'stopped', status });
    return Object.freeze({ proven: false, state: status || 'unknown', status });
}

function markerExec({ runner, engine, containerId, workspaceRoot, action, payload }) {
    const text = JSON.stringify(payload);
    const result = runner.query(String(engine?.name || engine || ''), [
        'container', 'exec', '-i', '--user', 'podman', ...boxWorkspaceExecOptions(workspaceRoot),
        ...Object.entries(boxWorkspaceEnvironment(workspaceRoot)).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
        containerId,
        'node', MARKER_ENTRYPOINT, action,
    ], { input: text, timeoutMs: 60_000 });
    if (!result?.ok) {
        return String(result?.stderr || '').trim() || String(result?.error?.message || `exit ${result?.status ?? 'unknown'}`);
    }
    if (action !== 'write') return '';
    let reported;
    try {
        reported = JSON.parse(String(result.stdout || '').trim().split('\n').at(-1));
    } catch (_) {
        // A fake or older entrypoint printed nothing parseable.
        return '';
    }
    const digest = crypto.createHash('sha256').update(text).digest('hex');
    return reported?.digest && reported.digest !== digest ? 'the Box saved different marker bytes' : '';
}

/** Install or rewrite the marker through the Box. Returns '' or the problem. */
export function writeActivationBarrierMarkerThroughBox({ runner, engine, containerId, workspaceRoot, marker }) {
    try {
        return markerExec({ runner, engine, containerId, workspaceRoot, action: 'write', payload: marker });
    } catch (error) {
        return error?.message || String(error);
    }
}

/** Remover 3: remove the marker of `operationId` through the running Box. */
export function removeActivationBarrierMarkerThroughBox({ runner, engine, containerId, workspaceRoot, operationId }) {
    try {
        return markerExec({ runner, engine, containerId, workspaceRoot, action: 'remove', payload: { operationId } });
    } catch (error) {
        return error?.message || String(error);
    }
}

/**
 * Remover 2: the Box is proven stopped or absent and the host lock is held,
 * so nothing of this workspace can change the path; unlink the marker on the
 * host path (the edgePreparationCleanup pattern). Returns '' or the problem.
 */
export function unlinkActivationBarrierMarkerOnHost({ identity, lock, fsApi = fs, uid = hostUid() }) {
    try {
        lock?.assertHeld?.(identity.instance);
        const directories = inspectEvidenceDirectories(identity, { fsApi, uid });
        if (!directories.valid) return directories.reason;
        if (directories.present < 4) return '';
        const file = path.join(identity.workspaceRoot, ...EDGE_ROUTING_SEGMENTS, ACTIVATION_MARKER_NAME);
        let stat;
        try {
            stat = fsApi.lstatSync(file);
        } catch (error) {
            return error?.code === 'ENOENT' ? '' : 'the marker cannot be inspected';
        }
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > ACTIVATION_MARKER_MAX_BYTES * 4) {
            return 'the marker is not a bounded regular file';
        }
        lock?.assertHeld?.(identity.instance);
        fsApi.unlinkSync(file);
        return '';
    } catch (error) {
        return error?.message || String(error);
    }
}
