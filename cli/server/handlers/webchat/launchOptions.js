import path from 'path';

import { getWorkspaceRoot } from '../../utils/workspacePaths.js';
import {
    cliWorkdirError,
    resolveCliWorkdir,
} from '../../../utils/runtime/cliWorkdir.js';

export function buildWebchatQuery(parsedUrl, agentName = '') {
    const params = new URLSearchParams(parsedUrl.searchParams);
    if (agentName) {
        params.set('agent', agentName);
    }
    params.delete('tabId');
    params.delete('sessionId');
    params.delete('pageInstanceId');
    return params.toString();
}

export function resolveWorkspaceScopedQueryPath(value) {
    const raw = String(value || '').trim();
    if (!raw || raw.includes('\0') || path.isAbsolute(raw)) {
        return '';
    }
    const root = getWorkspaceRoot();
    const resolved = path.resolve(root, raw);
    const relative = path.relative(root, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        return '';
    }
    return resolved;
}

export function resolveWebchatLaunchOptions(parsedUrl, {
    workspaceRoot = getWorkspaceRoot(),
} = {}) {
    const workdirEntries = [...parsedUrl.searchParams.entries()].filter(([rawKey]) => {
        const key = String(rawKey || '');
        return key === 'workspace-dir' || key === 'workspaceDir';
    });
    if (workdirEntries.length === 0) {
        throw cliWorkdirError(
            'WebChat requires one workspace directory selector',
            'PLOINKY_WORKDIR_REQUIRED',
        );
    }
    if (workdirEntries.length !== 1) {
        throw cliWorkdirError('WebChat accepts exactly one workspace directory selector');
    }

    const workdir = resolveCliWorkdir(workdirEntries[0][1], { workspaceRoot });
    const providerArgv = [`--dir=${workdir.runtimePath}`];
    for (const [rawKey, rawValue] of parsedUrl.searchParams.entries()) {
        const key = String(rawKey || '');
        if (!key || key.includes('\0') || String(rawValue).includes('\0')) {
            throw cliWorkdirError('WebChat launch options must not contain NUL bytes');
        }
        if (key === 'agent'
            || key === 'tabId'
            || key === 'sessionId'
            || key === 'pageInstanceId') {
            continue;
        }
        if (key === 'workspace-dir' || key === 'workspaceDir') {
            continue;
        }
        if (key === 'workspace-skill-root' || key === 'workspaceSkillRoot') {
            const skillRoot = resolveCliWorkdir(rawValue, { workspaceRoot });
            providerArgv.push(`--skill-root=${skillRoot.runtimePath}`);
            continue;
        }
        providerArgv.push(rawValue === '' ? `--${key}` : `--${key}=${String(rawValue)}`);
    }
    return Object.freeze({
        cliArgs: Object.freeze(providerArgv),
        providerArgv: Object.freeze(providerArgv),
        workdir: workdir.canonicalPath,
        workdirRelative: workdir.relativePath,
        workspaceRoot: workdir.canonicalRoot,
        runtimeWorkdir: workdir.runtimePath,
    });
}
