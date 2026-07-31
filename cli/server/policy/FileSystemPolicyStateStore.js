import fs from 'node:fs';
import path from 'node:path';
import { PLOINKY_WORKSPACE_ROOT } from '../../utils/config.js';
import {
    captureEdgeRoutingCandidateGeneration,
    inactivateEdgeRoutingGeneration,
    withEdgeGenerationApplyLock,
} from '../../sandbox/edgeGeneration.js';
import { applyEdgeRoutingGeneration } from '../../sandbox/coordinatedEdgeApply.js';
import {
    createWorkspaceMutationLease,
    releaseWorkspaceMutationLease,
} from '../../utils/runtime/maintenanceLocks.js';

import { PolicyStateStore } from './PolicyStateStore.js';

/**
 * FileSystemPolicyStateStore — the default `PolicyStateStore` adapter (DS014).
 * Persists the policy document as `policy-state.json` under the workspace
 * `.ploinky/data/router-security/`. Version token is `mtimeMs:size` (a cheap
 * `statSync`); writes are durable and atomic (fsynced temp → rename → directory fsync).
 * `read()` throws on a missing file or undecodable JSON so the repository fails
 * closed. Holds all `node:fs`/`node:path` usage for the state document.
 */
function defaultFile() {
    return path.join(
        PLOINKY_WORKSPACE_ROOT,
        '.ploinky', 'data', 'router-security', 'policy-state.json',
    );
}

function fsyncDirectory(directory) {
    let descriptor;
    try {
        descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
        fs.fsyncSync(descriptor);
    } catch (error) {
        if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EBADF'].includes(error?.code)) throw error;
    } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
    }
}

function installDurableCandidate(file, bytes, { beforeReplace } = {}) {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.policy-state.${process.pid}.${Date.now()}.tmp`);
    let descriptor;
    try {
        descriptor = fs.openSync(tmp, 'wx', 0o600);
        fs.writeFileSync(descriptor, bytes);
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        if (typeof beforeReplace === 'function') beforeReplace({ file, tmp });
        fs.renameSync(tmp, file);
        fsyncDirectory(dir);
    } catch (error) {
        if (descriptor !== undefined) {
            try { fs.closeSync(descriptor); } catch (_) {}
        }
        try { fs.unlinkSync(tmp); } catch (_) {}
        throw error;
    }
}

export class FileSystemPolicyStateStore extends PolicyStateStore {
    constructor({
        file,
        coordinate = file === undefined,
        testHooks = {},
        createWorkspaceLease = createWorkspaceMutationLease,
        releaseWorkspaceLease = releaseWorkspaceMutationLease,
    } = {}) {
        super();
        this._fileFn = file || defaultFile;
        this._coordinate = coordinate === true;
        this._testHooks = testHooks;
        this._createWorkspaceLease = createWorkspaceLease;
        this._releaseWorkspaceLease = releaseWorkspaceLease;
    }

    _file() {
        return this._fileFn();
    }

    _version(stat) {
        return `${stat.mtimeMs}:${stat.size}`;
    }

    currentVersion() {
        try {
            return this._version(fs.statSync(this._file()));
        } catch {
            // No file yet: nothing persisted (the repository treats this as empty).
            return null;
        }
    }

    read() {
        const document = JSON.parse(fs.readFileSync(this._file(), 'utf8'));
        return { found: true, document };
    }

    write(document) {
        const file = this._file();
        const bytes = Buffer.from(JSON.stringify(document, null, 2));
        const install = (applyLockCapability) => {
            if (this._coordinate) {
                inactivateEdgeRoutingGeneration('policy-candidate-change', {
                    workspaceRoot: PLOINKY_WORKSPACE_ROOT,
                    applyLockCapability,
                });
            }
            installDurableCandidate(file, bytes, {
                beforeReplace: this._testHooks.beforeCandidateReplace,
            });
            return {
                version: this._version(fs.statSync(file)),
                expectedGeneration: this._coordinate
                    ? captureEdgeRoutingCandidateGeneration({
                        workspaceRoot: PLOINKY_WORKSPACE_ROOT,
                        applyLockCapability,
                    })
                    : undefined,
            };
        };
        if (!this._coordinate) return install(undefined).version;
        const workspaceLease = this._createWorkspaceLease({ operation: 'policy-write' });
        try {
            const installed = withEdgeGenerationApplyLock(install, {
                workspaceRoot: PLOINKY_WORKSPACE_ROOT,
            });
            applyEdgeRoutingGeneration({
                reason: 'policy-write',
                workspaceRoot: PLOINKY_WORKSPACE_ROOT,
                expectedGeneration: installed.expectedGeneration,
            });
            return installed.version;
        } finally {
            if (!this._releaseWorkspaceLease(workspaceLease)) {
                const error = new Error('policy write could not release the workspace mutation lease');
                error.code = 'POLICY_COORDINATION_RELEASE_FAILED';
                throw error;
            }
        }
    }
}

export default FileSystemPolicyStateStore;
