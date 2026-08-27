import { PLOINKY_WORKSPACE_ROOT } from '../config.js';
import { normalizeVerifiedProducerDirectory } from '../verifiedReadOnlyFile.js';

export const WORKSPACE_PRIVATE_DIRECTORY_SEGMENTS = Object.freeze([
    Object.freeze(['.ploinky', 'running']),
    Object.freeze(['.ploinky', 'running', 'no-wait']),
    Object.freeze(['.ploinky', 'logs']),
    Object.freeze(['.ploinky', 'logs', 'no-wait']),
]);

export function prepareWorkspacePrivateDirectories({
    workspaceRoot = PLOINKY_WORKSPACE_ROOT,
    normalizeDirectory = normalizeVerifiedProducerDirectory,
} = {}) {
    return Object.freeze(WORKSPACE_PRIVATE_DIRECTORY_SEGMENTS.map((relativeSegments) => (
        normalizeDirectory({
            trustedRoot: workspaceRoot,
            relativeSegments,
            mode: 0o700,
        })
    )));
}
