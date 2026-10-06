import fs from 'node:fs';

function fileStamp(stat) {
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

function deepFreeze(value) {
    const pending = [value];
    while (pending.length) {
        const entry = pending.pop();
        if (!entry || typeof entry !== 'object') continue;
        Object.freeze(entry);
        for (const child of Object.values(entry)) pending.push(child);
    }
    return value;
}

export function createValidatedJsonFileReader({ fsApi = fs, maxEntries = 16 } = {}) {
    if (!Number.isInteger(maxEntries) || maxEntries < 0) {
        throw new RangeError('maxEntries must be a non-negative integer');
    }
    const entries = new Map();
    let hits = 0;
    let misses = 0;

    function read(absPath) {
        try {
            let stat;
            try {
                stat = fsApi.statSync(absPath, { bigint: true, throwIfNoEntry: false });
            } catch (error) {
                // Older supported runtimes do not suppress ENOTDIR here.
                if (error?.code !== 'ENOTDIR') throw error;
            }
            if (!stat) {
                entries.delete(absPath);
                misses += 1;
                return { exists: false };
            }
            const entry = entries.get(absPath);
            if (stat.isFile() && entry && entry.stamp === fileStamp(stat)) {
                entries.delete(absPath);
                entries.set(absPath, entry);
                hits += 1;
                return { exists: true, ...entry, hit: true };
            }
            misses += 1;
            entries.delete(absPath);
            const fd = fsApi.openSync(absPath, 'r');
            let handleStat;
            let text;
            try {
                handleStat = fsApi.fstatSync(fd, { bigint: true });
                text = fsApi.readFileSync(fd, 'utf8');
            } finally {
                fsApi.closeSync(fd);
            }
            // The path may have been replaced between stat and open. Only the
            // opened handle identifies the inode whose bytes were read.
            const loaded = { value: deepFreeze(JSON.parse(text || '{}') || {}), stamp: fileStamp(handleStat) };
            if (handleStat.isFile() && maxEntries > 0) {
                entries.set(absPath, loaded);
                if (entries.size > maxEntries) entries.delete(entries.keys().next().value);
            }
            return { exists: true, ...loaded, hit: false };
        } catch (error) {
            entries.delete(absPath);
            if (error?.code === 'ENOENT') return { exists: false };
            throw error;
        }
    }

    return {
        read,
        invalidate(absPath) { entries.delete(absPath); },
        stats() { return { hits, misses, size: entries.size }; },
    };
}
