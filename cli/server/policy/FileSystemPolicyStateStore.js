import fs from 'node:fs';
import path from 'node:path';
import { PLOINKY_WORKSPACE_ROOT } from '../../services/config.js';

import { PolicyStateStore } from './PolicyStateStore.js';

/**
 * FileSystemPolicyStateStore — the default `PolicyStateStore` adapter (DS014).
 * Persists the policy document as `policy-state.json` under the workspace
 * `.ploinky/data/router-security/`. Version token is `mtimeMs:size` (a cheap
 * `statSync`); writes are atomic (temp file in the same directory → `renameSync`).
 * `read()` throws on a missing file or undecodable JSON so the repository fails
 * closed. Holds all `node:fs`/`node:path` usage for the state document.
 */
function defaultFile() {
    return path.join(
        PLOINKY_WORKSPACE_ROOT,
        '.ploinky', 'data', 'router-security', 'policy-state.json',
    );
}

export class FileSystemPolicyStateStore extends PolicyStateStore {
    constructor({ file } = {}) {
        super();
        this._fileFn = file || defaultFile;
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
        const dir = path.dirname(file);
        fs.mkdirSync(dir, { recursive: true });
        const tmp = path.join(dir, `.policy-state.${process.pid}.${Date.now()}.tmp`);
        fs.writeFileSync(tmp, JSON.stringify(document, null, 2));
        fs.renameSync(tmp, file);
        return this._version(fs.statSync(file));
    }
}

export default FileSystemPolicyStateStore;
