import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { PloinkyBoxError } from './errors.mjs';
import { buildHostSkillScope } from './skillScope.mjs';

export const GRAPH_SKILL_SCOPE_FILE = 'graph-skill-scope.json';

function scopeError(message, cause) {
    return new PloinkyBoxError(message, { code: 'PLOINKY_BOX_GRAPH_SKILL_SCOPE_INVALID', cause });
}

function statePath(identity) {
    const root = String(identity?.workspaceRoot || '');
    if (!path.isAbsolute(root) || !identity?.instance || identity.anchorPath !== path.join(root, '.ploinky')) {
        throw scopeError('Graph skill scope requires the exact workspace identity');
    }
    const rootStat = fs.lstatSync(root);
    const fingerprint = identity.rootFingerprint;
    if (!fingerprint || String(rootStat.dev) !== fingerprint.device || String(rootStat.ino) !== fingerprint.inode
        || rootStat.mode !== fingerprint.mode
        || (rootStat.isSymbolicLink() ? fs.readlinkSync(root) : null) !== fingerprint.symlinkTarget) {
        throw scopeError('Workspace identity changed before accessing its graph skill scope');
    }
    const anchor = fs.lstatSync(identity.anchorPath);
    const stat = fs.statSync(identity.anchorPath);
    if (!stat.isDirectory()) {
        throw scopeError('Graph skill scope requires a workspace state directory');
    }
    // Workspace state directories may be symlinks. Pin the resolved directory
    // for this operation, while continuing to reject links at the record itself.
    return Object.freeze({
        target: path.join(fs.realpathSync(identity.anchorPath), GRAPH_SKILL_SCOPE_FILE),
        device: String(stat.dev), inode: String(stat.ino), mode: stat.mode,
        anchorDevice: String(anchor.dev), anchorInode: String(anchor.ino), anchorMode: anchor.mode,
        symlinkTarget: anchor.isSymbolicLink() ? fs.readlinkSync(identity.anchorPath) : null,
    });
}

function assertStatePathCurrent(identity, before) {
    const after = statePath(identity);
    if (Object.keys(before).some(key => before[key] !== after[key])) {
        throw scopeError('Workspace state directory changed while accessing its graph skill scope');
    }
}

function normalizeRecord(identity, record) {
    const relative = record?.launchRelativePath;
    if (record?.version !== 1 || record?.instance !== identity.instance
        || typeof relative !== 'string' || path.posix.isAbsolute(relative)
        || relative.includes('\\') || relative.includes('\0')
        || (relative && relative.split('/').some(part => !part || part === '..' || part === '.'))
        || (relative && path.posix.normalize(relative) !== relative)) {
        throw scopeError('Saved graph skill scope is invalid or belongs to another workspace');
    }
    const root = fs.realpathSync(identity.workspaceRoot);
    return Object.freeze({
        PLOINKY_SKILL_SCOPE_VERSION: '1',
        PLOINKY_SKILL_SCOPE: path.posix.join('/workspace', relative),
        PLOINKY_HOST_LAUNCH_CWD: path.join(root, ...relative.split('/')),
    });
}

// Missing metadata identifies a pre-migration graph, never a workspace-wide
// scope. Successful activation can replace it; automatic rollback cannot infer it.
export function readGraphSkillScope(identity) {
    const state = statePath(identity);
    const { target } = state;
    let descriptor;
    try {
        descriptor = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    } catch (error) {
        if (error.code === 'ENOENT') {
            assertStatePathCurrent(identity, state);
            return null;
        }
        throw scopeError('Could not open the saved graph skill scope', error);
    }
    try {
        const before = fs.fstatSync(descriptor);
        if (!before.isFile() || before.nlink !== 1 || before.size > 16 * 1024
            || (typeof process.getuid === 'function' && before.uid !== process.getuid())
            || (before.mode & 0o022) !== 0) {
            throw scopeError('Saved graph skill scope must be one owned, non-writable regular file');
        }
        const bytes = fs.readFileSync(descriptor);
        const after = fs.fstatSync(descriptor);
        if (before.size !== bytes.length || before.size !== after.size
            || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
            throw scopeError('Saved graph skill scope changed while being read');
        }
        const record = normalizeRecord(identity, JSON.parse(bytes.toString('utf8')));
        assertStatePathCurrent(identity, state);
        return record;
    } catch (error) {
        if (error instanceof PloinkyBoxError) throw error;
        throw scopeError('Could not read the saved graph skill scope', error);
    } finally {
        fs.closeSync(descriptor);
    }
}

export function validateGraphSkillScope(identity, scopeEnv) {
    if (!scopeEnv) {
        throw scopeError('The prior graph has no saved launch scope; automatic graph restoration was refused. '
            + 'Run `ploinky start AGENT` from the intended launch directory to establish its scope.');
    }
    let current;
    try {
        current = buildHostSkillScope(identity.workspaceRoot, scopeEnv.PLOINKY_HOST_LAUNCH_CWD);
    } catch (error) {
        throw scopeError('The saved graph launch directory is no longer available within this workspace', error);
    }
    if (Object.keys(current).some(key => current[key] !== scopeEnv[key])) {
        throw scopeError('The saved graph launch directory changed; automatic graph restoration was refused');
    }
    return current;
}

// This record follows full-graph admission, not Box identity or ad-hoc commands.
// Null restores the absence of metadata if admission failed after writing it.
export function writeGraphSkillScope(identity, scopeEnv, lock) {
    if (typeof lock?.assertHeld !== 'function') throw scopeError('Saving graph skill scope requires the workspace mutation lock');
    lock.assertHeld(identity.instance);
    const state = statePath(identity);
    const { target } = state;
    if (!scopeEnv) {
        lock.assertHeld(identity.instance);
        assertStatePathCurrent(identity, state);
        try { fs.unlinkSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        assertStatePathCurrent(identity, state);
        return;
    }
    const current = validateGraphSkillScope(identity, scopeEnv);
    const record = {
        version: 1,
        instance: identity.instance,
        launchRelativePath: path.posix.relative('/workspace', current.PLOINKY_SKILL_SCOPE),
    };
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    try {
        fs.writeFileSync(temporary, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
        lock.assertHeld(identity.instance);
        assertStatePathCurrent(identity, state);
        fs.renameSync(temporary, target);
    } finally {
        try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
}
