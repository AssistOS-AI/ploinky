import fs from 'node:fs';
import path from 'node:path';

import { boxWorkspacePath } from './contract/workspace-root.mjs';

export const SKILL_SCOPE_ENV_NAMES = Object.freeze(['PLOINKY_SKILL_SCOPE', 'PLOINKY_SKILL_SCOPE_VERSION', 'PLOINKY_HOST_LAUNCH_CWD']);

function relativeWithin(root, directory) {
    const relative = path.relative(root, directory);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Original launch directory is outside the selected Ploinky workspace');
    return relative;
}

// Called by the host command, never with browser/session request data. This is
// per invocation metadata and does not participate in Box identity or reuse.
// Containment is proven on canonical paths; the Box path then keeps the
// selected workspace spelling, which is the Box bind destination.
export function buildHostSkillScope(workspaceRoot, launchCwd) {
    const root = fs.realpathSync(workspaceRoot);
    const launch = fs.realpathSync(launchCwd);
    if (!fs.statSync(launch).isDirectory()) throw new Error('Ploinky launch scope must be a directory');
    const relative = relativeWithin(root, launch);
    return {
        PLOINKY_SKILL_SCOPE_VERSION: '1',
        PLOINKY_SKILL_SCOPE: boxWorkspacePath(workspaceRoot, relative.split(path.sep).join('/')),
        PLOINKY_HOST_LAUNCH_CWD: launch,
    };
}

// Runtime config and session cwd cannot override host-owned launch metadata.
// Direct ploinky-local invocation uses its actual process cwd when contained.
// A process can select its workspace explicitly (PLOINKY_WORKSPACE_ROOT) from a
// cwd outside it; absent host metadata, that workspace is the default scope.
export function buildLocalSkillScope(workspaceRoot, launchCwd, env = process.env) {
    const root = fs.realpathSync(workspaceRoot);
    if (env.PLOINKY_SKILL_SCOPE_VERSION && env.PLOINKY_SKILL_SCOPE_VERSION !== '1') throw new Error('Unsupported Ploinky skill scope version');
    if (env.PLOINKY_SKILL_SCOPE_VERSION === '1' && (!env.PLOINKY_SKILL_SCOPE || !path.isAbsolute(env.PLOINKY_SKILL_SCOPE))) throw new Error('Ploinky skill scope requires an absolute directory');
    const supplied = env.PLOINKY_SKILL_SCOPE_VERSION === '1' ? env.PLOINKY_SKILL_SCOPE : null;
    let scope = fs.realpathSync(supplied || launchCwd);
    if (supplied) relativeWithin(root, scope);
    else {
        try { relativeWithin(root, scope); } catch { scope = root; }
    }
    return Object.freeze({
        PLOINKY_SKILL_SCOPE_VERSION: '1',
        PLOINKY_SKILL_SCOPE: scope,
        PLOINKY_HOST_LAUNCH_CWD: supplied ? String(env.PLOINKY_HOST_LAUNCH_CWD || '') : scope,
    });
}
