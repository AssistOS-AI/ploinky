import path from 'path';

import { resolveWorkspacePath } from '../../utils/workspacePaths.js';
import { resolveWebchatWorkspaceBase } from './workspaceSuggestions.js';

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
    try {
        return resolveWorkspacePath(raw);
    } catch {
        return '';
    }
}

export function resolveWebchatLaunchOptions(parsedUrl) {
    const cliArgs = [];
    const directoryKeys = ['workspace-dir', 'workspaceDir', 'dir'];
    const directoryKey = directoryKeys.find(key => parsedUrl.searchParams.has(key));
    if (directoryKey) {
        cliArgs.push(`--dir=${resolveWebchatWorkspaceBase(parsedUrl).base}`);
    }
    for (const [rawKey, rawValue] of parsedUrl.searchParams.entries()) {
        const key = String(rawKey || '').trim();
        if (!key || key === 'agent' || key === 'tabId' || key === 'sessionId') {
            continue;
        }
        if (directoryKeys.includes(key)) continue;
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
