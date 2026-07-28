function normalizeFilePath(value) {
    if (typeof value !== 'string' || !value || /[\0\r\n]/.test(value)) return null;
    const normalized = value.replace(/\\+/g, '/').replace(/^\/+|\/+$/g, '');
    if (!normalized) return null;
    const segments = normalized.split('/');
    if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
    return normalized;
}

export function createWorkspaceFileIndex() {
    let indexVersion = 0;
    let ready = false;
    let files = new Set();
    const listeners = new Set();

    function notify() {
        for (const listener of listeners) {
            try { listener(); } catch (_) { /* ignore listener failures */ }
        }
    }

    function applyUpdate(payload) {
        const nextVersion = Number(payload?.indexVersion);
        if (!Number.isSafeInteger(nextVersion) || nextVersion < 1) return false;
        if (payload?.reset === true) {
            if (!Array.isArray(payload.files)) return false;
            const nextFiles = new Set();
            for (const value of payload.files) {
                const filePath = normalizeFilePath(value);
                if (!filePath) return false;
                nextFiles.add(filePath);
            }
            files = nextFiles;
        } else {
            if (ready && nextVersion <= indexVersion) return false;
            if (!ready || payload?.reset !== false
                || !Array.isArray(payload.added) || !Array.isArray(payload.removed)) {
                return false;
            }
            const removed = payload.removed.map(normalizeFilePath);
            const added = payload.added.map(normalizeFilePath);
            if (removed.some((filePath) => !filePath) || added.some((filePath) => !filePath)) return false;
            for (const filePath of removed) files.delete(filePath);
            for (const filePath of added) files.add(filePath);
        }
        indexVersion = nextVersion;
        ready = true;
        notify();
        return true;
    }

    return {
        applyUpdate,
        has(filePath) {
            const normalized = normalizeFilePath(filePath);
            return ready && Boolean(normalized) && files.has(normalized);
        },
        isReady: () => ready,
        snapshot: () => ({ indexVersion, ready, files: [...files].sort() }),
        subscribe(listener) {
            if (typeof listener !== 'function') return () => {};
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
}

export const __testables = { normalizeFilePath };
