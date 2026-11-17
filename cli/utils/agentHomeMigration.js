import crypto from 'node:crypto';
import { HOME_MIGRATION_PENDING } from './runtime/agentHomeMigrationPolicy.js';
import { validateSqliteHomeRules, inspectSqliteHomePaths, applySqliteHomePaths } from './sqliteHomePathMigration.js';
import fs from 'node:fs';
import path from 'node:path';
import { assertDataLayoutCurrent } from './dataLayoutMigration.js';
import { isInsideBox } from '../../ploinky-box/lib/boxMarker.mjs';

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function name(value) {
    if (typeof value !== 'string' || !NAME.test(value) || value.toLowerCase() === 'shared') {
        throw new Error(`Invalid agent home migration name: ${value}`);
    }
    return value;
}
function stat(file) {
    try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function safe(root, file) {
    const relative = path.relative(root, file);
    if (relative.startsWith('../') || path.isAbsolute(relative)) throw new Error('Migration path escapes workspace');
    let current = root;
    for (const part of ['', ...relative.split(path.sep)]) {
        if (part) current = path.join(current, part);
        const info = stat(current);
        if (info?.isSymbolicLink()) throw new Error(`Migration refuses symbolic link: ${current}`);
        if (info && current !== file && !info.isDirectory()) throw new Error(`Not a migration directory: ${current}`);
    }
}
function readRegistry(root) {
    const file = path.join(root, '.ploinky', 'agents.json');
    safe(root, file);
    if (!stat(file)) return [];
    const info = stat(file);
    if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new Error('Invalid agent registry');
    const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!registry || Array.isArray(registry) || typeof registry !== 'object') throw new Error('Invalid agent registry');
    return Object.values(registry).filter(record => record?.type === 'agent');
}

// The plan is supplied by the operator, not by an agent manifest. The caller
// holds the host workspace lock and proves that every runtime is absent.
export function migrateAgentHomes(workspaceRoot, plan, { assertMigrationAllowed } = {}) {
    if (isInsideBox()) throw new Error('Agent home migration must run on the host after ploinky destroy');
    if (typeof assertMigrationAllowed !== 'function') throw new Error('Agent home migration requires offline admission');
    assertMigrationAllowed();
    const root = path.resolve(workspaceRoot);
    assertDataLayoutCurrent(root);
    if (!Array.isArray(plan) || plan.length > 256) throw new Error('Expected a bounded agent home migration plan');
    const pending = path.join(root, '.ploinky', HOME_MIGRATION_PENDING);
    safe(root, pending);
    const planHash = crypto.createHash('sha256').update(JSON.stringify(plan)).digest('hex');
    if (stat(pending)) {
        if (!stat(pending).isFile() || stat(pending).size > 1024
            || JSON.parse(fs.readFileSync(pending, 'utf8')).planHash !== planHash) {
            throw new Error('Resume the interrupted home migration with the same plan');
        }
    }
    const records = readRegistry(root);
    const base = path.join(root, '.data', 'agents');
    safe(root, base);
    const mappings = plan.map(entry => {
        const repo = name(entry.repoName), agent = name(entry.agentName), source = name(entry.sourceKey);
        const matching = records.filter(record => record.repoName === repo && record.agentName === agent);
        const targets = [...new Set(matching.map(record => name(record.alias || record.agentName)))];
        if (targets.length > 1) throw new Error(`Shared old home ${source} has multiple instances; split its data explicitly before migration`);
        const target = targets[0] || agent;
        if (records.some(record => (record.alias || record.agentName) === target
            && (record.repoName !== repo || record.agentName !== agent))) {
            throw new Error(`Home ${target} belongs to another agent`);
        }
        return { source, target, sqliteJsonPaths: validateSqliteHomeRules(entry.sqliteJsonPaths) };
    });
    for (let i = 0; i < mappings.length; i++) {
        for (let j = i + 1; j < mappings.length; j++) {
            const a = mappings[i], b = mappings[j];
            if ([b.source, b.target].includes(a.source) || [b.source, b.target].includes(a.target)) {
                throw new Error('Overlapping agent home migration entries');
            }
        }
    }
    const moves = [], directories = [], results = [];
    function validateTree(file) {
        safe(root, file);
        const info = stat(file);
        if (info.isDirectory()) for (const child of fs.readdirSync(file)) validateTree(path.join(file, child));
        else if (!info.isFile()) throw new Error(`Unsupported migration entry: ${file}`);
    }
    function collect(source, target) {
        safe(root, source); safe(root, target);
        const from = stat(source), to = stat(target);
        if (!to) { validateTree(source); moves.push([source, target]); return; }
        if (!from.isDirectory() || !to.isDirectory()) throw new Error(`Agent home migration conflict: ${target}`);
        for (const child of fs.readdirSync(source).sort()) collect(path.join(source, child), path.join(target, child));
        directories.push(source);
    }
    for (const mapping of mappings) {
        const source = path.join(base, mapping.source), target = path.join(base, mapping.target);
        safe(root, source); safe(root, target);
        if (mapping.source === mapping.target || !stat(source)) {
            results.push({ ...mapping, action: 'unchanged' });
            continue;
        }
        if (!stat(source).isDirectory()) throw new Error(`Not an agent home directory: ${source}`);
        collect(source, target);
        results.push({ ...mapping, action: 'migrated' });
    }
    const databaseUpdates = [];
    for (const mapping of mappings) {
        for (const rule of mapping.sqliteJsonPaths) {
            const sourceFile = path.join(base, mapping.source, rule.file);
            const targetFile = path.join(base, mapping.target, rule.file);
            const file = stat(sourceFile) ? sourceFile : targetFile;
            safe(root, file);
            if (!stat(file)) continue; // A genuinely new deployment has no database to migrate.
            if (!stat(file).isFile() || stat(file).nlink !== 1) throw new Error('SQLite home migration requires a regular database without hard links');
            for (const suffix of ['-wal', '-shm', '-journal']) {
                safe(root, file + suffix);
                const sidecar = stat(file + suffix);
                if (sidecar && (!sidecar.isFile() || sidecar.nlink !== 1)) throw new Error('Unsafe SQLite sidecar');
            }
            const prefixes = ['/data/', `${root}/.data/${mapping.source}/`, `${root}/.data/agents/${mapping.source}/`];
            const changes = inspectSqliteHomePaths(file, rule, prefixes);
            databaseUpdates.push({ targetFile, rule, changes });
            if (changes.length) {
                const result = results.find(result => result.target === mapping.target);
                result.rewrittenRows = (result.rewrittenRows || 0) + changes.length;
            }
        }
    }
    // Preflight every entry before the first rename. A retry after interruption
    // continues with the entries left in the source; existing files never win.
    assertMigrationAllowed();
    const sync = directory => {
        const fd = fs.openSync(directory, 'r');
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    };
    if (!moves.length && !directories.length && !databaseUpdates.some(update => update.changes.length) && !stat(pending)) return results;
    if (!stat(pending)) {
        fs.mkdirSync(path.dirname(pending), { recursive: true });
        const fd = fs.openSync(pending, 'wx', 0o600);
        try { fs.writeFileSync(fd, JSON.stringify({ planHash }) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        sync(path.dirname(pending));
    }
    for (const [source, target] of moves) {
        safe(root, source); safe(root, target);
        if (stat(target)) throw new Error(`Agent home migration conflict: ${target}`);
        fs.renameSync(source, target);
        sync(path.dirname(target));
        if (path.dirname(source) !== path.dirname(target)) sync(path.dirname(source));
    }
    for (const directory of directories) { fs.rmdirSync(directory); sync(path.dirname(directory)); }
    for (const { targetFile, rule, changes } of databaseUpdates) {
        safe(root, targetFile);
        if (!stat(targetFile)?.isFile() || stat(targetFile).nlink !== 1) throw new Error('SQLite migration destination disappeared or became unsafe');
        applySqliteHomePaths(targetFile, rule, changes);
    }
    fs.unlinkSync(pending);
    sync(path.dirname(pending));
    return results;
}
