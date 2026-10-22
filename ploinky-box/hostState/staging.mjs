import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { PloinkyBoxError } from '../errors.mjs';
import {
    LOCK_OWNER_SCHEMA,
    LOCK_OWNER_VERSION,
    OWNER_FILE,
    serializeOwner,
} from '../lockFiles.mjs';
import { createLockLiveness } from '../lockLiveness.mjs';
import { ensureStoreDirectories } from './stores.mjs';

// Host-side staging for operations that handle workspace-derived data on behalf
// of a Box (for example a copy of a workspace Git config that is edited before
// it is published). It lives in `<workspace>/.ploinky-box/tmp/<rand>/`, which
// the Box contract masks from the Box, instead of the shared `os.tmpdir()`, and
// holds an owner record in the lock owner format (D4 v2: machine, boot, PID
// namespace, PID and process start) so a later locked transaction can classify
// a leftover directory by liveness instead of by age.
//
// TODO(step 4): nothing sweeps `tmp/` yet. The quiescence-gated locked
// transaction removes entries whose owner record classifies as stale (never by
// time); until then a directory left by a crashed host process stays in place.

export const HOST_STAGING_DIRECTORY = 'tmp';
export const HOST_STAGING_LABEL = 'host-staging';

function stagingError(message, cause) {
    return new PloinkyBoxError(message, { code: 'PLOINKY_BOX_HOST_STAGING_FAILED', cause });
}

const STATE_FILES = Object.freeze({ subject: 'Host staging', stateError: stagingError });

/**
 * Create a private staging directory for one host operation. `release()`
 * removes exactly the directory this call created, and only while it is still
 * that directory; a changed or replaced directory is left in place.
 *
 * @returns {{ root: string, release(): boolean }}
 */
export function createHostStaging(identity, {
    fsApi = fs,
    liveness = createLockLiveness(),
    now = () => new Date(),
    random = () => crypto.randomBytes(8).toString('hex'),
} = {}) {
    const parent = ensureStoreDirectories(identity, [HOST_STAGING_DIRECTORY], { fsApi, ...STATE_FILES });
    let root = null;
    for (let attempt = 0; attempt < 8 && !root; attempt += 1) {
        const candidate = path.join(parent, random());
        try {
            fsApi.mkdirSync(candidate, { mode: 0o700 });
            root = candidate;
        } catch (error) {
            if (error?.code !== 'EEXIST') throw stagingError(`Unable to create host staging directory: ${candidate}`, error);
        }
    }
    if (!root) throw stagingError(`Unable to create a unique host staging directory under ${parent}`);
    const self = liveness.selfFields();
    const ownerBytes = serializeOwner({
        schema: LOCK_OWNER_SCHEMA,
        version: LOCK_OWNER_VERSION,
        label: HOST_STAGING_LABEL,
        instance: identity.instance,
        workspaceRoot: identity.workspaceRoot,
        hostname: self.hostname,
        machineId: self.machineId,
        bootId: self.bootId,
        pidNamespace: self.pidNamespace,
        pid: self.pid,
        processStart: self.processStart,
        startedAt: now().toISOString(),
    });
    let created;
    try {
        const descriptor = fsApi.openSync(
            path.join(root, OWNER_FILE),
            fsApi.constants.O_WRONLY | fsApi.constants.O_CREAT | fsApi.constants.O_EXCL | fsApi.constants.O_NOFOLLOW,
            0o600,
        );
        try {
            fsApi.writeFileSync(descriptor, ownerBytes);
            fsApi.fsyncSync(descriptor);
        } finally {
            fsApi.closeSync(descriptor);
        }
        created = fsApi.lstatSync(root);
    } catch (error) {
        try { fsApi.rmSync(root, { recursive: true, force: true }); } catch (_) {}
        throw stagingError(`Unable to record the owner of host staging directory ${root}`, error);
    }
    let released = false;
    return Object.freeze({
        root,
        release() {
            if (released) return true;
            try {
                const current = fsApi.lstatSync(root);
                if (current.isSymbolicLink() || !current.isDirectory()
                    || current.dev !== created.dev || current.ino !== created.ino) return false;
                // Recursive removal unlinks links it meets; it never follows them.
                fsApi.rmSync(root, { recursive: true, force: true });
                released = true;
                return true;
            } catch (_) {
                return false;
            }
        },
    });
}
