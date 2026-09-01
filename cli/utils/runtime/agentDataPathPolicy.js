import fs from 'fs';
import path from 'path';

export const AGENT_DATA_POLICY_CODE = 'PLOINKY_AGENT_DATA_POLICY_VIOLATION';

function resolvePolicyWorkspaceRoot(workspaceRoot) {
    const configured = String(workspaceRoot || process.env.PLOINKY_WORKSPACE_ROOT || '').trim();
    return path.resolve(configured || process.cwd());
}

function policyError(message, context = {}) {
    const error = new Error(message);
    error.code = AGENT_DATA_POLICY_CODE;
    error.status = 422;
    error.context = context;
    return error;
}

export function isPathWithin(candidate, parent) {
    const resolvedCandidate = path.resolve(candidate);
    const resolvedParent = path.resolve(parent);
    const relative = path.relative(resolvedParent, resolvedCandidate);
    return relative === ''
        || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function pathEntryExists(target) {
    try {
        fs.lstatSync(target);
        return true;
    } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
    }
}

export function projectedCanonicalPath(target) {
    const resolvedTarget = path.resolve(target);
    let existing = resolvedTarget;
    while (!pathEntryExists(existing)) {
        const parent = path.dirname(existing);
        if (parent === existing) {
            throw policyError(`storage path '${resolvedTarget}' has no existing canonical ancestor`);
        }
        existing = parent;
    }
    let canonicalExisting;
    try {
        canonicalExisting = fs.realpathSync.native(existing);
    } catch (error) {
        throw policyError(`storage path '${resolvedTarget}' cannot be canonicalized`, {
            target: resolvedTarget,
            existing,
            cause: String(error?.code || ''),
        });
    }
    const suffix = path.relative(existing, resolvedTarget);
    return suffix ? path.resolve(canonicalExisting, suffix) : canonicalExisting;
}

function rejectSymlinkComponents(root, target) {
    const relative = path.relative(root, target);
    const components = relative ? relative.split(path.sep).filter(Boolean) : [];
    let cursor = root;
    for (const component of ['', ...components]) {
        if (component) cursor = path.join(cursor, component);
        try {
            if (fs.lstatSync(cursor).isSymbolicLink()) {
                throw policyError(`storage path '${target}' contains symlink component '${cursor}'`, {
                    target,
                    symlink: cursor,
                });
            }
        } catch (error) {
            if (error?.code === 'ENOENT') break;
            throw error;
        }
    }
}

export function validateAgentDataKey(value, { label = 'storage key' } = {}) {
    if (typeof value !== 'string' || !value || value === '.' || value === '..'
        || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
        throw policyError(`${label} must be one safe non-empty path segment`, {
            label,
            value: typeof value === 'string' ? value : String(value ?? ''),
        });
    }
    return value;
}

export function assertCanonicalAgentDataPath(target, {
    workspaceRoot,
    allowDataRoot = false,
} = {}) {
    const root = resolvePolicyWorkspaceRoot(workspaceRoot);
    const dataRoot = path.join(root, '.data');
    const resolvedTarget = path.resolve(target);
    if (!isPathWithin(resolvedTarget, dataRoot) || (!allowDataRoot && resolvedTarget === dataRoot)) {
        throw policyError(`agent storage path '${target}' must stay beneath '${dataRoot}'`, {
            target: resolvedTarget,
            dataRoot,
        });
    }
    rejectSymlinkComponents(dataRoot, resolvedTarget);
    const canonicalDataRoot = projectedCanonicalPath(dataRoot);
    const canonicalTarget = projectedCanonicalPath(resolvedTarget);
    if (!isPathWithin(canonicalTarget, canonicalDataRoot)
        || (!allowDataRoot && canonicalTarget === canonicalDataRoot)) {
        throw policyError(`agent storage path '${target}' escapes canonical data root '${dataRoot}'`, {
            target: resolvedTarget,
            canonicalTarget,
            dataRoot,
            canonicalDataRoot,
        });
    }
    return resolvedTarget;
}

export function resolveAgentDataPath(key, {
    workspaceRoot,
    label = 'storage key',
} = {}) {
    const safeKey = validateAgentDataKey(key, { label });
    const root = resolvePolicyWorkspaceRoot(workspaceRoot);
    return assertCanonicalAgentDataPath(path.join(root, '.data', safeKey), {
        workspaceRoot: root,
    });
}

export function ensureAgentDataDirectory(target, {
    workspaceRoot,
    mode,
} = {}) {
    const root = resolvePolicyWorkspaceRoot(workspaceRoot);
    const resolvedTarget = assertCanonicalAgentDataPath(target, { workspaceRoot: root });
    const dataRoot = path.join(root, '.data');
    assertCanonicalAgentDataPath(dataRoot, { workspaceRoot: root, allowDataRoot: true });
    fs.mkdirSync(dataRoot, { recursive: true });
    assertCanonicalAgentDataPath(resolvedTarget, { workspaceRoot: root });
    fs.mkdirSync(resolvedTarget, { recursive: true });
    assertCanonicalAgentDataPath(resolvedTarget, { workspaceRoot: root });
    if (typeof mode === 'number') fs.chmodSync(resolvedTarget, mode);
    return resolvedTarget;
}

function canonicalProtectedPath(root) {
    try {
        return projectedCanonicalPath(root);
    } catch (error) {
        if (error?.code === AGENT_DATA_POLICY_CODE) throw error;
        return path.resolve(root);
    }
}

export function assertManifestVolumeStoragePolicy(source, {
    workspaceRoot,
} = {}) {
    const root = resolvePolicyWorkspaceRoot(workspaceRoot);
    const resolvedSource = path.isAbsolute(String(source))
        ? path.resolve(String(source))
        : path.resolve(root, String(source));
    const protectedRoots = [
        path.join(root, '.ploinky', 'data'),
        path.join(root, '.ploinky', 'shared'),
    ];
    const canonicalSource = projectedCanonicalPath(resolvedSource);
    for (const protectedRoot of protectedRoots) {
        const canonicalProtected = canonicalProtectedPath(protectedRoot);
        if (isPathWithin(resolvedSource, protectedRoot)
            || isPathWithin(canonicalSource, canonicalProtected)) {
            throw policyError(`manifest volume source '${source}' targets protected legacy agent storage`, {
                source: String(source),
                resolvedSource,
                protectedRoot,
            });
        }
    }
    return resolvedSource;
}
