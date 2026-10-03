import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PloinkyBoxError } from '../errors.mjs';

// Private host-side state for update transactions: admission journals,
// pending-activation records, self-update relaunch handoffs and the folders
// of a host exclusion refresh in progress. It lives in the host-owned state
// root (`~/.ploinky-box`), never in the workspace that the Box mounts
// read-write, so in-Box processes cannot author these records.

export const UPDATE_STATE_KINDS = Object.freeze(['update-journals', 'update-pending', 'update-handoffs', 'update-recovery', 'update-exclusions']);
const KIND_SET = new Set(UPDATE_STATE_KINDS);
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;
export const UPDATE_STATE_MAX_BYTES = 256 * 1024;

function stateError(message, cause) {
    return new PloinkyBoxError(message, { code: 'PLOINKY_BOX_UPDATE_STATE_INVALID', cause });
}

function currentUid() {
    return typeof process.getuid === 'function' ? process.getuid() : null;
}

function assertKind(kind) {
    if (!KIND_SET.has(kind)) throw stateError(`Unknown update state kind: ${kind}`);
}

function assertName(name) {
    if (typeof name !== 'string' || !NAME_PATTERN.test(name) || name.includes('..')) {
        throw stateError(`Invalid update state record name: ${String(name)}`);
    }
}

function clone(value) {
    return value === null || value === undefined ? null : JSON.parse(JSON.stringify(value));
}

/**
 * Durable store rooted at the host state directory. Every record is one
 * private (0600, owner-only, single-link, non-symlink) JSON file published by
 * an exclusive temporary file, fsync and rename.
 */
export function createUpdateHostState({
    stateRoot = path.join(os.homedir(), '.ploinky-box'),
    fsApi = fs,
} = {}) {
    const root = path.resolve(stateRoot);

    function assertPrivateDirectory(target) {
        const stat = fsApi.lstatSync(target);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
            throw stateError(`Update state path is not a real directory: ${target}`);
        }
        const uid = currentUid();
        if (uid !== null && stat.uid !== uid) {
            throw stateError(`Update state directory is not owned by the current user: ${target}`);
        }
        if ((stat.mode & 0o077) !== 0) {
            throw stateError(`Update state directory must be private to the current user: ${target}`);
        }
    }

    function directoryFor(kind, { create = false } = {}) {
        assertKind(kind);
        const directory = path.join(root, kind);
        for (const target of [root, directory]) {
            try {
                assertPrivateDirectory(target);
            } catch (error) {
                if (error?.code !== 'ENOENT') throw error;
                if (!create) return null;
                try {
                    fsApi.mkdirSync(target, { mode: 0o700 });
                } catch (mkdirError) {
                    if (mkdirError?.code !== 'EEXIST') {
                        throw stateError(`Unable to create update state directory: ${target}`, mkdirError);
                    }
                }
                fsApi.chmodSync(target, 0o700);
                assertPrivateDirectory(target);
            }
        }
        return directory;
    }

    function readFile(target) {
        let descriptor;
        try {
            descriptor = fsApi.openSync(
                target,
                fsApi.constants.O_RDONLY | fsApi.constants.O_NOFOLLOW | fsApi.constants.O_NONBLOCK,
            );
        } catch (error) {
            if (error?.code === 'ENOENT') return null;
            throw stateError(`Update state record must be a readable non-symlink file: ${target}`, error);
        }
        try {
            const before = fsApi.fstatSync(descriptor);
            if (!before.isFile() || before.nlink !== 1) {
                throw stateError(`Update state record must be one non-linked regular file: ${target}`);
            }
            const uid = currentUid();
            if (uid !== null && before.uid !== uid) {
                throw stateError(`Update state record must be owned by the current user: ${target}`);
            }
            if ((before.mode & 0o077) !== 0) {
                throw stateError(`Update state record must be private to the current user: ${target}`);
            }
            if (before.size > UPDATE_STATE_MAX_BYTES) {
                throw stateError(`Update state record exceeds ${UPDATE_STATE_MAX_BYTES} bytes: ${target}`);
            }
            const bytes = fsApi.readFileSync(descriptor);
            try {
                return JSON.parse(bytes.toString('utf8'));
            } catch (error) {
                throw stateError(`Update state record is not valid JSON: ${target}`, error);
            }
        } finally {
            fsApi.closeSync(descriptor);
        }
    }

    function write(kind, name, record) {
        assertName(name);
        const directory = directoryFor(kind, { create: true });
        const body = `${JSON.stringify(record)}\n`;
        if (Buffer.byteLength(body) > UPDATE_STATE_MAX_BYTES) {
            throw stateError(`Update state record ${name} exceeds its size limit`);
        }
        const target = path.join(directory, `${name}.json`);
        const temporary = path.join(directory, `.${name}.${crypto.randomUUID()}.tmp`);
        let descriptor;
        try {
            descriptor = fsApi.openSync(
                temporary,
                fsApi.constants.O_WRONLY | fsApi.constants.O_CREAT | fsApi.constants.O_EXCL
                    | fsApi.constants.O_NOFOLLOW,
                0o600,
            );
            fsApi.writeFileSync(descriptor, body);
            fsApi.fsyncSync(descriptor);
            fsApi.closeSync(descriptor);
            descriptor = undefined;
            fsApi.renameSync(temporary, target);
        } finally {
            if (descriptor !== undefined) fsApi.closeSync(descriptor);
            try { fsApi.unlinkSync(temporary); } catch (error) {
                if (error?.code !== 'ENOENT') throw error;
            }
        }
        return target;
    }

    function read(kind, name) {
        assertName(name);
        const directory = directoryFor(kind);
        if (!directory) return null;
        return readFile(path.join(directory, `${name}.json`));
    }

    function remove(kind, name) {
        assertName(name);
        const directory = directoryFor(kind);
        if (!directory) return false;
        try {
            fsApi.unlinkSync(path.join(directory, `${name}.json`));
            return true;
        } catch (error) {
            if (error?.code === 'ENOENT') return false;
            throw stateError(`Unable to remove update state record ${name}`, error);
        }
    }

    function list(kind, prefix = '') {
        const directory = directoryFor(kind);
        if (!directory) return [];
        return fsApi.readdirSync(directory)
            .filter(entry => entry.endsWith('.json') && !entry.startsWith('.') && entry.startsWith(prefix))
            .map(entry => entry.slice(0, -'.json'.length))
            .filter(name => NAME_PATTERN.test(name))
            .sort();
    }

    /**
     * Take exclusive ownership of one record. The rename is atomic, so at most
     * one caller can claim it; a second claim (a replay) observes absence.
     */
    function claim(kind, name) {
        assertName(name);
        const directory = directoryFor(kind);
        if (!directory) return null;
        const target = path.join(directory, `${name}.json`);
        const claimed = path.join(directory, `.${name}.claimed.${crypto.randomUUID()}`);
        try {
            fsApi.renameSync(target, claimed);
        } catch (error) {
            if (error?.code === 'ENOENT') return null;
            throw stateError(`Unable to claim update state record ${name}`, error);
        }
        try {
            return readFile(claimed);
        } finally {
            try { fsApi.unlinkSync(claimed); } catch (_) {}
        }
    }

    return Object.freeze({ durable: true, root, write, read, remove, list, claim });
}

/**
 * Process-local store for supervisors built with a custom lock manager that
 * exposes no host state root (unit fixtures). Production lock managers always
 * expose `stateRoot`, which selects the durable store.
 */
export function createMemoryUpdateHostState() {
    const records = new Map();
    const key = (kind, name) => {
        assertKind(kind);
        assertName(name);
        return `${kind}/${name}`;
    };
    return Object.freeze({
        durable: false,
        root: null,
        write(kind, name, record) { records.set(key(kind, name), clone(record)); return key(kind, name); },
        read(kind, name) { return clone(records.get(key(kind, name)) ?? null); },
        remove(kind, name) { return records.delete(key(kind, name)); },
        list(kind, prefix = '') {
            assertKind(kind);
            return [...records.keys()]
                .filter(entry => entry.startsWith(`${kind}/${prefix}`))
                .map(entry => entry.slice(kind.length + 1))
                .sort();
        },
        claim(kind, name) {
            const entry = key(kind, name);
            if (!records.has(entry)) return null;
            const value = records.get(entry);
            records.delete(entry);
            return clone(value);
        },
    });
}

export function updateHostStateForLockManager(lockManager) {
    return lockManager?.stateRoot
        ? createUpdateHostState({ stateRoot: lockManager.stateRoot })
        : createMemoryUpdateHostState();
}
