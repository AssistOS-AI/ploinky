import fs from 'node:fs';
import path from 'node:path';

export const HOME_MIGRATION_PENDING = 'agent-home-migration-pending.json';
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function stat(file) {
    try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function refused(detail) {
    const error = new Error(`Agent home migration required: ${detail}. Run ploinky destroy, then the offline migrate-agent-homes script before starting again.`);
    error.code = 'PLOINKY_AGENT_HOME_MIGRATION_REQUIRED';
    return error;
}
export function assertNoPendingHomeMigration(workspaceRoot) {
    if (stat(path.join(workspaceRoot, '.ploinky', HOME_MIGRATION_PENDING))) {
        throw refused('an interrupted migration has not completed');
    }
}

// Agent-owned historical metadata, never a mount or permission grant. Only
// names below .data are accepted, and presence can only refuse a launch.
export function assertAgentHomeMigrationReady({ workspaceRoot, manifestPath, instanceName }) {
    assertNoPendingHomeMigration(workspaceRoot);
    if (!manifestPath || !path.isAbsolute(manifestPath)) return;
    const descriptor = path.join(path.dirname(manifestPath), 'home-migration.json');
    const info = stat(descriptor);
    if (!info) return;
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16384) throw refused('invalid home-migration.json');
    const data = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
    if (data.version !== 1 || !Array.isArray(data.legacyHomeKeys) || data.legacyHomeKeys.length > 32
        || !NAME.test(instanceName || '') || data.legacyHomeKeys.some(key => typeof key !== 'string'
            || !NAME.test(key) || ['shared', 'agents', 'dpu-data', 'robots'].includes(key.toLowerCase()))) {
        throw refused('invalid home migration metadata');
    }
    for (const directory of [path.join(workspaceRoot, '.data'), path.join(workspaceRoot, '.data', 'agents')]) {
        const entry = stat(directory);
        if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) throw refused('unsafe storage directory');
    }
    for (const key of data.legacyHomeKeys) {
        const candidates = [path.join(workspaceRoot, '.data', key)];
        if (key !== instanceName) candidates.push(path.join(workspaceRoot, '.data', 'agents', key));
        for (const directory of candidates) {
            const entry = stat(directory);
            if (entry && (!entry.isDirectory() || entry.isSymbolicLink() || fs.readdirSync(directory).length)) {
                throw refused(`legacy storage still exists at ${directory}`);
            }
        }
    }
}
