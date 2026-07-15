import path from 'path';

import { getWorkspaceRoot } from '../../utils/workspacePaths.js';

export function buildWebchatQuery(parsedUrl, agentName = '') {
    const params = new URLSearchParams(parsedUrl.searchParams);
    if (agentName) {
        params.set('agent', agentName);
    }
    params.delete('tabId');
    params.delete('sessionId');
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

export function resolveWebchatLaunchOptions(parsedUrl) {
    const cliArgs = [];
    for (const [rawKey, rawValue] of parsedUrl.searchParams.entries()) {
        const key = String(rawKey || '').trim();
        if (!key || key === 'agent' || key === 'tabId' || key === 'sessionId') {
            continue;
        }
        if (key === 'workspace-dir' || key === 'workspaceDir') {
            const resolved = resolveWorkspaceScopedQueryPath(rawValue);
            if (resolved) {
                cliArgs.push(`--dir=${resolved}`);
            }
            continue;
        }
        if (key === 'workspace-skill-root' || key === 'workspaceSkillRoot') {
            const resolved = resolveWorkspaceScopedQueryPath(rawValue);
            if (resolved) {
                cliArgs.push(`--skill-root=${resolved}`);
            }
            continue;
        }
        cliArgs.push(rawValue === '' ? `--${key}` : `--${key}=${String(rawValue)}`);
    }
    return { cliArgs };
}
