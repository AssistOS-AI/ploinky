import path from 'node:path';

import { PloinkyBoxError } from '../errors.mjs';
import {
    assertPrivateDirectoryIfPresent,
    ensurePrivateDirectory,
} from '../privateStateFiles.mjs';
import { ensureHostStateSkeleton, identityHostStateRoot } from './root.mjs';

// Directory handling shared by the host stores under `<workspace>/.ploinky-box`
// (Router bindings, GPU grants, hardware limits, update records). Every store
// directory is created one level at a time, never recursively, below a skeleton
// that `ensureHostStateSkeleton` has created and validated, so no store can
// create or follow a path above `.ploinky-box`.

function storeSegments(segments) {
    if (!Array.isArray(segments) || segments.some((segment) => (
        typeof segment !== 'string' || !segment || segment === '.' || segment === '..'
        || segment.includes('/') || segment.includes(path.sep)))) {
        throw new TypeError('Host store directory segments must be plain names');
    }
    return segments;
}

/**
 * The store's root for this identity, validated against it. Read-only: nothing
 * is created.
 */
export function storeRootFor(identity, { stateError }) {
    return identityHostStateRoot(identity, stateError);
}

/**
 * Create (or validate) the skeleton, then each segment below it. Returns the
 * deepest directory. A skeleton problem is reported through the store's own
 * error code; a missing workspace keeps its dedicated code.
 */
export function ensureStoreDirectories(identity, segments, { fsApi, subject, stateError }) {
    storeRootFor(identity, { stateError });
    try {
        ensureHostStateSkeleton(identity.workspaceRoot, { fsApi });
    } catch (error) {
        if (error instanceof PloinkyBoxError && error.code === 'PLOINKY_BOX_HOST_STATE_INVALID') {
            throw stateError(error.message, error);
        }
        throw error;
    }
    let current = identity.hostStateRoot;
    for (const segment of storeSegments(segments)) {
        current = path.join(current, segment);
        ensurePrivateDirectory(fsApi, current, { subject, stateError });
    }
    return current;
}

/**
 * Validate the chain `.ploinky-box/<segments...>` without creating anything.
 * False means some directory in it is absent; any present directory must be a
 * private real directory owned by the invoking user.
 */
export function inspectStoreDirectories(identity, segments, { fsApi, subject, stateError }) {
    let current = storeRootFor(identity, { stateError });
    if (!assertPrivateDirectoryIfPresent(fsApi, current, { subject, stateError })) return false;
    for (const segment of storeSegments(segments)) {
        current = path.join(current, segment);
        if (!assertPrivateDirectoryIfPresent(fsApi, current, { subject, stateError })) return false;
    }
    return true;
}
