// The outer Box workspace path contract.
//
// The host-selected workspace is bound into the Box at its own absolute path,
// so workspace files, generated links, and same-path agent grants have one
// spelling on the host, in the Box, and in nested agents. An immutable image
// cannot carry that per-workspace path: every created Box receives it as its
// working directory and reserved environment, and in-Box code reads it only
// from that environment and validates it before use.

import path from 'node:path';

import { AGENTLIB_STABLE_MOUNT_PATH } from '../../agentlib/contract.mjs';
import {
    BOX_DATA_MOUNTS,
    BOX_ROUTER_HEALTH_SOCKET,
    BOX_RUNTIME_UID,
    BOX_TMPFS,
} from '../constants.mjs';
import { PloinkyBoxError } from '../errors.mjs';

export const BOX_WORKSPACE_ROOT_ENV = 'PLOINKY_WORKSPACE_ROOT';
export const BOX_WORKSPACE_ROOT_MAX_BYTES = 4095;

// Image content, runtime mounts, and private runtime state. A workspace root
// may not replace, contain, or sit inside any of them: the writable workspace
// bind would otherwise mask, expose, or receive Box-owned data.
export const BOX_RESERVED_SUBTREES = Object.freeze([...new Set([
    // Kernel, device, and image system trees, including the Box marker.
    '/proc',
    '/sys',
    '/dev',
    '/etc',
    '/usr',
    '/bin',
    '/sbin',
    '/lib',
    '/lib32',
    '/lib64',
    '/libx32',
    // Read-only Ploinky source, the selected AgentLib, and workspace-backed caches.
    '/opt/ploinky',
    AGENTLIB_STABLE_MOUNT_PATH,
    ...Object.values(BOX_DATA_MOUNTS),
    // Private control sockets and the nested engine's configuration and stores.
    path.posix.dirname(BOX_ROUTER_HEALTH_SOCKET),
    '/home/podman/.config/containers',
    '/home/podman/.local/share/containers',
    path.posix.join(BOX_TMPFS.destination, `storage-run-${BOX_RUNTIME_UID}`),
    path.posix.join(BOX_TMPFS.destination, `podman-run-${BOX_RUNTIME_UID}`),
    // Nested agent runtime grants. Global and development agents receive the
    // workspace at this same path, where it must not mask a read-only agent
    // library, code, control, topology, model, or private home mount.
    '/Agent',
    '/code',
    '/shared',
    '/models',
    '/runtime',
    '/root',
    '/home/agent',
    '/run/ploinky-health-probes',
    '/run/ploinky-edge-topology',
])].sort());

// Box-owned directories that ordinary project directories may sit below, but
// that a workspace root may never replace or contain.
export const BOX_RESERVED_PARENTS = Object.freeze([
    BOX_TMPFS.destination,
    '/var/tmp',
]);

function within(parent, candidate) {
    return candidate === parent || candidate.startsWith(`${parent}/`);
}

function rootError(message, code = 'PLOINKY_BOX_WORKSPACE_ROOT_INVALID') {
    return new PloinkyBoxError(message, { code });
}

function workspacePathError(message) {
    return new PloinkyBoxError(`Invalid Box workspace path: ${message}`, {
        code: 'PLOINKY_BOX_WORKSPACE_PATH_INVALID',
    });
}

/**
 * Why a value cannot be the Box workspace root, or null when it can.
 *
 * The root is rendered unchanged into `--volume ROOT:ROOT`, `--workdir`, the
 * reserved environment, and nested same-path binds, so only a clean absolute
 * path that each of them carries without reinterpretation is admitted.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function boxWorkspaceRootProblem(value) {
    if (typeof value !== 'string' || value === '') return 'the path is empty';
    if (!value.isWellFormed()) return 'the path is not well-formed Unicode';
    if (/[\u0000-\u001f\u007f]/u.test(value)) return 'the path contains a control character';
    if (Buffer.byteLength(value, 'utf8') > BOX_WORKSPACE_ROOT_MAX_BYTES) {
        return `the path is longer than ${BOX_WORKSPACE_ROOT_MAX_BYTES} bytes`;
    }
    if (!value.startsWith('/')) return 'the path is not absolute';
    if (value === '/') return 'the path would replace the Box root filesystem';
    if (value.endsWith('/') || path.posix.normalize(value) !== value) {
        return 'the path is not in clean absolute form';
    }
    // Workspace readers trim this environment value; a trailing space would
    // silently select a different directory inside the Box.
    if (/\s$/u.test(value)) return 'the path ends with whitespace';
    if (value.includes(':')) return "the path contains ':', which container volume syntax uses as its separator";
    if (value.includes('\\')) return 'the path contains a backslash, which runtime path readers treat as a separator';
    const subtree = BOX_RESERVED_SUBTREES.find((reserved) => (
        within(value, reserved) || within(reserved, value)
    ));
    if (subtree) return `the path overlaps the Box-owned location ${subtree}`;
    const parent = BOX_RESERVED_PARENTS.find((reserved) => within(value, reserved));
    if (parent) return `the path would replace or contain the Box-owned directory ${parent}`;
    return null;
}

/**
 * Admit one workspace root, returning it unchanged.
 *
 * @param {unknown} value
 * @param {{ label?: string }} [options]
 * @returns {string}
 */
export function assertBoxWorkspaceRoot(value, { label = 'the workspace path' } = {}) {
    const problem = boxWorkspaceRootProblem(value);
    if (problem) {
        const shown = JSON.stringify(typeof value === 'string' ? value : String(value ?? ''));
        throw rootError(
            `Ploinky Box cannot use ${label} ${shown}: ${problem}. The workspace is mounted at its `
            + 'own absolute path inside the Box; select a workspace directory whose path can be mounted there.',
        );
    }
    return value;
}

/**
 * The workspace root of the current in-Box process, from the reserved
 * environment the host sets when it creates the Box. A missing or inadmissible
 * value is an error, never a default.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function readBoxWorkspaceRoot(env = process.env) {
    const value = env?.[BOX_WORKSPACE_ROOT_ENV];
    if (typeof value !== 'string' || value === '') {
        throw rootError(
            `${BOX_WORKSPACE_ROOT_ENV} is not set; in-Box workspace operations require the host-selected workspace root`,
            'PLOINKY_BOX_WORKSPACE_ROOT_MISSING',
        );
    }
    return assertBoxWorkspaceRoot(value, { label: BOX_WORKSPACE_ROOT_ENV });
}

/**
 * The single writable workspace bind, at the root's own absolute path.
 *
 * @param {string} workspaceRoot
 * @returns {Readonly<{ source: string, destination: string, rw: true }>}
 */
export function boxWorkspaceMount(workspaceRoot) {
    const root = assertBoxWorkspaceRoot(workspaceRoot);
    return Object.freeze({ source: root, destination: root, rw: true });
}

/** The `--volume` value of the workspace bind. */
export function boxWorkspaceVolume(workspaceRoot) {
    const mount = boxWorkspaceMount(workspaceRoot);
    return `${mount.source}:${mount.destination}`;
}

/** The reserved environment entry every created Box carries. */
export function boxWorkspaceEnvironment(workspaceRoot) {
    return Object.freeze({ [BOX_WORKSPACE_ROOT_ENV]: assertBoxWorkspaceRoot(workspaceRoot) });
}

/** `container exec` options that run a command from the workspace root. */
export function boxWorkspaceExecOptions(workspaceRoot) {
    return ['--workdir', assertBoxWorkspaceRoot(workspaceRoot)];
}

function relativeSegments(relativePath) {
    const value = String(relativePath ?? '');
    if (value === '') return [];
    const segments = value.split('/');
    if (value.includes('\0') || value.startsWith('/')
        || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
        throw workspacePathError('a workspace-relative path must be clean and must not traverse');
    }
    return segments;
}

/**
 * The Box path of a clean workspace-relative path. Traversal and absolute
 * input are rejected rather than joined, so no caller escapes the root here.
 *
 * @param {string} workspaceRoot
 * @param {string} [relativePath]
 * @returns {string}
 */
export function boxWorkspacePath(workspaceRoot, relativePath = '') {
    const root = assertBoxWorkspaceRoot(workspaceRoot);
    const segments = relativeSegments(relativePath);
    return segments.length ? `${root}/${segments.join('/')}` : root;
}

/**
 * The clean relative path of a Box path the workspace root contains.
 *
 * @param {string} workspaceRoot
 * @param {string} boxPath
 * @returns {string}
 */
export function relativeBoxWorkspacePath(workspaceRoot, boxPath) {
    const root = assertBoxWorkspaceRoot(workspaceRoot);
    const candidate = String(boxPath ?? '');
    if (candidate === root) return '';
    if (!candidate.startsWith(`${root}/`)) {
        throw workspacePathError('the path is outside the Box workspace root');
    }
    const relative = candidate.slice(root.length + 1);
    relativeSegments(relative);
    return relative;
}
