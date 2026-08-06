import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
    normalizeOuterContainerCreationTuple,
    requireFullContainerId,
} from '../contract/container.mjs';
import { PloinkyBoxError } from '../errors.mjs';

const JOURNAL_FILE_NAME = 'outer-box-journal.json';
const GENERATION = /^[a-f0-9]{64}$/;
const PATH_HASH = /^[a-f0-9]{12}$/;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,254}$/;
const PHASES = new Set([
    'candidate-created',
    'candidate-started',
    'committed',
    'container-deleted',
    'core-started',
    'deletion-ambiguous',
    'dependencies-installed',
    'destroying',
    'edge-staged',
    'health-verified',
    'intent',
    'predecessor-deleted',
    'predecessor-deleting',
    'predecessor-quiesced',
    'predecessor-quiescing',
    'resources-created',
    'retaining-resources',
    'rolling-back',
]);
const NEXT_PHASES = Object.freeze({
    intent: new Set(['intent', 'resources-created', 'candidate-created', 'rolling-back']),
    'resources-created': new Set(['resources-created', 'candidate-created', 'rolling-back']),
    'candidate-created': new Set([
        'candidate-created',
        'candidate-started',
        'predecessor-quiescing',
        'rolling-back',
    ]),
    'predecessor-quiescing': new Set(['predecessor-quiescing', 'predecessor-quiesced', 'rolling-back']),
    'predecessor-quiesced': new Set(['predecessor-quiesced', 'candidate-started', 'rolling-back']),
    'candidate-started': new Set(['candidate-started', 'dependencies-installed', 'rolling-back']),
    'dependencies-installed': new Set(['dependencies-installed', 'edge-staged', 'rolling-back']),
    'edge-staged': new Set(['edge-staged', 'core-started', 'rolling-back']),
    'core-started': new Set(['core-started', 'health-verified', 'rolling-back']),
    'health-verified': new Set([
        'health-verified',
        'committed',
        'predecessor-deleting',
        'rolling-back',
    ]),
    'predecessor-deleting': new Set([
        'predecessor-deleting',
        'predecessor-deleted',
        'deletion-ambiguous',
        'rolling-back',
    ]),
    'predecessor-deleted': new Set(['predecessor-deleted', 'committed']),
    committed: new Set(['committed', 'destroying']),
    destroying: new Set(['destroying', 'container-deleted', 'deletion-ambiguous', 'retaining-resources']),
    'container-deleted': new Set(['container-deleted', 'retaining-resources']),
    'rolling-back': new Set(['rolling-back', 'deletion-ambiguous', 'retaining-resources']),
    'deletion-ambiguous': new Set(['deletion-ambiguous', 'retaining-resources']),
    'retaining-resources': new Set(['retaining-resources', 'destroying']),
});
const RECORD_KEYS = Object.freeze([
    'container',
    'createdResources',
    'engine',
    'phase',
    'predecessor',
    'revision',
    'schemaVersion',
    'transaction',
    'workspace',
]);

function journalError(message, cause) {
    return new PloinkyBoxError(message, {
        code: 'PLOINKY_BOX_OUTER_JOURNAL_INVALID',
        cause,
    });
}

function exactObject(value) {
    return value !== null
        && typeof value === 'object'
        && !Array.isArray(value)
        && (Object.getPrototypeOf(value) === Object.prototype
            || Object.getPrototypeOf(value) === null);
}

function exactKeys(value, keys) {
    return exactObject(value)
        && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function safeString(value, label, { maximum = 131_072, pattern = null } = {}) {
    if (typeof value !== 'string'
        || value.length === 0
        || Buffer.byteLength(value, 'utf8') > maximum
        || /\u0000/u.test(value)
        || (pattern && !pattern.test(value))) {
        throw journalError(`Outer Box journal has invalid ${label}`);
    }
    return value;
}

function canonicalObject(value, label) {
    if (!exactObject(value)) throw journalError(`Outer Box journal has invalid ${label}`);
    return Object.fromEntries(Object.entries(value)
        .map(([key, entry]) => [
            safeString(key, `${label} key`, { maximum: 255 }),
            safeString(entry, `${label}.${key}`),
        ])
        .sort(([left], [right]) => left.localeCompare(right)));
}

function uniqueStrings(value, label) {
    if (!Array.isArray(value)) throw journalError(`Outer Box journal has invalid ${label}`);
    const normalized = value.map((entry) => safeString(entry, label, { maximum: 255 }));
    if (new Set(normalized).size !== normalized.length) {
        throw journalError(`Outer Box journal contains duplicate ${label}`);
    }
    return normalized;
}

function freezeDeep(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) freezeDeep(child);
        Object.freeze(value);
    }
    return value;
}

function canonicalWorkspaceRoot(value) {
    const resolved = path.resolve(safeString(value, 'workspace root'));
    let canonical;
    try {
        canonical = fs.realpathSync(resolved);
    } catch (error) {
        throw journalError('Outer Box journal workspace root is not a real directory', error);
    }
    if (resolved !== canonical) {
        throw journalError('Outer Box journal workspace root is not canonical');
    }
    return canonical;
}

function normalizedEngine(value) {
    if (!exactKeys(value, ['apiVersion', 'connection', 'hostKind', 'identity', 'name'])
        || value.name !== 'podman'
        || value.apiVersion !== 'v6.0.1'
        || !['native-linux', 'podman-machine'].includes(value.hostKind)) {
        throw journalError('Outer Box journal has invalid engine identity');
    }
    const identity = safeString(value.identity, 'engine identity', { pattern: GENERATION });
    if (!exactKeys(value.connection, ['identity', 'name', 'socketPath', 'uri'])) {
        throw journalError('Outer Box journal has invalid connection identity');
    }
    const socketPath = path.resolve(safeString(value.connection.socketPath, 'socket path'));
    let selectedUri;
    try {
        selectedUri = new URL(value.connection.uri);
    } catch {
        throw journalError('Outer Box journal has invalid selected connection URI');
    }
    if (!path.isAbsolute(value.connection.socketPath)
        || value.connection.socketPath !== socketPath
        || value.connection.identity !== value.connection.name
        || !['ssh:', 'unix:'].includes(selectedUri.protocol)
        || selectedUri.search
        || selectedUri.hash
        || (selectedUri.protocol === 'unix:' && (
            selectedUri.hostname
            || decodeURIComponent(selectedUri.pathname) !== socketPath
        ))
        || (selectedUri.protocol === 'ssh:' && (
            !['127.0.0.1', '::1', 'localhost'].includes(selectedUri.hostname)
            || !path.isAbsolute(decodeURIComponent(selectedUri.pathname))
        ))) {
        throw journalError('Outer Box journal has invalid Unix socket identity');
    }
    return {
        name: 'podman',
        identity,
        apiVersion: 'v6.0.1',
        hostKind: value.hostKind,
        connection: {
            name: safeString(value.connection.name, 'connection name', { maximum: 255 }),
            identity: safeString(value.connection.identity, 'connection identity', { maximum: 1024 }),
            uri: value.connection.uri,
            socketPath,
        },
    };
}

function normalizedWorkspace(value, expectedRoot) {
    if (!exactKeys(value, ['owner', 'pathHash', 'root'])) {
        throw journalError('Outer Box journal has invalid workspace identity');
    }
    const root = canonicalWorkspaceRoot(value.root);
    if (expectedRoot && root !== expectedRoot) {
        throw journalError('Outer Box journal workspace root mismatch');
    }
    const pathHash = safeString(value.pathHash, 'workspace path hash', { pattern: PATH_HASH });
    const actualPathHash = crypto.createHash('sha256').update(root).digest('hex').slice(0, 12);
    if (pathHash !== actualPathHash) {
        throw journalError('Outer Box journal workspace path hash mismatch');
    }
    return {
        root,
        owner: safeString(value.owner, 'workspace owner', { maximum: 255, pattern: SAFE_TOKEN }),
        pathHash,
    };
}

function normalizedTransaction(value) {
    if (!exactKeys(value, ['generation', 'id'])) {
        throw journalError('Outer Box journal has invalid transaction identity');
    }
    return {
        id: safeString(value.id, 'transaction ID', { maximum: 255, pattern: SAFE_TOKEN }),
        generation: safeString(value.generation, 'transaction generation', { pattern: GENERATION }),
    };
}

function normalizedImage(value, generationOwner, labels) {
    if (!exactKeys(value, ['rawId', 'reference', 'releaseIdentity'])
        || !exactKeys(value.releaseIdentity, ['descriptor', 'generation'])) {
        throw journalError('Outer Box journal has invalid raw image/release identity');
    }
    const rawId = requireFullContainerId(value.rawId, 'raw image ID');
    const generation = safeString(
        value.releaseIdentity.generation,
        'release generation',
        { pattern: GENERATION },
    );
    const descriptor = safeString(value.releaseIdentity.descriptor, 'release descriptor');
    if ((generationOwner && generation !== generationOwner)
        || labels['io.assistos.ploinky-box.image-ref'] !== value.reference
        || labels['io.assistos.ploinky-box.release-generation'] !== generation
        || labels['io.assistos.ploinky-box.release-descriptor'] !== descriptor) {
        throw journalError('Outer Box journal raw image/release identity mismatch');
    }
    return {
        rawId,
        reference: safeString(value.reference, 'raw image reference'),
        releaseIdentity: { generation, descriptor },
    };
}

function normalizedContainerDefinition(value, workspace, generationOwner = null) {
    if (!exactKeys(value, ['creation', 'image', 'labels', 'name'])) {
        throw journalError('Outer Box journal has invalid container definition');
    }
    const labels = canonicalObject(value.labels, 'container labels');
    if (labels['io.assistos.ploinky-box.path-hash'] !== workspace.pathHash
        || labels['io.assistos.ploinky-box.role'] !== 'box') {
        throw journalError('Outer Box journal container labels mismatch');
    }
    const creation = normalizeOuterContainerCreationTuple(value.creation);
    const image = normalizedImage(value.image, generationOwner, labels);
    return {
        name: safeString(value.name, 'container name', {
            maximum: 255,
            pattern: SAFE_TOKEN,
        }),
        labels,
        image,
        creation,
    };
}

function normalizedPredecessor(value, workspace) {
    if (value === null) return null;
    if (!exactKeys(value, [
        'container',
        'createdResources',
        'id',
        'revision',
        'state',
        'transaction',
    ])
        || !['deleted', 'running', 'stopped'].includes(value.state)) {
        throw journalError('Outer Box journal has invalid predecessor state');
    }
    const transaction = normalizedTransaction(value.transaction);
    const container = normalizedContainerDefinition(
        value.container,
        workspace,
        transaction.generation,
    );
    const expectedName = `${workspace.owner}-g-${transaction.generation.slice(0, 16)}`;
    if (container.name !== expectedName) {
        throw journalError('Outer Box journal predecessor name is not exact-generation qualified');
    }
    if (!Number.isSafeInteger(value.revision) || value.revision < 0) {
        throw journalError('Outer Box journal has invalid predecessor revision');
    }
    const createdResources = normalizedCreatedResources(value.createdResources, container.creation);
    if (createdResources.container !== (value.state !== 'deleted')) {
        throw journalError('Outer Box journal predecessor resource state does not match its lifecycle state');
    }
    return {
        id: requireFullContainerId(value.id, 'predecessor ID'),
        state: value.state,
        transaction,
        revision: value.revision,
        container,
        createdResources,
    };
}

function normalizedCreatedResources(value, creation) {
    if (!exactKeys(value, ['container', 'volumes']) || typeof value.container !== 'boolean') {
        throw journalError('Outer Box journal has invalid created-resource set');
    }
    const volumes = uniqueStrings(value.volumes, 'created-resource volumes');
    if (volumes.some((name) => !creation.volumes.includes(name))) {
        throw journalError('Outer Box journal created-resource set is outside its creation tuple');
    }
    return { container: value.container, volumes };
}

export function normalizeOuterJournalRecord(value, { workspaceRoot = null } = {}) {
    if (!exactKeys(value, RECORD_KEYS) || value.schemaVersion !== 1) {
        throw journalError('Outer Box journal has an invalid or incomplete contract');
    }
    const expectedRoot = workspaceRoot ? canonicalWorkspaceRoot(workspaceRoot) : null;
    const engine = normalizedEngine(value.engine);
    const workspace = normalizedWorkspace(value.workspace, expectedRoot);
    const transaction = normalizedTransaction(value.transaction);
    if (!exactKeys(value.container, ['creation', 'id', 'image', 'labels', 'name'])) {
        throw journalError('Outer Box journal has invalid container identity');
    }
    const definition = normalizedContainerDefinition(
        {
            name: value.container.name,
            labels: value.container.labels,
            image: value.container.image,
            creation: value.container.creation,
        },
        workspace,
        transaction.generation,
    );
    const expectedCandidateName = `${workspace.owner}-g-${transaction.generation.slice(0, 16)}`;
    if (definition.name !== expectedCandidateName) {
        throw journalError('Outer Box journal candidate name is not exact-generation qualified');
    }
    const containerId = value.container.id === null
        ? null
        : requireFullContainerId(value.container.id);
    const predecessor = normalizedPredecessor(value.predecessor, workspace);
    if (predecessor?.id === containerId) {
        throw journalError('Outer Box journal candidate duplicates its predecessor ID');
    }
    if (predecessor?.state !== 'deleted'
        && predecessor?.transaction.generation === transaction.generation) {
        throw journalError('Outer Box journal candidate duplicates its predecessor generation');
    }
    const createdResources = normalizedCreatedResources(value.createdResources, definition.creation);
    const phase = safeString(value.phase, 'phase', { maximum: 64 });
    if (!PHASES.has(phase)) throw journalError('Outer Box journal has invalid phase');
    const historicalDeletedId = containerId !== null
        && !createdResources.container
        && ['container-deleted', 'retaining-resources'].includes(phase);
    if (!historicalDeletedId && (containerId === null) !== !createdResources.container) {
        throw journalError('Outer Box journal container ID and created-resource state disagree');
    }
    if (!Number.isSafeInteger(value.revision) || value.revision < 0) {
        throw journalError('Outer Box journal has invalid revision');
    }
    return freezeDeep({
        schemaVersion: 1,
        engine,
        workspace,
        transaction,
        container: {
            ...definition,
            id: containerId,
        },
        predecessor,
        createdResources,
        phase,
        revision: value.revision,
    });
}

function ensureDirectory(directory, { privateDirectory = false } = {}) {
    try {
        const stat = fs.lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw journalError(`Outer Box journal directory is unsafe: ${directory}`);
        }
        if (privateDirectory && (stat.mode & 0o777) !== 0o700) {
            throw journalError(`Outer Box journal private directory has unsafe permissions: ${directory}`);
        }
    } catch (error) {
        if (error instanceof PloinkyBoxError) throw error;
        if (error.code !== 'ENOENT') throw journalError('Outer Box journal directory is unavailable', error);
        fs.mkdirSync(directory, { recursive: false, mode: privateDirectory ? 0o700 : 0o755 });
    }
}

function ensurePrivateParent(workspaceRoot, journalPath) {
    const relative = path.relative(workspaceRoot, path.dirname(journalPath));
    if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
        throw journalError('Outer Box journal path escapes its workspace');
    }
    let current = workspaceRoot;
    const parts = relative.split(path.sep);
    for (let index = 0; index < parts.length; index += 1) {
        current = path.join(current, parts[index]);
        ensureDirectory(current, { privateDirectory: index === parts.length - 1 });
    }
}

function privateParentExists(workspaceRoot, journalPath) {
    const relative = path.relative(workspaceRoot, path.dirname(journalPath));
    if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
        throw journalError('Outer Box journal path escapes its workspace');
    }
    let current = workspaceRoot;
    const parts = relative.split(path.sep);
    for (let index = 0; index < parts.length; index += 1) {
        current = path.join(current, parts[index]);
        let stat;
        try {
            stat = fs.lstatSync(current);
        } catch (error) {
            if (error.code === 'ENOENT') return false;
            throw journalError('Outer Box journal directory is unavailable', error);
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw journalError(`Outer Box journal directory is unsafe: ${current}`);
        }
        if (index === parts.length - 1 && (stat.mode & 0o777) !== 0o700) {
            throw journalError(`Outer Box journal private directory has unsafe permissions: ${current}`);
        }
    }
    return true;
}

function assertRegularPrivateFile(filePath) {
    let stat;
    try {
        stat = fs.lstatSync(filePath);
    } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw journalError('Outer Box journal metadata is unavailable', error);
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) {
        throw journalError('Outer Box journal is not one private regular file');
    }
    return true;
}

function readFileRecord(filePath, workspaceRoot, { allowMissing = false } = {}) {
    const maximumBytes = 1_048_576;
    if (!Number.isInteger(fs.constants.O_NOFOLLOW)) {
        throw journalError('Outer Box journal no-follow reads are unavailable');
    }
    let descriptor;
    try {
        descriptor = fs.openSync(
            filePath,
            fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
        );
        const before = fs.fstatSync(descriptor, { bigint: true });
        const expectedUid = typeof process.getuid === 'function'
            ? BigInt(process.getuid())
            : before.uid;
        if (!before.isFile()
            || before.nlink !== 1n
            || before.uid !== expectedUid
            || (before.mode & 0o777n) !== 0o600n
            || before.size < 1n
            || before.size > BigInt(maximumBytes)) {
            throw journalError('Outer Box journal is not one bounded private regular file');
        }
        const buffer = Buffer.allocUnsafe(maximumBytes + 1);
        let length = 0;
        while (length < buffer.length) {
            const count = fs.readSync(
                descriptor,
                buffer,
                length,
                buffer.length - length,
                null,
            );
            if (count === 0) break;
            length += count;
        }
        if (length > maximumBytes) throw journalError('Outer Box journal exceeds its size bound');
        const after = fs.fstatSync(descriptor, { bigint: true });
        for (const key of ['dev', 'ino', 'mode', 'nlink', 'uid', 'size', 'mtimeNs', 'ctimeNs']) {
            if (before[key] !== after[key]) {
                throw journalError('Outer Box journal changed during its exact-file read');
            }
        }
        if (after.size !== BigInt(length)) {
            throw journalError('Outer Box journal size changed during its bounded read');
        }
        const raw = buffer.subarray(0, length).toString('utf8');
        return normalizeOuterJournalRecord(JSON.parse(raw), { workspaceRoot });
    } catch (error) {
        if (error?.code === 'ENOENT') {
            if (allowMissing) return null;
            throw journalError('Outer Box journal is missing', error);
        }
        if (error instanceof PloinkyBoxError) throw error;
        throw journalError('Outer Box journal is unreadable or corrupt', error);
    } finally {
        if (descriptor !== undefined) {
            try { fs.closeSync(descriptor); } catch {}
        }
    }
}

function withClaim(filePath, action) {
    const claimPath = `${filePath}.claim`;
    let descriptor;
    try {
        descriptor = fs.openSync(claimPath, 'wx', 0o600);
    } catch (error) {
        throw journalError('Outer Box journal is busy or has a stale claim', error);
    }
    try {
        return action();
    } finally {
        try { fs.closeSync(descriptor); } catch {}
        try { fs.unlinkSync(claimPath); } catch {}
    }
}

function fsyncDirectory(directory) {
    let descriptor;
    try {
        descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
        fs.fsyncSync(descriptor);
    } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
    }
}

function atomicWrite(filePath, record) {
    const token = crypto.randomBytes(12).toString('hex');
    const temporary = `${filePath}.${token}.tmp`;
    let descriptor;
    try {
        descriptor = fs.openSync(temporary, 'wx', 0o600);
        fs.writeFileSync(descriptor, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.renameSync(temporary, filePath);
        fs.chmodSync(filePath, 0o600);
        fsyncDirectory(path.dirname(filePath));
    } finally {
        if (descriptor !== undefined) {
            try { fs.closeSync(descriptor); } catch {}
        }
        try { fs.unlinkSync(temporary); } catch {}
    }
}

function normalizeCas(value) {
    if (!exactKeys(value, ['containerId', 'generation', 'revision'])
        || !GENERATION.test(value.generation)
        || !Number.isSafeInteger(value.revision)
        || value.revision < 0) {
        throw journalError('Outer Box journal has invalid CAS identity');
    }
    return {
        generation: value.generation,
        containerId: value.containerId === null
            ? null
            : requireFullContainerId(value.containerId, 'CAS container ID'),
        revision: value.revision,
    };
}

function assertCas(record, expected) {
    const selected = normalizeCas(expected);
    if (record.transaction.generation !== selected.generation
        || record.container.id !== selected.containerId
        || record.revision !== selected.revision) {
        throw journalError('Outer Box journal CAS mismatch or stale generation');
    }
}

function assertReadExpected(record, expected) {
    if (!expected) return;
    if (!exactObject(expected)) throw journalError('Outer Box journal has invalid read expectation');
    const supported = new Set(['containerId', 'engineIdentity', 'generation', 'owner', 'workspaceRoot']);
    if (Object.keys(expected).some((key) => !supported.has(key))) {
        throw journalError('Outer Box journal has invalid read expectation');
    }
    const mismatched = (Object.hasOwn(expected, 'containerId') && record.container.id !== expected.containerId)
        || (Object.hasOwn(expected, 'engineIdentity') && record.engine.identity !== expected.engineIdentity)
        || (Object.hasOwn(expected, 'generation') && record.transaction.generation !== expected.generation)
        || (Object.hasOwn(expected, 'owner') && record.workspace.owner !== expected.owner)
        || (Object.hasOwn(expected, 'workspaceRoot')
            && record.workspace.root !== path.resolve(expected.workspaceRoot));
    if (mismatched) throw journalError('Outer Box journal read identity mismatch');
}

function assertPristineIntent(record) {
    if (record.revision !== 0
        || record.phase !== 'intent'
        || record.container.id !== null
        || record.createdResources.container
        || record.createdResources.volumes.length !== 0) {
        throw journalError('Outer Box journal creation requires one pristine intent');
    }
}

function containerDefinition(record) {
    return {
        name: record.container.name,
        labels: record.container.labels,
        image: record.container.image,
        creation: record.container.creation,
    };
}

export function createOuterJournalStore({ workspaceRoot, filePath = null } = {}) {
    const root = canonicalWorkspaceRoot(workspaceRoot);
    const selectedPath = path.resolve(filePath || path.join(
        root,
        '.ploinky',
        'private',
        JOURNAL_FILE_NAME,
    ));
    const relative = path.relative(root, selectedPath);
    if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
        throw journalError('Outer Box journal path escapes its workspace');
    }
    const prepare = () => ensurePrivateParent(root, selectedPath);
    const read = ({ allowMissing = false, expected = null } = {}) => {
        if (!privateParentExists(root, selectedPath)) {
            if (allowMissing) return null;
            throw journalError('Outer Box journal is missing');
        }
        const record = readFileRecord(selectedPath, root, { allowMissing });
        if (record) assertReadExpected(record, expected);
        return record;
    };
    return Object.freeze({
        path: selectedPath,
        read,
        create(value) {
            prepare();
            const record = normalizeOuterJournalRecord(value, { workspaceRoot: root });
            assertPristineIntent(record);
            return withClaim(selectedPath, () => {
                if (assertRegularPrivateFile(selectedPath)) {
                    throw journalError('Outer Box journal already exists');
                }
                atomicWrite(selectedPath, record);
                return readFileRecord(selectedPath, root);
            });
        },
        replaceIntent(expected, value) {
            if (!privateParentExists(root, selectedPath)) {
                throw journalError('Outer Box journal is missing');
            }
            const replacement = normalizeOuterJournalRecord(value, { workspaceRoot: root });
            assertPristineIntent(replacement);
            return withClaim(selectedPath, () => {
                const current = readFileRecord(selectedPath, root);
                assertCas(current, expected);
                requireFullContainerId(current.container.id, 'replacement predecessor ID');
                const activePredecessor = current.phase === 'committed'
                    && current.createdResources.container;
                const deletedPredecessor = ['container-deleted', 'retaining-resources'].includes(current.phase)
                    && !current.createdResources.container;
                if ((!activePredecessor && !deletedPredecessor)
                    || (activePredecessor
                        && replacement.transaction.generation === current.transaction.generation)
                    || !isDeepStrictEqual(replacement.engine, current.engine)
                    || !isDeepStrictEqual(replacement.workspace, current.workspace)
                    || replacement.predecessor?.id !== current.container.id
                    || (deletedPredecessor && replacement.predecessor?.state !== 'deleted')
                    || !isDeepStrictEqual(
                        replacement.predecessor?.transaction,
                        current.transaction,
                    )
                    || replacement.predecessor?.revision !== current.revision
                    || !isDeepStrictEqual(
                        replacement.predecessor?.container,
                        containerDefinition(current),
                    )
                    || !isDeepStrictEqual(
                        replacement.predecessor?.createdResources,
                        current.createdResources,
                    )) {
                    throw journalError('Outer Box replacement intent does not exactly preserve its predecessor');
                }
                atomicWrite(selectedPath, replacement);
                return readFileRecord(selectedPath, root);
            });
        },
        update(expected, changes) {
            if (!privateParentExists(root, selectedPath)) {
                throw journalError('Outer Box journal is missing');
            }
            if (!exactObject(changes)
                || Object.keys(changes).some((key) => !['createdResources', 'phase'].includes(key))
                || Object.keys(changes).length === 0) {
                throw journalError('Outer Box journal update has invalid fields');
            }
            return withClaim(selectedPath, () => {
                const current = readFileRecord(selectedPath, root);
                assertCas(current, expected);
                const phase = changes.phase ?? current.phase;
                if (!NEXT_PHASES[current.phase]?.has(phase)) {
                    throw journalError(`Outer Box journal phase transition is invalid: ${current.phase} -> ${phase}`);
                }
                if (phase === 'committed' && current.predecessor !== null) {
                    throw journalError(
                        'Outer Box replacement commit requires exact predecessor retirement publication',
                    );
                }
                const next = normalizeOuterJournalRecord({
                    ...current,
                    ...(Object.hasOwn(changes, 'createdResources')
                        ? { createdResources: changes.createdResources }
                        : {}),
                    phase,
                    revision: current.revision + 1,
                }, { workspaceRoot: root });
                atomicWrite(selectedPath, next);
                return readFileRecord(selectedPath, root);
            });
        },
        commitCandidate(expected) {
            if (!privateParentExists(root, selectedPath)) {
                throw journalError('Outer Box journal is missing');
            }
            return withClaim(selectedPath, () => {
                const current = readFileRecord(selectedPath, root);
                assertCas(current, expected);
                requireFullContainerId(current.container.id, 'committed candidate ID');
                const newCandidate = current.phase === 'health-verified'
                    && current.predecessor === null;
                const deletedTombstoneReplacement = current.phase === 'health-verified'
                    && current.predecessor?.state === 'deleted';
                const retiredActiveReplacement = current.phase === 'predecessor-deleted'
                    && current.predecessor?.state === 'deleted';
                if (!newCandidate && !deletedTombstoneReplacement && !retiredActiveReplacement) {
                    throw journalError(
                        'Outer Box candidate commit requires final health and exact predecessor retirement',
                    );
                }
                const next = normalizeOuterJournalRecord({
                    ...current,
                    predecessor: null,
                    createdResources: {
                        container: true,
                        volumes: [...new Set([
                            ...current.createdResources.volumes,
                            ...(current.predecessor?.createdResources?.volumes || []),
                        ])],
                    },
                    phase: 'committed',
                    revision: current.revision + 1,
                }, { workspaceRoot: root });
                atomicWrite(selectedPath, next);
                return readFileRecord(selectedPath, root);
            });
        },
        markContainerDeleted(expected) {
            if (!privateParentExists(root, selectedPath)) {
                throw journalError('Outer Box journal is missing');
            }
            return withClaim(selectedPath, () => {
                const current = readFileRecord(selectedPath, root);
                assertCas(current, expected);
                requireFullContainerId(current.container.id, 'deleted container ID');
                if (current.phase !== 'destroying' || !current.createdResources.container) {
                    throw journalError(
                        'Outer Box deletion publication requires one destroying owned container',
                    );
                }
                const next = normalizeOuterJournalRecord({
                    ...current,
                    createdResources: { ...current.createdResources, container: false },
                    phase: 'container-deleted',
                    revision: current.revision + 1,
                }, { workspaceRoot: root });
                atomicWrite(selectedPath, next);
                return readFileRecord(selectedPath, root);
            });
        },
        markPredecessorDeleted(expected) {
            if (!privateParentExists(root, selectedPath)) {
                throw journalError('Outer Box journal is missing');
            }
            return withClaim(selectedPath, () => {
                const current = readFileRecord(selectedPath, root);
                assertCas(current, expected);
                requireFullContainerId(current.container.id, 'replacement candidate ID');
                requireFullContainerId(current.predecessor?.id, 'replacement predecessor ID');
                if (current.phase !== 'predecessor-deleting'
                    || current.predecessor.state === 'deleted'
                    || !current.predecessor.createdResources.container) {
                    throw journalError(
                        'Outer Box predecessor deletion publication requires one active exact predecessor',
                    );
                }
                const next = normalizeOuterJournalRecord({
                    ...current,
                    predecessor: {
                        ...current.predecessor,
                        state: 'deleted',
                        createdResources: {
                            ...current.predecessor.createdResources,
                            container: false,
                        },
                    },
                    phase: 'predecessor-deleted',
                    revision: current.revision + 1,
                }, { workspaceRoot: root });
                atomicWrite(selectedPath, next);
                return readFileRecord(selectedPath, root);
            });
        },
        markVolumeDeleted(expected, volumeName) {
            if (!privateParentExists(root, selectedPath)) {
                throw journalError('Outer Box journal is missing');
            }
            const selectedName = safeString(
                volumeName,
                'deleted volume name',
                { maximum: 255 },
            );
            return withClaim(selectedPath, () => {
                const current = readFileRecord(selectedPath, root);
                assertCas(current, expected);
                if (!['container-deleted', 'retaining-resources'].includes(current.phase)
                    || current.createdResources.container
                    || !current.createdResources.volumes.includes(selectedName)) {
                    throw journalError(
                        'Outer Box volume deletion publication is stale or not transaction-owned',
                    );
                }
                const next = normalizeOuterJournalRecord({
                    ...current,
                    createdResources: {
                        container: false,
                        volumes: current.createdResources.volumes.filter(
                            (name) => name !== selectedName,
                        ),
                    },
                    revision: current.revision + 1,
                }, { workspaceRoot: root });
                atomicWrite(selectedPath, next);
                return readFileRecord(selectedPath, root);
            });
        },
        publishContainerId(expected, containerId) {
            if (!privateParentExists(root, selectedPath)) {
                throw journalError('Outer Box journal is missing');
            }
            const fullId = requireFullContainerId(containerId);
            return withClaim(selectedPath, () => {
                const current = readFileRecord(selectedPath, root);
                assertCas(current, expected);
                if (current.container.id !== null
                    || current.createdResources.container
                    || !['intent', 'resources-created'].includes(current.phase)) {
                    throw journalError('Outer Box journal container ID publication is stale');
                }
                const next = normalizeOuterJournalRecord({
                    ...current,
                    container: { ...current.container, id: fullId },
                    createdResources: { ...current.createdResources, container: true },
                    phase: 'candidate-created',
                    revision: current.revision + 1,
                }, { workspaceRoot: root });
                atomicWrite(selectedPath, next);
                return readFileRecord(selectedPath, root);
            });
        },
        abandonIntent(expected) {
            if (!privateParentExists(root, selectedPath)) {
                throw journalError('Outer Box journal is missing');
            }
            return withClaim(selectedPath, () => {
                const current = readFileRecord(selectedPath, root);
                assertCas(current, expected);
                if (current.phase !== 'rolling-back'
                    || current.container.id !== null
                    || current.createdResources.container
                    || current.createdResources.volumes.length !== 0) {
                    throw journalError(
                        'Outer Box intent abandonment requires an unpublished rolling-back transaction with no created resources',
                    );
                }
                fs.unlinkSync(selectedPath);
                fsyncDirectory(path.dirname(selectedPath));
                return true;
            });
        },
        restorePredecessor(expected) {
            if (!privateParentExists(root, selectedPath)) {
                throw journalError('Outer Box journal is missing');
            }
            return withClaim(selectedPath, () => {
                const current = readFileRecord(selectedPath, root);
                assertCas(current, expected);
                if (current.phase !== 'rolling-back' || current.predecessor === null) {
                    throw journalError('Outer Box predecessor restoration requires an exact rolling-back candidate');
                }
                if (current.container.id === null) {
                    if (current.createdResources.container
                        || current.createdResources.volumes.length !== 0) {
                        throw journalError(
                            'Outer Box unpublished predecessor restoration requires zero retained candidate resources',
                        );
                    }
                } else {
                    requireFullContainerId(current.container.id, 'rollback candidate ID');
                }
                const revision = Math.max(current.revision, current.predecessor.revision) + 1;
                if (!Number.isSafeInteger(revision)) {
                    throw journalError('Outer Box predecessor restoration revision overflow');
                }
                const predecessorDeleted = current.predecessor.state === 'deleted';
                const restored = normalizeOuterJournalRecord({
                    schemaVersion: 1,
                    engine: current.engine,
                    workspace: current.workspace,
                    transaction: current.predecessor.transaction,
                    container: {
                        ...current.predecessor.container,
                        id: current.predecessor.id,
                    },
                    predecessor: null,
                    createdResources: current.predecessor.createdResources,
                    phase: predecessorDeleted ? 'container-deleted' : 'committed',
                    revision,
                }, { workspaceRoot: root });
                atomicWrite(selectedPath, restored);
                return readFileRecord(selectedPath, root);
            });
        },
        retire(expected) {
            if (!privateParentExists(root, selectedPath)) {
                throw journalError('Outer Box journal is missing');
            }
            return withClaim(selectedPath, () => {
                const current = readFileRecord(selectedPath, root);
                assertCas(current, expected);
                requireFullContainerId(current.container.id, 'retirement container ID');
                fs.unlinkSync(selectedPath);
                fsyncDirectory(path.dirname(selectedPath));
                return true;
            });
        },
    });
}

export const OUTER_JOURNAL_PHASES = Object.freeze([...PHASES].sort());
