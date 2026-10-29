// Execution-target provisioning (plan section 5.6 "Target helper and private descriptor seam"; proof slice P3).
//
// For an agent whose manifest carries a valid `executionTarget` declaration, and only for it, the global-agent start
// boundary calls this module before the target container is created. It
//   - creates the helper-only journal root in controller-private state (`.ploinky/data/execution-targets/<key>`),
//     which every agent bind masks, keyed by the agent principal so the journal survives container replacement;
//   - has the target's own helper mint (or report) the journal store through an injected one-shot runner, and records
//     the returned store identity together with the directory device/inode, cross-checked against its own lstat;
//   - creates a per-instance private mailbox directory and a control directory under the Box tmpfs (a plain
//     filesystem on which AF_UNIX sockets work, never the agent's fuse-overlayfs root and never the workspace bind);
//   - mints a fresh helper incarnation for this helper start, refuses one already recorded, and hands it to the
//     target's launcher only through a single-use launch file in the control directory (never env or argv of the
//     container, so a reused or restarted container can never present it again);
//   - mints one fresh 32-byte HS256 ticket secret per helper incarnation with exactly two holders: the helper (a separate
//     single-use `control/helper-secret` file it reads and unlinks itself) and a controller-private Router copy
//     (`router-ticket-secret` in the instance root on the Box tmpfs, a sibling of the bound directories and never itself
//     a bind source). Neither the return value nor the record carries it; a new incarnation retires the previous copy.
// The binds it returns are the only new mounts of the target; they are rendered by the caller after the
// controller-state guards. Their sources are exactly the directories created here (asserted again before return).
//
// Ordinary agents (no `executionTarget` key) are untouched: `planExecutionTargetLaunch` returns null and nothing here
// runs. A present declaration that is invalid, or a target that is not a global Podman agent inside a Box, refuses
// the start instead of starting as an ordinary agent.
//
// This module reads no environment, spawns nothing and opens no network: the workspace paths, the Box decision, the
// journal-init runner, randomness, the clock and fs are injected by the call site.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { deepFreeze, isId, isOpaqueIdentity, isPrincipal } from './contract.mjs';
import { readExecutionTargetDeclaration } from './declaration.mjs';

export const PROVISIONING_RECORD_VERSION = 1;
// Fixed in-target locations (never manifest-controlled).
export const TARGET_RUNTIME_ROOT = '/run/ploinky-target';
export const TARGET_MAILBOX_PATH = `${TARGET_RUNTIME_ROOT}/mailbox`;
export const TARGET_JOURNAL_PATH = `${TARGET_RUNTIME_ROOT}/journal`;
export const TARGET_CONTROL_PATH = `${TARGET_RUNTIME_ROOT}/control`;
// The fixed helper path inside every target image; a declaration cannot move it.
export const TARGET_HELPER_EXECUTABLE = '/usr/libexec/ploinky-target/rw-target-helper';
export const HELPER_LAUNCH_FILE = 'helper-launch';
// Per-incarnation ticket secret: the helper's single-use copy (in the bound control directory) and the Router's copy
// (in the unbound instance root). Both hold identical text; see ticketSecretFilePrefix.
export const HELPER_SECRET_FILE = 'helper-secret';
export const ROUTER_SECRET_FILE = 'router-ticket-secret';
export const TICKET_KID_PREFIX = 'hti1.';
export const TICKET_SECRET_BYTES = 32;
export const RECORD_FILE = 'target.json';
export const JOURNAL_ROOT_DIRECTORY = 'journal-root';
// Directory names below the controller state directory and below the Box tmpfs.
export const CONTROLLER_TARGETS_DIRECTORY = 'execution-targets';
export const BOX_TARGETS_DIRECTORY = 'ploinky-execution-targets';
// Recorded incarnations; older entries roll off (an incarnation is 128 CSPRNG bits).
export const INCARNATION_HISTORY_BOUND = 1024;
export const JOURNAL_INIT_TIMEOUT_MS = 60_000;

export const PROVISIONING_ERROR_CODES = Object.freeze({
    declarationInvalid: 'EXECUTION_TARGET_DECLARATION_INVALID',
    unsupported: 'EXECUTION_TARGET_UNSUPPORTED',
    stateInvalid: 'EXECUTION_TARGET_STATE_INVALID',
    journalUnavailable: 'EXECUTION_TARGET_JOURNAL_UNAVAILABLE',
    journalChanged: 'EXECUTION_TARGET_JOURNAL_CHANGED',
    incarnationReused: 'EXECUTION_TARGET_INCARNATION_REUSED',
    adoptionMismatch: 'EXECUTION_TARGET_ADOPTION_MISMATCH',
});

const E = PROVISIONING_ERROR_CODES;
const DECIMAL = /^(0|[1-9][0-9]{0,19})$/;

export class ExecutionTargetProvisioningError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'ExecutionTargetProvisioningError';
        this.code = code;
        this.status = code === E.declarationInvalid || code === E.unsupported ? 422 : 409;
    }
}

function refuse(message, code) {
    throw new ExecutionTargetProvisioningError(message, code);
}

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function sha256(text) {
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Controller-state directory key of one target principal. */
export function targetKey(principal) {
    return sha256(`ploinky.execution-target.v1\u0000${principal}`).slice(0, 32);
}

/** Box-tmpfs directory key of one exact target instance. */
export function instanceKey({ principal, containerName, instanceId, enableGeneration }) {
    return sha256(['ploinky.execution-target-instance.v1', principal, containerName, instanceId, enableGeneration].join('\u0000')).slice(0, 32);
}

/** The controller-private paths of one target principal. */
export function targetStatePaths(controllerStateDir, principal) {
    const root = path.join(path.resolve(controllerStateDir), CONTROLLER_TARGETS_DIRECTORY, targetKey(principal));
    return Object.freeze({
        root,
        record: path.join(root, RECORD_FILE),
        journalRoot: path.join(root, JOURNAL_ROOT_DIRECTORY),
        journal: path.join(root, JOURNAL_ROOT_DIRECTORY, 'journal'),
    });
}

/** The Box-tmpfs paths of one exact target instance. */
export function instancePaths(boxTmpRoot, key) {
    const root = path.join(path.resolve(boxTmpRoot), BOX_TARGETS_DIRECTORY, key);
    return Object.freeze({
        parent: path.join(path.resolve(boxTmpRoot), BOX_TARGETS_DIRECTORY),
        root,
        mailbox: path.join(root, 'mailbox'),
        control: path.join(root, 'control'),
        launch: path.join(root, 'control', HELPER_LAUNCH_FILE),
        secret: path.join(root, 'control', HELPER_SECRET_FILE),
        routerSecret: path.join(root, ROUTER_SECRET_FILE),
    });
}

/**
 * Start-boundary decision. Returns null for an agent without the `executionTarget` key (ordinary agents are
 * untouched) and the frozen plan `{declaration}` for a valid declaration of a global Podman agent inside a Box.
 * Everything else refuses with an ExecutionTargetProvisioningError before any side effect.
 */
export function planExecutionTargetLaunch({ manifest, runMode, runtime, insideBox } = {}) {
    const read = readExecutionTargetDeclaration(manifest);
    if (!read.present) return null;
    if (!read.result.ok) {
        refuse(`executionTarget declaration is invalid (${read.result.error.code})`, E.declarationInvalid);
    }
    if (runtime !== 'podman') refuse('an execution target must run in the Podman container runtime', E.unsupported);
    if (insideBox !== true) refuse('an execution target is provisioned only inside a Ploinky Box', E.unsupported);
    if (runMode !== 'global') refuse('an execution target must be enabled in global run mode', E.unsupported);
    return deepFreeze({ declaration: read.result.value });
}

/** Exact arguments of the one-shot journal-init run of the target image (no capability, no network, journal only). */
export function journalInitRunArgs({ image, journalRoot, selinuxRelabel = true }) {
    if (typeof image !== 'string' || !image.trim() || /\s/.test(image)) refuse('journal-init requires the exact target image', E.stateInvalid);
    if (typeof journalRoot !== 'string' || !path.isAbsolute(journalRoot)) refuse('journal-init requires an absolute journal root', E.stateInvalid);
    return Object.freeze([
        'run', '--rm', '--pull=never', '--network', 'none',
        '--cap-drop', 'all', '--security-opt', 'no-new-privileges',
        '--read-only', '--image-volume=ignore', '--user', '0:0',
        '--entrypoint', TARGET_HELPER_EXECUTABLE,
        '-v', `${journalRoot}:${TARGET_JOURNAL_PATH}${selinuxRelabel ? ':z' : ''}`,
        image,
        'journal-init', '--root', TARGET_JOURNAL_PATH,
    ]);
}

function lstatOrNull(fsApi, target) {
    try {
        return fsApi.lstatSync(target, { bigint: true });
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
}

function identityOf(stat) {
    return { device: String(stat.dev), inode: String(stat.ino) };
}

// One private directory: created 0700 if absent, otherwise a real directory owned by this process.
function privateDirectory(fsApi, target, euid, { create = true } = {}) {
    let stat = lstatOrNull(fsApi, target);
    if (!stat) {
        if (!create) refuse(`execution-target directory is missing: ${target}`, E.adoptionMismatch);
        try {
            fsApi.mkdirSync(target, { mode: 0o700 });
        } catch (error) {
            if (error?.code !== 'EEXIST') throw error;
        }
        stat = lstatOrNull(fsApi, target);
    }
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
        refuse(`execution-target path is not a real directory: ${target}`, E.stateInvalid);
    }
    if (euid !== null && Number(stat.uid) !== euid) refuse(`execution-target directory has a foreign owner: ${target}`, E.stateInvalid);
    if ((Number(stat.mode) & 0o077) !== 0) {
        if (!create) refuse(`execution-target directory is not private: ${target}`, E.adoptionMismatch);
        fsApi.chmodSync(target, 0o700);
    }
    return stat;
}

// A pre-existing root this module never creates or re-modes: the controller state directory (its mask must already
// be planned for every running agent, so a missing one refuses) and the Box tmpfs.
function existingDirectory(fsApi, target) {
    const stat = lstatOrNull(fsApi, target);
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
        refuse(`execution-target root is not an existing real directory: ${target}`, E.stateInvalid);
    }
    return stat;
}

function privateChain(fsApi, base, leaf, euid) {
    const relative = path.relative(base, leaf);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) refuse('execution-target path escapes its root', E.stateInvalid);
    let cursor = base;
    for (const segment of relative.split(path.sep)) {
        cursor = path.join(cursor, segment);
        privateDirectory(fsApi, cursor, euid);
    }
}

function fsyncDirectory(fsApi, directory) {
    const fd = fsApi.openSync(directory, 'r');
    try { fsApi.fsyncSync(fd); } finally { fsApi.closeSync(fd); }
}

function writeExclusive(fsApi, target, text) {
    const fd = fsApi.openSync(target, 'wx', 0o600);
    try {
        fsApi.writeFileSync(fd, text);
        fsApi.fsyncSync(fd);
    } finally {
        fsApi.closeSync(fd);
    }
}

function validRecord(value, principal) {
    if (!isPlainObject(value) || value.version !== PROVISIONING_RECORD_VERSION || value.principal !== principal) return false;
    const journal = value.journal;
    if (!isPlainObject(journal) || !isId(journal.storeIdentity) || !DECIMAL.test(journal.device) || !DECIMAL.test(journal.inode)) return false;
    if (!Array.isArray(value.incarnations) || value.incarnations.length > INCARNATION_HISTORY_BOUND
        || !value.incarnations.every(isId) || new Set(value.incarnations).size !== value.incarnations.length) return false;
    const current = value.current;
    if (current === null) return true;
    return isPlainObject(current) && isId(current.helperIncarnation) && value.incarnations.includes(current.helperIncarnation)
        && typeof current.containerName === 'string' && current.containerName.length > 0
        && isOpaqueIdentity(current.instanceId) && isOpaqueIdentity(current.enableGeneration)
        && /^[0-9a-f]{32}$/.test(current.instanceKey) && Number.isSafeInteger(current.issuedAtMs);
}

/** The controller-private provisioning record of one principal, or null when none exists. Invalid state refuses. */
export function readProvisioningRecord({ controllerStateDir, principal, fsApi = fs } = {}) {
    if (!isPrincipal(principal)) refuse('execution-target principal is invalid', E.stateInvalid);
    const paths = targetStatePaths(controllerStateDir, principal);
    const stat = lstatOrNull(fsApi, paths.record);
    if (!stat) return null;
    if (stat.isSymbolicLink() || !stat.isFile()) refuse('execution-target record is not a regular file', E.stateInvalid);
    let value;
    try {
        value = JSON.parse(fsApi.readFileSync(paths.record, 'utf8'));
    } catch (_) {
        refuse('execution-target record is unreadable', E.stateInvalid);
    }
    if (!validRecord(value, principal)) refuse('execution-target record is invalid', E.stateInvalid);
    return deepFreeze(value);
}

function writeRecord(fsApi, paths, record) {
    const temporary = path.join(paths.root, `.${RECORD_FILE}.${crypto.randomBytes(8).toString('hex')}.tmp`);
    writeExclusive(fsApi, temporary, `${JSON.stringify(record)}\n`);
    try {
        fsApi.renameSync(temporary, paths.record);
    } catch (error) {
        try { fsApi.unlinkSync(temporary); } catch (_) {}
        throw error;
    }
    fsyncDirectory(fsApi, paths.root);
}

function parseJournalInit(result) {
    if (!result || result.error || result.status !== 0) {
        refuse('the target helper could not provision its journal', E.journalUnavailable);
    }
    const lines = String(result.stdout || '').split('\n').map((line) => line.trim()).filter(Boolean);
    let parsed = null;
    try {
        parsed = lines.length === 1 ? JSON.parse(lines[0]) : null;
    } catch (_) {
        parsed = null;
    }
    const value = parsed?.ok === true && isPlainObject(parsed.value) ? parsed.value : null;
    if (!value || Object.keys(value).sort().join(',') !== 'device,inode,journalStoreIdentity'
        || !isId(value.journalStoreIdentity) || !DECIMAL.test(value.device) || !DECIMAL.test(value.inode)) {
        refuse('the target helper returned an invalid journal identity', E.journalUnavailable);
    }
    return value;
}

function launchFileText(journalStoreIdentity, helperIncarnation) {
    return `version=1\njournalStoreIdentity=${journalStoreIdentity}\nhelperIncarnation=${helperIncarnation}\n`;
}

/** Key id of one helper incarnation's ticket secret. */
export function ticketKid(helperIncarnation) {
    return `${TICKET_KID_PREFIX}${helperIncarnation}`;
}

/** The fixed header of a v1 ticket-secret file of one incarnation; the canonical base64url secret and `\n` follow. */
export function ticketSecretFilePrefix(helperIncarnation) {
    return `version=1\nhelperIncarnation=${helperIncarnation}\nkid=${ticketKid(helperIncarnation)}\nsecret=`;
}

function ticketSecretFileBytes(helperIncarnation, secret) {
    return Buffer.from(`${ticketSecretFilePrefix(helperIncarnation)}${secret.toString('base64url')}\n`, 'utf8');
}

function unlinkIfPresent(fsApi, target) {
    try {
        fsApi.unlinkSync(target);
    } catch (error) {
        if (error?.code !== 'ENOENT') refuse('an execution-target secret file could not be removed', E.stateInvalid);
    }
}

// A left-over instance directory is set aside, never reused. It must not carry a launch file or either secret copy
// into `.stale-*`: remove them first, and only through real directories (a symlinked root or control directory is
// never traversed; a non-directory root holds nothing to scrub and is renamed as it is).
function scrubLeftoverInstance(fsApi, instance) {
    const root = lstatOrNull(fsApi, instance.root);
    if (!root || root.isSymbolicLink() || !root.isDirectory()) return;
    unlinkIfPresent(fsApi, instance.routerSecret);
    const control = lstatOrNull(fsApi, instance.control);
    if (control) {
        if (control.isSymbolicLink() || !control.isDirectory()) {
            refuse('a left-over execution-target control path is not a real directory', E.stateInvalid);
        }
        unlinkIfPresent(fsApi, instance.launch);
        unlinkIfPresent(fsApi, instance.secret);
    }
}

// After a new incarnation is recorded, the previous instance's Router copy is retired (the previous helper holds its key
// only in memory). Only a real previous instance directory other than the new one is touched. Best effort: the record
// already names the new incarnation, so the provider refuses the previous copy whether or not it is removed, and a
// failure here never fails the start.
function retireRouterSecret(fsApi, boxTmpRoot, previousKey, currentKey) {
    try {
        if (!previousKey || previousKey === currentKey) return;
        const previous = instancePaths(boxTmpRoot, previousKey);
        const root = lstatOrNull(fsApi, previous.root);
        if (!root || root.isSymbolicLink() || !root.isDirectory()) return;
        unlinkIfPresent(fsApi, previous.routerSecret);
    } catch (_) {
        // The superseded copy stays inert on the private Box tmpfs until the Box restarts.
    }
}

function bindsFor(paths, instance) {
    return Object.freeze([
        Object.freeze({ source: instance.mailbox, target: TARGET_MAILBOX_PATH }),
        Object.freeze({ source: paths.journalRoot, target: TARGET_JOURNAL_PATH }),
        Object.freeze({ source: instance.control, target: TARGET_CONTROL_PATH }),
    ]);
}

/**
 * Provision one target instance before its container is created (or, with `adoptOnly`, re-derive the binds of an
 * already provisioned running instance without minting or creating anything).
 *
 * Inputs: `plan` from planExecutionTargetLaunch; `principal` (`agent:repo/agent`); the exact `containerName`,
 * `instanceId` and `enableGeneration` of the instance being created; `image` (exact target image reference);
 * `controllerStateDir` (the workspace `.ploinky/data`); `boxTmpRoot` (the Box tmpfs); `runJournalInit(args)` which
 * runs the container runtime with `journalInitRunArgs(...)` and returns `{status, stdout, error}`. `secretRandomBytes(n)`
 * draws the ticket secret (separate from the incarnation's `randomBytes`); it must return a fresh Buffer, which
 * is zeroed once both copies are written.
 *
 * Returns `{binds, helperIncarnation, journalStoreIdentity, instanceKey}` (never the ticket secret).
 */
export function provisionExecutionTarget({
    plan,
    principal,
    containerName,
    instanceId,
    enableGeneration,
    image,
    controllerStateDir,
    boxTmpRoot,
    adoptOnly = false,
    runJournalInit,
    fsApi = fs,
    randomBytes = crypto.randomBytes,
    secretRandomBytes = crypto.randomBytes,
    clock = Date.now,
    euid = typeof process.geteuid === 'function' ? process.geteuid() : null,
} = {}) {
    if (!isPlainObject(plan) || !isPlainObject(plan.declaration)) refuse('execution-target provisioning requires an admitted plan', E.stateInvalid);
    if (!isPrincipal(principal) || typeof containerName !== 'string' || !containerName
        || !isOpaqueIdentity(instanceId) || !isOpaqueIdentity(enableGeneration)
        || typeof controllerStateDir !== 'string' || !path.isAbsolute(controllerStateDir)
        || typeof boxTmpRoot !== 'string' || !path.isAbsolute(boxTmpRoot)) {
        refuse('execution-target provisioning inputs are invalid', E.stateInvalid);
    }
    const paths = targetStatePaths(controllerStateDir, principal);
    const key = instanceKey({ principal, containerName, instanceId, enableGeneration });
    const instance = instancePaths(boxTmpRoot, key);
    const record = readProvisioningRecord({ controllerStateDir, principal, fsApi });

    const current = record?.current;
    const sameInstance = Boolean(current && current.containerName === containerName && current.instanceId === instanceId
        && current.enableGeneration === enableGeneration && current.instanceKey === key);
    // The launch transaction may adopt an exact running container of this same instance identity instead of creating
    // one. That instance was provisioned already: re-derive its binds and incarnation, never mint or move anything.
    // (A new container of the same identity finds the single-use launch file consumed and refuses to start its helper.)
    if (!adoptOnly && sameInstance && lstatOrNull(fsApi, instance.root)) {
        return provisionExecutionTarget({
            plan, principal, containerName, instanceId, enableGeneration, image, controllerStateDir, boxTmpRoot,
            adoptOnly: true, fsApi, euid,
        });
    }

    if (adoptOnly) {
        // Validation only: the running instance must be exactly the one this record provisioned.
        if (!sameInstance) refuse('the running target is not the provisioned instance', E.adoptionMismatch);
        for (const directory of [paths.root, paths.journalRoot, instance.root, instance.mailbox, instance.control]) {
            privateDirectory(fsApi, directory, euid, { create: false });
        }
        const journal = lstatOrNull(fsApi, paths.journal);
        if (!journal || journal.isSymbolicLink() || !journal.isDirectory()
            || String(journal.dev) !== record.journal.device || String(journal.ino) !== record.journal.inode) {
            refuse('the provisioned journal changed', E.journalChanged);
        }
        return deepFreeze({ binds: bindsFor(paths, instance), helperIncarnation: current.helperIncarnation,
            journalStoreIdentity: record.journal.storeIdentity, instanceKey: key });
    }
    if (typeof runJournalInit !== 'function') refuse('execution-target provisioning requires a journal-init runner', E.stateInvalid);

    // 1. Controller-private journal root (masked from every agent bind by the `.ploinky/data` guard). The controller
    //    state directory must already exist: an agent planned while it was absent has no mask for it.
    existingDirectory(fsApi, path.resolve(controllerStateDir));
    privateChain(fsApi, path.resolve(controllerStateDir), paths.journalRoot, euid);

    // 2. A recorded journal must still be the same directory before the helper is asked anything: a lost or replaced
    //    journal is never re-provisioned silently (the helper would mint a new store identity).
    if (record) {
        const journal = lstatOrNull(fsApi, paths.journal);
        if (!journal || journal.isSymbolicLink() || !journal.isDirectory()
            || String(journal.dev) !== record.journal.device || String(journal.ino) !== record.journal.inode) {
            refuse('the recorded execution-target journal is missing or was replaced', E.journalChanged);
        }
    }
    const reported = parseJournalInit(runJournalInit(journalInitRunArgs({ image, journalRoot: paths.journalRoot })));
    const observed = lstatOrNull(fsApi, paths.journal);
    if (!observed || observed.isSymbolicLink() || !observed.isDirectory()) {
        refuse('the provisioned journal is not a directory', E.journalUnavailable);
    }
    const local = identityOf(observed);
    if (local.device !== reported.device || local.inode !== reported.inode) {
        refuse('the helper journal identity does not match the provisioned directory', E.journalUnavailable);
    }
    if (record && (record.journal.storeIdentity !== reported.journalStoreIdentity
        || record.journal.device !== local.device || record.journal.inode !== local.inode)) {
        refuse('the execution-target journal store identity changed', E.journalChanged);
    }

    // 3. A fresh helper incarnation for this helper start; a recorded value is never issued again.
    const history = record ? [...record.incarnations] : [];
    const helperIncarnation = Buffer.from(randomBytes(16)).toString('base64url');
    if (!isId(helperIncarnation)) refuse('helper incarnation minting failed', E.stateInvalid);
    if (history.includes(helperIncarnation)) refuse('a helper incarnation was minted twice', E.incarnationReused);
    // 3b. A fresh ticket secret for exactly this incarnation, zeroed in memory once both copies are written.
    const secret = secretRandomBytes(TICKET_SECRET_BYTES);
    if (!Buffer.isBuffer(secret) || secret.length !== TICKET_SECRET_BYTES) refuse('helper ticket secret minting failed', E.stateInvalid);
    let secretFile = null;
    try {
        // 4. Per-instance mailbox and control directories on the Box tmpfs. A directory left by an earlier attempt of
        //    the same instance identity is scrubbed of its launch and secret files and set aside (never reused, never
        //    deleted here).
        existingDirectory(fsApi, path.resolve(boxTmpRoot));
        privateDirectory(fsApi, instance.parent, euid);
        if (lstatOrNull(fsApi, instance.root)) {
            scrubLeftoverInstance(fsApi, instance);
            fsApi.renameSync(instance.root, `${instance.root}.stale-${crypto.randomBytes(6).toString('hex')}`);
        }
        for (const directory of [instance.root, instance.mailbox, instance.control]) {
            fsApi.mkdirSync(directory, { mode: 0o700 });
            privateDirectory(fsApi, directory, euid);
        }
        writeExclusive(fsApi, instance.launch, launchFileText(reported.journalStoreIdentity, helperIncarnation));
        // The two holders of the secret: the helper's single-use copy and the Router's copy beside the bound dirs.
        secretFile = ticketSecretFileBytes(helperIncarnation, secret);
        writeExclusive(fsApi, instance.secret, secretFile);
        writeExclusive(fsApi, instance.routerSecret, secretFile);
        fsyncDirectory(fsApi, instance.control);
        fsyncDirectory(fsApi, instance.root);
    } finally {
        secret.fill(0);
        secretFile?.fill(0);
    }

    // 5. Record identities before the target can use them.
    const previousKey = current?.instanceKey ?? null;
    history.push(helperIncarnation);
    const next = {
        version: PROVISIONING_RECORD_VERSION,
        principal,
        journal: { storeIdentity: reported.journalStoreIdentity, device: local.device, inode: local.inode },
        current: {
            helperIncarnation,
            containerName,
            instanceId,
            enableGeneration,
            instanceKey: key,
            issuedAtMs: clock(),
        },
        incarnations: history.slice(-INCARNATION_HISTORY_BOUND),
    };
    if (!validRecord(next, principal)) refuse('execution-target record would be invalid', E.stateInvalid);
    writeRecord(fsApi, paths, next);
    // The record now names the new incarnation, so the provider already refuses the previous one; also retire its copy
    // (best effort, never before the record is written).
    retireRouterSecret(fsApi, boxTmpRoot, previousKey, key);

    const binds = bindsFor(paths, instance);
    // The binds name exactly the directories provisioned above.
    for (const bind of binds) privateDirectory(fsApi, bind.source, euid, { create: false });
    return deepFreeze({ binds, helperIncarnation, journalStoreIdentity: reported.journalStoreIdentity, instanceKey: key });
}

/**
 * Discovery's `readHelper(record)` for one registry record: helper-preparation facts of the exact instance, or null.
 * `prepared` holds only for the instance the record provisioned; the journal is `available` only while the recorded
 * journal directory (device/inode) is still in place. Attestation and execution counts belong to later slices.
 */
export function readExecutionTargetHelperFacts(registryRecord, { controllerStateDir, fsApi = fs } = {}) {
    if (!isPlainObject(registryRecord)) return null;
    const principal = `agent:${registryRecord.repoName}/${registryRecord.agentName}`;
    if (!isPrincipal(principal)) return null;
    let record;
    try {
        record = readProvisioningRecord({ controllerStateDir, principal, fsApi });
    } catch (_) {
        return null;
    }
    const current = record?.current;
    if (!current || current.instanceId !== registryRecord.instanceId || current.enableGeneration !== registryRecord.enableGeneration) {
        return null;
    }
    const journal = lstatOrNull(fsApi, targetStatePaths(controllerStateDir, principal).journal);
    const available = Boolean(journal && !journal.isSymbolicLink() && journal.isDirectory()
        && String(journal.dev) === record.journal.device && String(journal.ino) === record.journal.inode);
    return deepFreeze({
        helperIncarnation: current.helperIncarnation,
        prepared: true,
        journal: available ? 'available' : 'unavailable',
        attestation: null,
        activeExecutions: 0,
    });
}
