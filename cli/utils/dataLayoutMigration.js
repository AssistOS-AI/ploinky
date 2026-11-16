import { isInsideBox } from '../../ploinky-box/lib/boxMarker.mjs';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
    AGENTS_DATA_SEGMENT,
    RESERVED_DATA_ENTRIES,
    translateLegacyDataPath,
} from './runtime/agentDataPathPolicy.js';

// Workspace `.data` layout versions:
//   1  flat: every agent owns `.data/<instance>` (implicit: no layout file)
//   2  every former `.data/<x>` lives in `.data/agents/<x>`; `.data/dpu-data`
//      and the reserved stores stay at the top level
//   3  robot homes/runs/credentials live in robots; .private is retired
export const DATA_LAYOUT_VERSION = 4;
// Empty is invalid for both the managed key reader and the old host fallback.
export const MASTER_KEY_TOMBSTONE = '';
export const DATA_LAYOUT_FILE = '.layout.json';
const LOCK_FILE = '.layout-migration.lock';
const LOCK_WAIT_MS = 30_000;
const LOCK_POLL_MS = 200;
const ENTRY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SLEEP_ARRAY = new Int32Array(new SharedArrayBuffer(4));

function layoutError(message, context = {}) {
    const error = new Error(`[data-layout] ${message}`);
    error.code = 'PLOINKY_DATA_LAYOUT_MIGRATION';
    error.context = context;
    return error;
}

function lstatOrNull(target) {
    try {
        return fs.lstatSync(target);
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
}

function requireRealDirectory(target, label) {
    const stat = lstatOrNull(target);
    if (!stat) return false;
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw layoutError(`${label} '${target}' must be a real directory`, { target });
    }
    return true;
}

export function readDataLayoutVersion(workspaceRoot) {
    const dataRoot = path.join(path.resolve(workspaceRoot), '.data');
    const file = path.join(dataRoot, DATA_LAYOUT_FILE);
    requireRealDirectory(dataRoot, 'workspace data directory');
    const stat = lstatOrNull(file);
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw layoutError(`unsafe layout file '${file}'`);
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (error) {
        if (error?.code === 'ENOENT') return 1;
        throw error;
    }
    const version = Number(JSON.parse(raw)?.version);
    if (!Number.isInteger(version) || version < 1) {
        throw layoutError(`invalid layout file '${file}'`, { file });
    }
    return version;
}

function writeLayoutVersion(dataRoot, version) {
    const file = path.join(dataRoot, DATA_LAYOUT_FILE);
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify({ version }, null, 2)}\n`, { mode: 0o644, flag: 'wx' });
    fs.renameSync(temporary, file);
}

// Entries of the flat layout that belong in `.data/agents`.
function legacyAgentEntries(dataRoot) {
    return fs.readdirSync(dataRoot)
        .filter(name => ENTRY_NAME.test(name) && !RESERVED_DATA_ENTRIES.includes(name))
        .sort();
}

function isDirectoryEmpty(target) {
    return fs.readdirSync(target).length === 0;
}

function migrateFlatToAgents(dataRoot, log) {
    const agentsRoot = path.join(dataRoot, AGENTS_DATA_SEGMENT);
    if (!requireRealDirectory(agentsRoot, 'agents data directory')) {
        fs.mkdirSync(agentsRoot, { mode: 0o755 });
    }
    const moved = [];
    // Each rename is atomic, so an interrupted run resumes with whatever is
    // still left at the top level.
    for (const name of legacyAgentEntries(dataRoot)) {
        const source = path.join(dataRoot, name);
        const target = path.join(agentsRoot, name);
        const existing = lstatOrNull(target);
        if (existing) {
            // A launch of an older run may have created an empty home already.
            if (existing.isDirectory() && !existing.isSymbolicLink() && isDirectoryEmpty(target)) {
                fs.rmdirSync(target);
            } else {
                throw layoutError(`cannot move '${source}': '${target}' already exists and is not empty. `
                    + 'Merge or remove one of them by hand, then run ploinky again.', { source, target });
            }
        }
        fs.renameSync(source, target);
        moved.push(name);
    }
    if (moved.length) log(`Moved ${moved.length} entr${moved.length === 1 ? 'y' : 'ies'} from .data into .data/agents: ${moved.join(', ')}`);
}

// The agent registry records absolute homes and binds (`projectPath`,
// `config.binds[].source`) under `.data/<instance>`; they follow the move.
function rewriteRegistryPaths(root, log, robotsMoved = false) {
    const registry = path.join(root, '.ploinky', 'agents.json');
    safePath(root, registry);
    const registryStat = lstatOrNull(registry);
    if (registryStat && !registryStat.isFile()) throw layoutError(`registry is not a regular file '${registry}'`);
    let raw;
    try {
        raw = fs.readFileSync(registry, 'utf8');
    } catch (error) {
        if (error?.code === 'ENOENT') return;
        throw error;
    }
    const prefixes = Array.from(new Set([root, fs.realpathSync.native(root)]))
        .map(workspace => ({ workspace, dataPrefix: `${path.join(workspace, '.data')}${path.sep}` }));
    let changed = 0;
    const translate = (value) => {
        if (typeof value === 'string') {
            const match = prefixes.find(({ dataPrefix }) => value.startsWith(dataPrefix));
            if (!match) return value;
            let translated = translateLegacyDataPath(value, { workspaceRoot: match.workspace });
            const base = path.join(match.workspace, '.data');
            const mappings = [
                ['.private/.git-credentials', 'dpu-data/git-credentials'],
                ['.private/roboWorkAgent/robots', 'robots'],
                ['.private/roboWorkAgent/credentials', 'robots/.credentials'],
                ['.private/roboWorkAgent', 'agents/roboWorkAgent'],
            ];
            for (const [from, to] of robotsMoved ? mappings : []) {
                const prefix = path.join(base, from);
                if (value === prefix || value.startsWith(prefix + path.sep)) {
                    translated = path.join(base, to) + value.slice(prefix.length);
                    break;
                }
            }
            if (robotsMoved) {
                const stub = path.join(base, 'agents', 'roboWorkAgent', 'terminal') + path.sep;
                if (value.startsWith(stub)) {
                    const [id, ...rest] = value.slice(stub.length).split(path.sep);
                    translated = path.join(base, 'robots', id, 'terminal', ...rest);
                }
                const runs = path.join(base, '.private', 'roboWorkAgent', 'runs') + path.sep;
                if (value.startsWith(runs)) {
                    const [id, ...rest] = value.slice(runs.length).split(path.sep);
                    const orphan = path.join(root, '.data', 'agents', 'roboWorkAgent', 'orphan-runs', id);
                    safePath(root, orphan);
                    let relative = lstatOrNull(orphan) ? path.join('agents', 'roboWorkAgent', 'orphan-runs', id) : null;
                    const robots = path.join(root, '.data', 'robots');
                    safePath(root, robots);
                    for (const robot of lstatOrNull(robots) ? fs.readdirSync(robots) : []) {
                        if (robot.startsWith('.')) continue;
                        const candidate = path.join(robots, robot, 'runs', id);
                        safePath(root, candidate);
                        if (lstatOrNull(candidate)) {
                            if (relative) throw layoutError(`ambiguous registry run '${id}'`);
                            relative = path.join('robots', robot, 'runs', id);
                        }
                    }
                    if (!relative) throw layoutError(`cannot resolve registry run '${id}'`);
                    translated = path.join(base, relative, ...rest);
                }
            }
            if (translated !== path.resolve(value)) changed += 1;
            return translated === path.resolve(value) ? value : translated;
        }
        if (Array.isArray(value)) return value.map(translate);
        if (value && typeof value === 'object') {
            return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, translate(entry)]));
        }
        return value;
    };
    const updated = translate(JSON.parse(raw));
    if (!changed) return;
    const temporary = `${registry}.${process.pid}.layout.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(updated, null, 2)}\n`, { mode: fs.statSync(registry).mode & 0o777, flag: 'wx' });
    fs.renameSync(temporary, registry);
    log(`Updated ${changed} agent registry path${changed === 1 ? '' : 's'} to .data/agents`);
}

function processAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error?.code === 'EPERM';
    }
}

function acquireLock(dataRoot) {
    const lockPath = path.join(dataRoot, LOCK_FILE);
    const owner = JSON.stringify({ pid: process.pid, host: os.hostname() });
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
        try {
            const fd = fs.openSync(lockPath, 'wx', 0o600);
            fs.writeSync(fd, owner);
            fs.closeSync(fd);
            return () => { try { fs.unlinkSync(lockPath); } catch (_) {} };
        } catch (error) {
            if (error?.code !== 'EEXIST') throw error;
        }
        const lockStat = lstatOrNull(lockPath);
        if (lockStat && (!lockStat.isFile() || lockStat.isSymbolicLink())) throw layoutError(`unsafe migration lock '${lockPath}'`);
        let holder = null;
        try { holder = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch (_) {}
        // Only a holder of this host (same pid namespace) can be proven dead.
        if (holder?.host === os.hostname() && Number.isInteger(holder?.pid) && !processAlive(holder.pid)) {
            try { fs.unlinkSync(lockPath); } catch (_) {}
            continue;
        }
        if (Date.now() >= deadline) {
            throw layoutError(`another process is migrating '${dataRoot}' (lock '${lockPath}'). `
                + 'If no ploinky process is running, remove the lock file and retry.', { lockPath });
        }
        Atomics.wait(SLEEP_ARRAY, 0, 0, LOCK_POLL_MS);
    }
}

/** Launch admission may initialize fresh storage; only the host lifecycle moves data. */
export function assertDataLayoutCurrent(workspaceRoot) {
    const root = path.resolve(workspaceRoot);
    const data = path.join(root, '.data');
    const version = readDataLayoutVersion(root);
    if (version === DATA_LAYOUT_VERSION) return version;
    // Unversioned fresh workspaces may initialize without moving any data.
    // An explicit old marker always requires host migration, even after a
    // partially completed migration has removed all its old source paths.
    const fresh = () => !lstatOrNull(path.join(data, DATA_LAYOUT_FILE))
        && (!lstatOrNull(data) || legacyAgentEntries(data).length === 0)
        && !lstatOrNull(path.join(root, '.ploinky', 'data', 'master-key'))
        && !lstatOrNull(path.join(data, '.private'))
        && !lstatOrNull(path.join(data, 'agents', 'roboWorkAgent', 'terminal'));
    safePath(root, path.join(data, 'agents', 'roboWorkAgent', 'terminal'));
    if (version === 1 && fresh()) {
        fs.mkdirSync(data, { recursive: true });
        const release = acquireLock(data);
        try {
            if (readDataLayoutVersion(root) === DATA_LAYOUT_VERSION) return DATA_LAYOUT_VERSION;
            if (fresh()) {
                const agents = path.join(data, AGENTS_DATA_SEGMENT);
                if (!requireRealDirectory(agents, 'agents data directory')) fs.mkdirSync(agents);
                writeLayoutVersion(data, DATA_LAYOUT_VERSION);
                return DATA_LAYOUT_VERSION;
            }
        } finally { release(); }
    }
    throw layoutError(`Workspace still uses the old layout (version ${version}) or an unsupported layout. Run ploinky destroy, then ploinky start to migrate on the host.`, { version });
}

function safePath(root, target) {
    const relative = path.relative(root, target);
    if (relative.startsWith('../') || path.isAbsolute(relative)) throw layoutError(`path escapes workspace: '${target}'`);
    let current = root;
    const parts = relative.split(path.sep);
    for (let i = 0; i < parts.length; i++) {
        current = path.join(current, parts[i]);
        const stat = lstatOrNull(current);
        if (stat && (stat.isSymbolicLink() || (i < parts.length - 1 && !stat.isDirectory()))) {
            throw layoutError(`unsafe migration path '${current}': symlink or non-directory`);
        }
    }
}

function moveEntry(root, source, target) {
    safePath(root, source);
    safePath(root, target);
    if (!lstatOrNull(source)) return;
    const existing = lstatOrNull(target);
    if (existing) {
        if (existing.isDirectory() && isDirectoryEmpty(target)) fs.rmdirSync(target);
        else throw layoutError(`cannot move '${source}': '${target}' already exists and is not empty`, { source, target });
    }
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.renameSync(source, target);
}

function migrateRobots(root, log) {
    const data = path.join(root, '.data');
    const privateRoot = path.join(data, '.private');
    const old = path.join(privateRoot, 'roboWorkAgent');
    const home = path.join(data, 'agents', 'roboWorkAgent');
    const robots = path.join(data, 'robots');
    const children = directory => {
        safePath(root, directory);
        if (!requireRealDirectory(directory, 'migration directory')) return [];
        return fs.readdirSync(directory).sort();
    };
    const drain = (source, destination) => {
        for (const name of children(source)) moveEntry(root, path.join(source, name), path.join(destination, name));
        if (lstatOrNull(source)) fs.rmdirSync(source);
    };
    // Move whole robot directories, preserving opaque home contents and inodes.
    drain(path.join(old, 'robots'), robots);
    for (const name of children(path.join(old, 'runs'))) {
        const source = path.join(old, 'runs', name);
        safePath(root, source);
        requireRealDirectory(source, 'run directory');
        const meta = path.join(source, 'meta.json');
        safePath(root, meta);
        const metaStat = lstatOrNull(meta);
        if (metaStat && !metaStat.isFile()) throw layoutError(`run metadata is not a regular file '${meta}'`);
        let id;
        try { id = JSON.parse(fs.readFileSync(meta, 'utf8')).robotId; }
        catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
        const valid = typeof id === 'string' && /^[a-z0-9][a-z0-9-]{2,63}$/.test(id);
        const robot = valid ? path.join(robots, id) : null;
        if (robot) safePath(root, robot);
        const destination = robot && requireRealDirectory(robot, 'robot directory')
            ? path.join(robot, 'runs', name) : path.join(home, 'orphan-runs', name);
        moveEntry(root, source, destination);
    }
    const runs = path.join(old, 'runs');
    if (lstatOrNull(runs)) fs.rmdirSync(runs);
    drain(path.join(old, 'credentials'), path.join(robots, '.credentials'));
    // Service state may merge only by disjoint immediate names.
    drain(old, home);
    for (const id of children(path.join(home, 'terminal'))) {
        if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(id)) throw layoutError(`invalid terminal robot id '${id}'`);
        moveEntry(root, path.join(home, 'terminal', id), path.join(robots, id, 'terminal'));
    }
    if (lstatOrNull(path.join(home, 'terminal'))) fs.rmdirSync(path.join(home, 'terminal'));
    moveEntry(root, path.join(privateRoot, '.git-credentials'), path.join(data, 'dpu-data', 'git-credentials'));
    const descriptors = path.join(home, 'server-state', 'terminal');
    for (const name of children(descriptors)) {
        const file = path.join(descriptors, name);
        safePath(root, file);
        const stat = fs.lstatSync(file);
        if (name.endsWith('.json') && stat.isFile()) fs.unlinkSync(file);
        else if ((/^launch-[A-Za-z0-9]+$/.test(name) && stat.isDirectory())
            || (/^\.[a-f0-9-]{36}$/.test(name) && stat.isFile())) {
            // Destroy can interrupt a terminal before its finally block runs.
            // Keep its temporary artifacts out of the active descriptor store.
            moveEntry(root, file, path.join(home, 'server-state', 'terminal-layout-v2', name));
        } else throw layoutError(`unexpected terminal descriptor '${file}'`);
    }
    const residual = children(privateRoot);
    if (residual.length) throw layoutError(`unmigrated .data/.private entries: ${residual.join(', ')}`);
    if (lstatOrNull(privateRoot)) fs.rmdirSync(privateRoot);
    log('Moved robot and service data to layout 3');
}

function migrateMasterKey(root) {
    const source = path.join(root, '.ploinky', 'data', 'master-key');
    const target = path.join(root, '.data', 'dpu-data', 'master-key');
    const read = file => {
        safePath(root, file);
        const stat = lstatOrNull(file);
        if (!stat) return null;
        if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())) {
            throw layoutError(`unsafe master key '${file}'`);
        }
        const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try { return fs.readFileSync(fd); } finally { fs.closeSync(fd); }
    };
    const valid = bytes => bytes && /^[a-f0-9]{64}\n$/.test(bytes.toString('utf8'));
    const before = read(source);
    const existing = read(target);
    if (!before) {
        if (existing && !valid(existing)) throw layoutError('invalid destination master key');
        return;
    }
    if (before.toString('utf8') === MASTER_KEY_TOMBSTONE) {
        if (!valid(existing)) throw layoutError('master key migration marker exists without a valid destination');
        return;
    }
    if (!valid(before)) throw layoutError('invalid legacy master key; refusing to replace it');
    if (existing && !before.equals(existing)) throw layoutError('conflicting master keys; neither file was replaced');
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const syncDirectory = directory => {
        const fd = fs.openSync(directory, 'r');
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    };
    const persist = (file, bytes) => {
        const temporary = `${file}.${process.pid}.migration`;
        safePath(root, temporary);
        // A previous interrupted copy has no authority over the original.
        if (lstatOrNull(temporary)) fs.unlinkSync(temporary);
        const fd = fs.openSync(temporary, 'wx', 0o600);
        try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        if (!read(temporary).equals(Buffer.from(bytes))) throw layoutError('master key copy verification failed');
        fs.renameSync(temporary, file);
        syncDirectory(path.dirname(file));
    };
    if (!existing) persist(target, before);
    fs.chmodSync(target, 0o600);
    if (!read(target).equals(before)) throw layoutError('master key verification failed');
    persist(source, MASTER_KEY_TOMBSTONE);
}

/** Host caller supplies admission under its workspace lock, before any write. */
export function ensureDataLayout(workspaceRoot, {
    log = (message) => console.error(`[data-layout] ${message}`),
    assertMigrationAllowed,
} = {}) {
    const root = path.resolve(String(workspaceRoot || ''));
    const dataRoot = path.join(root, '.data');
    let version = readDataLayoutVersion(root);
    if (version > DATA_LAYOUT_VERSION) throw layoutError(`layout ${version} is newer than this ploinky supports`);
    if (version === DATA_LAYOUT_VERSION) return version;
    if (isInsideBox()) throw layoutError('Migration cannot run inside a Box; run ploinky destroy then ploinky start on the host');
    if (typeof assertMigrationAllowed !== 'function') throw layoutError('Migration requires host workspace lock and runtime quiescence after ploinky destroy');
    assertMigrationAllowed();
    if (!requireRealDirectory(dataRoot, 'workspace data directory')) fs.mkdirSync(dataRoot, { recursive: true });
    const release = acquireLock(dataRoot);
    try {
        version = readDataLayoutVersion(root);
        if (version < 2) {
            migrateFlatToAgents(dataRoot, log);
            rewriteRegistryPaths(root, log);
            writeLayoutVersion(dataRoot, 2);
            version = 2;
        }
        if (version < 3) {
            migrateRobots(root, log);
            rewriteRegistryPaths(root, log, true);
            writeLayoutVersion(dataRoot, 3);
        }
        if (version < 4) {
            const oldMonitor = path.join(root, '.data', 'agents', 'workspace-monitor');
            const monitorHome = path.join(root, '.data', 'agents', 'workspaceMonitorAgent');
            safePath(root, oldMonitor);
            if (requireRealDirectory(oldMonitor, 'workspace monitor storage')) {
                for (const name of fs.readdirSync(oldMonitor)) moveEntry(root, path.join(oldMonitor, name), path.join(monitorHome, name));
                fs.rmdirSync(oldMonitor);
            }
            migrateMasterKey(root);
            writeLayoutVersion(dataRoot, 4);
        }
        return DATA_LAYOUT_VERSION;
    } finally { release(); }
}
