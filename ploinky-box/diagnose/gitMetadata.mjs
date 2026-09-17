import fs from 'node:fs';
import path from 'node:path';

// The Box mounts only the selected workspace, at its selected absolute path.
// A checkout whose Git metadata lives elsewhere (a linked worktree, a separated
// Git directory, or a common directory) cannot run Git inside the Box, and no
// host grant is added to reach that metadata. This inspection only reads.
const MAX_REPOSITORIES = 256;
const MAX_POINTER_BYTES = 4096;

function within(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function canonical(fsApi, filename) {
    try { return fsApi.realpathSync(filename); } catch { return path.resolve(filename); }
}

function childDirectories(fsApi, directory) {
    try {
        return fsApi.readdirSync(directory, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => path.join(directory, entry.name))
            .sort();
    } catch { return []; }
}

function smallFile(fsApi, filename) {
    try {
        const entry = fsApi.lstatSync(filename);
        return entry.isFile() && entry.size <= MAX_POINTER_BYTES ? String(fsApi.readFileSync(filename, 'utf8')) : null;
    } catch { return null; }
}

// Paths are resolved lexically first: the Box can open a location only through
// the selected spelling, and only when its real target is inside the workspace.
function visibleInBox(fsApi, selectedRoot, canonicalRoot, location) {
    if (!within(selectedRoot, location) || !within(canonicalRoot, canonical(fsApi, location))) return false;
    let remaining = path.relative(selectedRoot, location).split(path.sep).filter(Boolean);
    let current = selectedRoot;
    let followed = 0;
    while (remaining.length) {
        current = path.join(current, remaining.shift());
        let entry;
        try { entry = fsApi.lstatSync(current); } catch { return false; }
        if (!entry.isSymbolicLink()) continue;
        if (++followed > 40) return false;
        let target;
        try { target = path.resolve(path.dirname(current), fsApi.readlinkSync(current)); } catch { return false; }
        // Only the selected root is mounted. An absolute link using the host's
        // canonical spelling can be invisible even when realpath stays within
        // the same underlying host tree.
        if (!within(selectedRoot, target)) return false;
        remaining = [...path.relative(selectedRoot, target).split(path.sep).filter(Boolean), ...remaining];
        current = selectedRoot;
    }
    return true;
}

function metadataLocation(fsApi, marker) {
    let entry;
    try { entry = fsApi.lstatSync(marker); } catch { return null; }
    if (entry.isSymbolicLink()) {
        try { return path.resolve(path.dirname(marker), String(fsApi.readlinkSync(marker))); } catch { return null; }
    }
    if (entry.isDirectory()) return marker;
    const pointer = /^gitdir:[ \t]*(.+?)[ \t\r]*$/m.exec(smallFile(fsApi, marker) || '')?.[1];
    return pointer ? path.resolve(path.dirname(marker), pointer) : null;
}

/**
 * Report repositories at the workspace root, its immediate child directories,
 * and installed Ploinky repositories whose Git metadata the Box cannot read.
 */
export function findExternalGitMetadata(workspaceRoot, { fsApi = fs } = {}) {
    const selectedRoot = path.resolve(workspaceRoot);
    const canonicalRoot = canonical(fsApi, selectedRoot);
    const repositories = [...new Set([
        selectedRoot,
        ...childDirectories(fsApi, selectedRoot),
        ...childDirectories(fsApi, path.join(selectedRoot, '.ploinky', 'repos')),
    ])].slice(0, MAX_REPOSITORIES);
    const external = [];
    for (const repository of repositories) {
        const location = metadataLocation(fsApi, path.join(repository, '.git'));
        if (!location) continue;
        let outside = visibleInBox(fsApi, selectedRoot, canonicalRoot, location) ? null : location;
        if (!outside) {
            const common = smallFile(fsApi, path.join(location, 'commondir'))?.split('\n')[0].trim();
            const commonLocation = common ? path.resolve(location, common) : null;
            if (commonLocation && !visibleInBox(fsApi, selectedRoot, canonicalRoot, commonLocation)) outside = commonLocation;
        }
        if (outside) external.push({ repository: path.relative(selectedRoot, repository) || '.', metadata: outside });
    }
    return external;
}
