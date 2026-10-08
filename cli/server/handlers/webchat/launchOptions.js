import path from 'path';

import { resolveWorkspacePath, resolveWorkspacePathAsync } from '../../utils/workspacePaths.js';
import { resolveWebchatWorkspaceBase, resolveWebchatWorkspaceBaseAsync } from './workspaceSuggestions.js';

export function buildWebchatQuery(parsedUrl, agentName = '') {
    const params = new URLSearchParams(parsedUrl.searchParams);
    if (agentName) {
        params.set('agent', agentName);
    }
    params.delete('tabId');
    params.delete('sessionId');
    return params.toString();
}

// Identity and runtime-scope inputs are owned by the router and the agent
// manifest. A query string must never supply them as agent launch flags.
const RESERVED_LAUNCH_KEY_RE = /^(?:sso-|webchat-runtime-scope$)/i;

export function isReservedWebchatLaunchKey(key) {
    return RESERVED_LAUNCH_KEY_RE.test(String(key || '').trim());
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
        if (!key || key === 'agent' || key === 'tabId' || key === 'sessionId' || isReservedWebchatLaunchKey(key)) {
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

export async function resolveWebchatLaunchOptionsAsync(parsedUrl, { workspaceBase } = {}) {
    const cliArgs = [];
    const directoryKeys = ['workspace-dir', 'workspaceDir', 'dir'];
    if (directoryKeys.some(key => parsedUrl.searchParams.has(key))) {
        const base = workspaceBase || await resolveWebchatWorkspaceBaseAsync(parsedUrl);
        cliArgs.push(`--dir=${base.base}`);
    }
    for (const [rawKey, rawValue] of parsedUrl.searchParams.entries()) {
        const key = String(rawKey || '').trim();
        if (!key || key === 'agent' || key === 'tabId' || key === 'sessionId' || directoryKeys.includes(key)
            || isReservedWebchatLaunchKey(key)) continue;
        if (key === 'workspace-skill-root' || key === 'workspaceSkillRoot') {
            const raw = String(rawValue || '').trim();
            if (!raw || raw.includes('\0') || path.isAbsolute(raw)) continue;
            try {
                cliArgs.push(`--skill-root=${await resolveWorkspacePathAsync(raw)}`);
            } catch (_) { }
            continue;
        }
        cliArgs.push(rawValue === '' ? `--${key}` : `--${key}=${String(rawValue)}`);
    }
    return { cliArgs };
}
