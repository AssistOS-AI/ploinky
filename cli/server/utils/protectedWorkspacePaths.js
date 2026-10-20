import fs from 'fs';
import path from 'path';

import { resolveCanonicalPathAsync, toRealPathSafeAsync } from './workspacePaths.js';

// Router-served workspace files never include controller state (`.ploinky`),
// agent private data (`.data`) or key material (`master-key`, `*.secrets`).
// Repository checkouts under the workspace's `.ploinky/repos` stay readable:
// Explorer previews, downloads, plugin assets and WebChat source links read
// agent source there.
const CONTROLLER_ROOT = '.ploinky';
const REPOSITORIES_DIRECTORY = 'repos';
const AGENT_DATA_ROOT = '.data';
const MASTER_KEY_NAME = 'master-key';
const SECRETS_SUFFIX = '.secrets';

// The workspace may sit on a filesystem that matches names regardless of case
// or Unicode form (APFS, also through the Box's virtiofs mount), where
// `.PLOINKY`, `.ploinKy` (Kelvin sign) and `maſter-key` (long s)
// open the protected entry. Names are compared in that folded form, and
// trailing dots and spaces are dropped for filesystems that ignore them.
export function foldWorkspaceName(name) {
    return String(name).normalize('NFKC').toLowerCase().replace(/[. ]+$/, '');
}

export function isProtectedWorkspaceSegments(segments) {
    for (let index = 0; index < segments.length; index += 1) {
        const name = foldWorkspaceName(segments[index]);
        if (name === MASTER_KEY_NAME || name.endsWith(SECRETS_SUFFIX) || name === AGENT_DATA_ROOT) return true;
        if (name === CONTROLLER_ROOT && !(index === 0 && segments[1] === REPOSITORIES_DIRECTORY)) return true;
    }
    return false;
}

// Classifies the decoded request path before any filesystem access, so a
// protected file that does not exist is refused exactly like one that does.
export function isProtectedWorkspaceRequestPath(relativePath) {
    const segments = path.posix.normalize(String(relativePath || ''))
        .split('/')
        .filter(segment => segment && segment !== '.');
    return isProtectedWorkspaceSegments(segments);
}

async function fileIdentity(target) {
    try {
        const stat = await fs.promises.stat(target, { bigint: true });
        return `${stat.dev}:${stat.ino}`;
    } catch (_) {
        return null;
    }
}

// A top-level entry that the filesystem resolves to the workspace's own
// `.ploinky` or `.data` directory is that directory, whatever folding rules
// produced the match.
async function aliasesProtectedRoot(workspaceRoot, segments) {
    if (!foldWorkspaceName(segments[0]).startsWith('.')) return false;
    const entry = await fileIdentity(path.join(workspaceRoot, segments[0]));
    if (!entry) return false;
    if (entry === await fileIdentity(path.join(workspaceRoot, AGENT_DATA_ROOT))) return true;
    return segments[1] !== REPOSITORIES_DIRECTORY
        && entry === await fileIdentity(path.join(workspaceRoot, CONTROLLER_ROOT));
}

// A path that cannot be resolved because one of its existing entries is a
// dangling or looping symlink.
async function crossesUnresolvedLink(targetPath) {
    let current = path.resolve(targetPath);
    while (!await toRealPathSafeAsync(current)) {
        try {
            if ((await fs.promises.lstat(current)).isSymbolicLink()) return true;
        } catch (_) { }
        const parent = path.dirname(current);
        if (parent === current) return false;
        current = parent;
    }
    return false;
}

// Classifies the canonical target, so a symlink anywhere in the workspace that
// leads into a protected entry is refused like the entry itself. A missing
// target is classified through its nearest existing ancestor. A dangling
// symlink on the way is refused, because where it leads cannot be classified
// and a 404 would reveal whether a protected entry exists. A target outside
// the workspace, or one whose location cannot be resolved, is refused.
export async function isProtectedWorkspaceTarget(workspaceRoot, targetPath) {
    const root = await toRealPathSafeAsync(workspaceRoot);
    if (!root || await crossesUnresolvedLink(targetPath)) return true;
    const target = await resolveCanonicalPathAsync(targetPath);
    if (!target) return true;
    const relative = path.relative(root, target);
    if (!relative) return false;
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return true;
    const segments = relative.split(path.sep);
    return isProtectedWorkspaceSegments(segments) || await aliasesProtectedRoot(root, segments);
}
