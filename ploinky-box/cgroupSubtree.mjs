import fs from 'node:fs';
import path from 'node:path';

// Trigger only; exact manifest admission grants runtime authority.
export function declaredCgroupSubtreeAgents(workspaceRoot, { fsApi = fs, maxEntries = 256,
    maxBytes = 1024 * 1024 } = {}) {
    if (!path.isAbsolute(String(workspaceRoot || ''))) return Object.freeze([]);
    const limit = Math.min(256, Math.max(1, Number(maxEntries) || 256));
    const names = (directory) => {
        try {
            return fsApi.readdirSync(directory, { withFileTypes: true }).filter((entry) => (
                (entry.isDirectory() || entry.isSymbolicLink()) && /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(entry.name)
                && entry.name !== 'node_modules'
            )).map((entry) => entry.name).sort().slice(0, limit);
        } catch { return []; }
    };
    const found = new Set();
    let inspected = 0, bytesRead = 0;
    for (const root of [path.join(workspaceRoot, '.ploinky/repos'), workspaceRoot]) {
        for (const repo of names(root)) for (const agent of names(path.join(root, repo))) {
            if (++inspected > 4096 || bytesRead > 8 * 1024 * 1024) return Object.freeze([...found].sort().slice(0, 256));
            let fd;
            try {
                fd = fsApi.openSync(path.join(root, repo, agent, 'manifest.json'),
                    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
                const stat = fsApi.fstatSync(fd);
                if (!stat.isFile() || stat.size > Math.min(maxBytes, 1024 * 1024)) continue;
                bytesRead += stat.size;
                if (bytesRead > 8 * 1024 * 1024) continue;
                const manifest = JSON.parse(fsApi.readFileSync(fd, 'utf8'));
                if (manifest?.containerSecurity?.nestedPodman === true && manifest.containerSecurity.cgroupSubtree === true) {
                    found.add(`${repo}/${agent}`);
                }
            } catch { /* Unreadable declarations grant nothing. */ }
            finally { if (fd !== undefined) fsApi.closeSync(fd); }
        }
    }
    return Object.freeze([...found].sort().slice(0, 256));
}
