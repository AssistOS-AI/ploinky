// In-memory cgroup v2 hierarchy for the offline preparation and delegation
// tests. It models only what the production code touches: cgroup.procs moves,
// per-directory controllers/subtree_control with the no-internal-process rule,
// ownership and permission bits of directories and delegation files,
// /proc/*/cgroup placement and the mountinfo line for the cgroup root. Every
// mutation is logged. Groups default to mode 0755 and files to 0644, with the
// group id equal to the owner; tests may set `mode`, `gid`, `fileModes` and
// `fileGids` to model a host that delegated them differently.

import path from 'node:path';

export const SELF_PID = 4242;
const DELEGATION_FILES = ['cgroup.procs', 'cgroup.subtree_control', 'cgroup.threads'];

function errno(code, message = code) {
    const error = new Error(`${code}: ${message}`);
    error.code = code;
    return error;
}

export function mountinfoLine({ fstype = 'cgroup2', mountRw = true, superRw = true, nsdelegate = true, mountPoint = '/sys/fs/cgroup' } = {}) {
    const superOptions = [superRw ? 'rw' : 'ro', ...(nsdelegate ? ['nsdelegate'] : []), 'memory_recursiveprot'].join(',');
    return [
        `25 1 0:23 / / rw,relatime - overlay overlay rw`,
        `36 25 0:31 / ${mountPoint} ${mountRw ? 'rw' : 'ro'},nosuid,nodev,noexec,relatime shared:9 - ${fstype} ${fstype} ${superOptions}`,
        '',
    ].join('\n');
}

export class FakeCgroupFs {
    constructor({
        cgroupRoot = '/sys/fs/cgroup',
        procRoot = '/proc',
        controllers = ['cpu', 'io', 'memory', 'pids'],
        rootPids = [1, SELF_PID, 77],
        mount = {},
    } = {}) {
        this.cgroupRoot = cgroupRoot;
        this.procRoot = procRoot;
        this.mountinfo = mountinfoLine({ ...mount, mountPoint: cgroupRoot });
        this.groups = new Map();
        this.pidGroup = new Map();
        this.writes = [];
        this.chowns = [];
        this.mkdirs = [];
        this.hooks = {};
        this.actorUid = 0;
        this.selfPid = SELF_PID;
        this.addGroup('/', { uid: 0, available: controllers });
        for (const pid of rootPids) this.placePid(pid, '/');
    }

    addGroup(rel, { uid = this.actorUid, available = null } = {}) {
        const parent = rel === '/' ? null : this.groups.get(path.posix.dirname(rel));
        if (rel !== '/' && !parent) throw errno('ENOENT', rel);
        const group = {
            uid,
            gid: null,
            mode: 0o755,
            fileUids: Object.fromEntries(DELEGATION_FILES.map((name) => [name, uid])),
            fileGids: {},
            fileModes: {},
            available: new Set(available ?? (parent ? [...parent.subtree] : [])),
            subtree: new Set(),
            procs: new Set(),
            values: new Map(),
        };
        this.groups.set(rel, group);
        return group;
    }

    placePid(pid, rel) {
        for (const group of this.groups.values()) group.procs.delete(pid);
        this.groups.get(rel).procs.add(pid);
        this.pidGroup.set(pid, rel);
    }

    snapshot() {
        return JSON.stringify([...this.groups.entries()].map(([rel, group]) => [rel, {
            uid: group.uid, gid: group.gid, mode: group.mode, fileUids: group.fileUids, fileGids: group.fileGids,
            fileModes: group.fileModes, available: [...group.available].sort(),
            subtree: [...group.subtree].sort(), procs: [...group.procs].sort(), values: [...group.values.entries()],
        }]));
    }

    resolve(target) {
        const value = String(target);
        if (value === this.cgroupRoot) return { rel: '/', file: null };
        if (!value.startsWith(`${this.cgroupRoot}/`)) return null;
        const parts = value.slice(this.cgroupRoot.length).split('/').filter(Boolean);
        const asGroup = `/${parts.join('/')}`;
        if (this.groups.has(asGroup)) return { rel: asGroup, file: null };
        const file = parts.pop();
        return { rel: parts.length ? `/${parts.join('/')}` : '/', file };
    }

    procFile(target) {
        const rest = String(target).slice(this.procRoot.length + 1);
        if (rest === 'self/mountinfo') return this.mountinfo;
        const match = /^(self|\d+)\/cgroup$/.exec(rest);
        if (!match) throw errno('ENOENT', target);
        const pid = match[1] === 'self' ? this.selfPid : Number(match[1]);
        const rel = this.pidGroup.get(pid);
        if (!rel) throw errno('ENOENT', target);
        return `0::${rel}\n`;
    }

    readFileSync(target) {
        if (String(target).startsWith(`${this.procRoot}/`)) return this.procFile(target);
        const located = this.resolve(target);
        const group = located && this.groups.get(located.rel);
        if (!group || !located.file) throw errno(located?.file ? 'ENOENT' : 'EISDIR', target);
        this.hooks.beforeRead?.(located.rel, located.file, this);
        switch (located.file) {
        case 'cgroup.procs': return `${[...group.procs].join('\n')}${group.procs.size ? '\n' : ''}`;
        case 'cgroup.controllers': return `${[...group.available].join(' ')}\n`;
        case 'cgroup.subtree_control': return `${[...group.subtree].join(' ')}\n`;
        case 'cgroup.threads': return '';
        default:
            if (!group.values.has(located.file)) throw errno('ENOENT', target);
            return `${group.values.get(located.file)}\n`;
        }
    }

    writeFileSync(target, data) {
        const located = this.resolve(target);
        const group = located && this.groups.get(located.rel);
        if (!group || !located.file) throw errno('ENOENT', target);
        this.writes.push({ path: String(target), data: String(data) });
        const injected = this.hooks.beforeWrite?.(located.rel, located.file, String(data), this);
        if (injected) throw injected;
        if (located.file === 'cgroup.procs') {
            const pid = Number(String(data).trim());
            if (!this.pidGroup.has(pid)) throw errno('ESRCH', String(pid));
            this.placePid(pid, located.rel);
            return;
        }
        if (located.file === 'cgroup.subtree_control') {
            for (const token of String(data).trim().split(/\s+/)) {
                const controller = token.slice(1);
                if (!group.available.has(controller)) throw errno('ENOENT', controller);
                if (located.rel !== '/' && group.procs.size) throw errno('EBUSY', located.rel);
                if (token.startsWith('+')) {
                    if (this.hooks.ignoreEnable?.(located.rel, controller)) continue;
                    group.subtree.add(controller);
                    for (const [rel, child] of this.groups) {
                        if (rel !== '/' && path.posix.dirname(rel) === located.rel) child.available.add(controller);
                    }
                } else {
                    group.subtree.delete(controller);
                }
            }
            return;
        }
        group.values.set(located.file, String(data));
    }

    mkdirSync(target) {
        const located = this.resolve(target);
        if (!located) throw errno('EACCES', target);
        if (!located.file && this.groups.has(located.rel)) throw errno('EEXIST', target);
        const rel = located.file ? `${located.rel === '/' ? '' : located.rel}/${located.file}` : located.rel;
        const injected = this.hooks.beforeMkdir?.(rel, this);
        if (injected) throw injected;
        this.mkdirs.push({ path: String(target), uid: this.actorUid });
        this.addGroup(rel, { uid: this.actorUid });
    }

    rmdirSync(target) {
        const located = this.resolve(target);
        if (!located || located.file || !this.groups.has(located.rel)) throw errno('ENOENT', target);
        if (this.groups.get(located.rel).procs.size) throw errno('EBUSY', target);
        this.groups.delete(located.rel);
    }

    readdirSync(target) {
        const located = this.resolve(target);
        if (!located || located.file || !this.groups.has(located.rel)) throw errno('ENOENT', target);
        const prefix = located.rel === '/' ? '/' : `${located.rel}/`;
        return [...this.groups.keys()]
            .filter((rel) => rel !== located.rel && rel.startsWith(prefix) && !rel.slice(prefix.length).includes('/'))
            .map((rel) => rel.slice(prefix.length));
    }

    lstatSync(target) {
        const located = this.resolve(target);
        if (!located) throw errno('ENOENT', target);
        const group = this.groups.get(located.rel);
        if (!group) throw errno('ENOENT', target);
        if (!located.file) {
            return {
                uid: group.uid, gid: group.gid ?? group.uid, mode: 0o40000 | group.mode,
                isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false,
            };
        }
        const known = Object.hasOwn(group.fileUids, located.file) || located.file === 'cgroup.controllers' || group.values.has(located.file);
        if (!known) throw errno('ENOENT', target);
        const uid = Object.hasOwn(group.fileUids, located.file) ? group.fileUids[located.file] : group.uid;
        const gid = Object.hasOwn(group.fileGids, located.file) ? group.fileGids[located.file] : uid;
        const mode = Object.hasOwn(group.fileModes, located.file) ? group.fileModes[located.file] : 0o644;
        return { uid, gid, mode: 0o100000 | mode, isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false };
    }

    chownSync(target, uid) {
        const located = this.resolve(target);
        const group = located && this.groups.get(located.rel);
        if (!group) throw errno('ENOENT', target);
        this.chowns.push(String(target));
        const injected = this.hooks.beforeChown?.(String(target), this);
        if (injected) throw injected;
        if (located.file) group.fileUids[located.file] = uid;
        else group.uid = uid;
    }
}

/**
 * A completed root preparation: Box tasks in /ploinky/core, the given
 * controllers enabled at the root and /ploinky, /ploinky delegated to 1000,
 * and the caller (the core) in /ploinky/core.
 */
export function preparedCgroupFs({ controllers = ['cpu', 'memory', 'pids'], available = ['cpu', 'io', 'memory', 'pids'] } = {}) {
    const fake = new FakeCgroupFs({ controllers: available });
    fake.addGroup('/ploinky', { uid: 0 });
    fake.addGroup('/ploinky/core', { uid: 0 });
    for (const pid of [...fake.groups.get('/').procs]) fake.placePid(pid, '/ploinky/core');
    for (const controller of controllers) {
        fake.groups.get('/').subtree.add(controller);
        fake.groups.get('/ploinky').available.add(controller);
        fake.groups.get('/ploinky').subtree.add(controller);
        fake.groups.get('/ploinky/core').available.add(controller);
    }
    const ploinky = fake.groups.get('/ploinky');
    ploinky.uid = 1000;
    for (const name of DELEGATION_FILES) ploinky.fileUids[name] = 1000;
    fake.actorUid = 1000;
    return fake;
}
