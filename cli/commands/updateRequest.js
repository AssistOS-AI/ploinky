import fs from 'node:fs';
import path from 'node:path';

// `ploinky update` argument forms are parsed once, before any mutation, by
// both the host router and the in-Box core. Branch-policy flags must already
// be stripped by the caller.
//
//   update | update all            -> { kind: 'all', folder: null }
//   update all <folder> | <folder> -> { kind: 'all', folder }
//   update repos | repositories    -> { kind: 'repos' }
//   update repo|repository <name>  -> { kind: 'repo', repoName }
//   update <name>                  -> { kind: 'repo', repoName } when <name> is not a directory

export class UpdateRequestError extends Error {
    constructor(message, code = 'PLOINKY_UPDATE_REQUEST_INVALID') {
        super(message);
        this.code = code;
    }
}

function defaultIsDirectory(target) {
    try {
        return fs.statSync(target).isDirectory();
    } catch (_) {
        return false;
    }
}

function rejectTrailing(args, index) {
    if (args.length > index) {
        throw new UpdateRequestError(`update: unexpected trailing argument '${args[index]}'`);
    }
}

export function parseUpdateRequest(args = [], { cwd = process.cwd(), isDirectory = defaultIsDirectory } = {}) {
    const values = args.map(value => String(value ?? '').trim());
    const first = values[0] || '';
    const lower = first.toLowerCase();
    if (!first || lower === 'all') {
        const folder = first ? values[1] || '' : '';
        rejectTrailing(values, folder ? 2 : 1);
        if (!folder) return Object.freeze({ kind: 'all', folder: null, folderPath: null });
        const folderPath = path.resolve(cwd, folder);
        if (!isDirectory(folderPath)) {
            throw new UpdateRequestError(`update: folder '${folder}' is not an existing directory`, 'PLOINKY_UPDATE_SCOPE_MISSING');
        }
        return Object.freeze({ kind: 'all', folder, folderPath });
    }
    if (lower === 'repos' || lower === 'repositories') {
        rejectTrailing(values, 1);
        return Object.freeze({ kind: 'repos' });
    }
    if (lower === 'repo' || lower === 'repository') {
        if (!values[1]) throw new UpdateRequestError('Usage: update repo <name>');
        rejectTrailing(values, 2);
        return Object.freeze({ kind: 'repo', repoName: values[1] });
    }
    rejectTrailing(values, 1);
    const folderPath = path.resolve(cwd, first);
    if (isDirectory(folderPath)) return Object.freeze({ kind: 'all', folder: first, folderPath });
    return Object.freeze({ kind: 'repo', repoName: first });
}

// The host executes Core from the workspace root, so a bare bulk request must
// capture its launch directory before crossing that boundary.
export function withDefaultUpdateFolder(request, cwd = process.cwd(), workspaceRoot = null) {
    if (request.kind !== 'all' || request.folderPath) return request;
    if (workspaceRoot && fs.realpathSync(cwd) === fs.realpathSync(workspaceRoot)) return request;
    return Object.freeze({ ...request, folderPath: path.resolve(cwd) });
}

const inside = (root, candidate) => candidate === root || candidate.startsWith(`${root}${path.sep}`);

/**
 * Validate an update folder against the selected workspace. Containment uses
 * canonical paths; the result is the canonical folder and its path relative to
 * the canonical workspace root, which callers map onto another spelling (for
 * example the Box mount) with `mapUpdateScope`.
 */
export function resolveUpdateFolderScope(folderPath, workspaceRoot, { realpath = fs.realpathSync.native } = {}) {
    let canonicalWorkspace;
    let canonicalFolder;
    try {
        canonicalWorkspace = realpath(path.resolve(workspaceRoot));
    } catch (error) {
        throw new UpdateRequestError(`update: workspace root '${workspaceRoot}' is not accessible`, 'PLOINKY_UPDATE_SCOPE_UNMAPPABLE');
    }
    try {
        canonicalFolder = realpath(path.resolve(folderPath));
    } catch (error) {
        throw new UpdateRequestError(`update: folder '${folderPath}' does not exist`, 'PLOINKY_UPDATE_SCOPE_MISSING');
    }
    if (!inside(canonicalWorkspace, canonicalFolder)) {
        throw new UpdateRequestError(
            `update: folder '${folderPath}' is outside the selected workspace '${workspaceRoot}'`,
            'PLOINKY_UPDATE_SCOPE_OUTSIDE',
        );
    }
    return Object.freeze({
        canonicalWorkspace,
        canonicalFolder,
        relative: path.relative(canonicalWorkspace, canonicalFolder),
    });
}

// Map a canonical-relative scope onto another spelling of the same workspace.
export function mapUpdateScope(relative, mountRoot) {
    const normalized = path.normalize(String(relative || '.'));
    if (path.isAbsolute(normalized) || normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
        throw new UpdateRequestError('update: scope is not relative to the workspace', 'PLOINKY_UPDATE_SCOPE_UNMAPPABLE');
    }
    return normalized === '.' ? path.resolve(mountRoot) : path.join(path.resolve(mountRoot), normalized);
}

// Canonical core argv for a validated request; folders are absolute.
export function formatUpdateRequestArgs(request, { folderPath = request.folderPath } = {}) {
    if (request.kind === 'repos') return ['update', 'repos'];
    if (request.kind === 'repo') return ['update', 'repo', request.repoName];
    return folderPath ? ['update', 'all', folderPath] : ['update'];
}
