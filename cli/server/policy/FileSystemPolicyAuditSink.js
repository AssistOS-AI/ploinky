import fs from 'node:fs';
import path from 'node:path';
import { PLOINKY_WORKSPACE_ROOT } from '../../services/config.js';

import { PolicyAuditSink } from './PolicyAuditSink.js';

/**
 * FileSystemPolicyAuditSink — the default `PolicyAuditSink` adapter (DS014). Appends
 * one JSONL line per record to `policy-audit.log` under the workspace
 * `.ploinky/data/router-security/`. Holds all `node:fs`/`node:path` usage for the
 * audit trail. Errors propagate to `PolicyAuditLog`, which swallows them.
 */
function defaultDir() {
    return path.join(
        PLOINKY_WORKSPACE_ROOT,
        '.ploinky', 'data', 'router-security',
    );
}

export class FileSystemPolicyAuditSink extends PolicyAuditSink {
    constructor({ dir } = {}) {
        super();
        this._dirFn = typeof dir === 'function'
            ? dir
            : dir ? () => dir : defaultDir;
    }

    append(record) {
        const dir = this._dirFn();
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(path.join(dir, 'policy-audit.log'), `${JSON.stringify(record)}\n`);
    }
}

export default FileSystemPolicyAuditSink;
