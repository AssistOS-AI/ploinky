const MAX_SUGGESTION_CACHE_ENTRIES = 16;

function sanitizeBrowserToken(token) {
    const raw = String(token || '').trim();
    if (!raw) return { folder: '', leaf: '' };
    if (raw.includes('\0')) return null;
    const normalized = raw.replace(/\\+/g, '/');
    if (normalized.startsWith('/')) return null;
    if (normalized.split('/').some((segment) => segment === '..')) return null;
    const lastSlash = normalized.lastIndexOf('/');
    if (lastSlash === -1) return { folder: '', leaf: normalized };
    return {
        folder: normalized.slice(0, lastSlash),
        leaf: normalized.slice(lastSlash + 1)
    };
}

function tokenRangeForTrigger(value, triggerInfo, triggerChar) {
    const inputValue = typeof value === 'string' ? value : '';
    const fallbackIdx = inputValue.lastIndexOf(triggerChar);
    const triggerIdx = Number.isInteger(triggerInfo?.triggerIndex)
        ? triggerInfo.triggerIndex
        : fallbackIdx;
    if (triggerIdx < 0 || inputValue.charAt(triggerIdx) !== triggerChar) {
        return null;
    }
    const afterTrigger = inputValue.slice(triggerIdx + 1);
    const stopMatch = afterTrigger.match(/\s/);
    const tokenEnd = stopMatch
        ? triggerIdx + 1 + stopMatch.index
        : triggerIdx + 1 + afterTrigger.length;
    return { triggerIdx, tokenEnd };
}

export function applyWorkspacePathSelectionToValue(value, relativePath, type, triggerInfo = null) {
    const inputValue = typeof value === 'string' ? value : '';
    const range = tokenRangeForTrigger(inputValue, triggerInfo, '@');
    if (!range) return null;
    const insertText = type === 'folder' ? `@${relativePath}/` : `@${relativePath} `;
    const tailStart = insertText.endsWith(' ') && /\s/.test(inputValue.charAt(range.tokenEnd))
        ? range.tokenEnd + 1
        : range.tokenEnd;
    const next = inputValue.slice(0, range.triggerIdx) + insertText + inputValue.slice(tailStart);
    return {
        value: next,
        cursor: range.triggerIdx + insertText.length
    };
}

function suggestionRecord(item, { state, dlog }) {
    const kind = item.kind === 'folder' ? 'folder' : 'file';
    const relativePath = String(item.path || '').replace(/^\/+/, '');
    const label = String(item.label || relativePath);
    const displayPath = String(item.displayPath || relativePath || label).replace(/^\/+/, '');
    const description = kind === 'folder' ? 'Folder' : 'File';
    const token = `@${relativePath}`;
    return {
        label: kind === 'folder'
            ? `${displayPath.replace(/\/+$/, '')}/`
            : (displayPath || label),
        description,
        group: 'Files and folders',
        keepMenuOpen: kind === 'folder',
        applySelection: (current, triggerInfo) => applyWorkspacePathSelectionToValue(current, relativePath, kind, triggerInfo),
        onSelected: () => {
            if (kind === 'file' && state && typeof state.add === 'function') {
                try {
                    state.add({
                        kind: 'workspace-path',
                        path: relativePath,
                        type: 'file',
                        label
                    }, { token });
                } catch (err) {
                    dlog?.('WorkspacePathsProvider: failed to record reference', err?.message || err);
                }
            }
        }
    };
}

export function createWorkspacePathsProvider({ basePath, toEndpoint, state, dlog } = {}) {
    const endpointBase = String(basePath || '').replace(/\/+$/, '') || '';
    const buildEndpoint = typeof toEndpoint === 'function'
        ? toEndpoint
        : (suffix) => endpointBase
            ? `${endpointBase}/${String(suffix || '').replace(/^\/+/, '')}`
            : `/webchat/${String(suffix || '').replace(/^\/+/, '')}`;
    const itemsByKey = new Map();
    const requestsByKey = new Map();

    function cacheItems(key, items) {
        if (itemsByKey.has(key)) itemsByKey.delete(key);
        itemsByKey.set(key, items);
        while (itemsByKey.size > MAX_SUGGESTION_CACHE_ENTRIES) {
            const oldestKey = itemsByKey.keys().next().value;
            if (oldestKey === undefined) break;
            itemsByKey.delete(oldestKey);
        }
    }

    function fetchSuggestions(folder, leaf) {
        const key = `${folder}::${leaf}`;
        if (itemsByKey.has(key)) return Promise.resolve(itemsByKey.get(key));
        if (requestsByKey.has(key)) return requestsByKey.get(key);

        const request = (async () => {
            const params = new URLSearchParams();
            params.set('query', folder ? `${folder}/${leaf || ''}` : (leaf || ''));
            const url = buildEndpoint(`suggestions/files?${params.toString()}`);
            try {
                const res = await fetch(url, { credentials: 'include' });
                if (!res.ok) return [];
                const body = await res.json().catch(() => null);
                const items = Array.isArray(body?.items) ? body.items : [];
                cacheItems(key, items);
                return items;
            } catch (err) {
                dlog?.('WorkspacePathsProvider: suggestion fetch failed', err?.message || err);
                return [];
            }
        })();
        requestsByKey.set(key, request);
        return request.finally(() => {
            if (requestsByKey.get(key) === request) requestsByKey.delete(key);
        });
    }

    function tokenFromTrigger(triggerInfo) {
        const token = String(triggerInfo?.token || '');
        if (!token) return { folder: '', leaf: '' };
        return sanitizeBrowserToken(token);
    }

    function getSuggestions(value, caret, triggerInfo) {
        if (triggerInfo?.trigger !== '@') return [];
        const parsed = tokenFromTrigger(triggerInfo);
        if (parsed === null) return [];
        const key = `${parsed.folder}::${parsed.leaf}`;
        const cachedItems = itemsByKey.get(key);
        if (!cachedItems) return [];
        const leafLower = parsed.leaf ? parsed.leaf.toLowerCase() : '';
        const matches = cachedItems.filter((item) => {
            const label = String(item?.label || '');
            const displayPath = String(item?.displayPath || item?.path || '');
            if (!leafLower) return true;
            return label.toLowerCase().includes(leafLower)
                || displayPath.toLowerCase().includes(leafLower);
        });
        return matches.map((item) => suggestionRecord(item, { state, dlog }));
    }

    function requestSuggestions(value, triggerInfo) {
        const parsed = tokenFromTrigger(triggerInfo);
        if (parsed === null) return Promise.resolve([]);
        return fetchSuggestions(parsed.folder, parsed.leaf);
    }

    return {
        trigger: '@',
        groupLabel: 'Files and folders',
        getSuggestions,
        requestSuggestions
    };
}
