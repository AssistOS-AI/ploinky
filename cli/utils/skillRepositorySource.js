import fs from 'node:fs';
import path from 'node:path';
import { PLOINKY_WORKSPACE_ROOT } from './config.js';

// Recommendations use the workspace checkout before a managed repository.
// This is discovery only: never clone, pull, or modify either source here.
export function resolveSkillRepositorySource(name, url, { workspaceRoot = PLOINKY_WORKSPACE_ROOT } = {}) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name || '')) return { source: url, origin: 'remote' };
    const workspace = fs.realpathSync(workspaceRoot);
    for (const [origin, candidate] of [
        ['workspace', path.join(workspace, name)],
        ['installed', path.join(workspace, '.ploinky', 'repos', name)],
    ]) {
        try {
            const source = fs.realpathSync(candidate);
            if (!source.startsWith(`${workspace}${path.sep}`) || !fs.statSync(source).isDirectory()) continue;
            // Both ordinary checkouts and Git worktrees count as local repositories.
            const git = fs.statSync(path.join(source, '.git'));
            if (git.isDirectory() || git.isFile()) return { source, origin };
        } catch (error) {
            if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
        }
    }
    return { source: url, origin: 'remote' };
}
