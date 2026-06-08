import { FileSystemPolicyAuditSink } from './FileSystemPolicyAuditSink.js';

/**
 * PolicyAuditLog — the domain layer for the router access-control audit trail
 * (DS014). Records identifiers and decisions only, never tokens or secrets.
 *
 * Single responsibility: timestamp each decision and guarantee that an audit
 * failure never breaks the request path. The durable append is delegated to a
 * pluggable `PolicyAuditSink` (Strategy/Adapter), defaulting to the filesystem
 * (`FileSystemPolicyAuditSink`); a database sink can be dropped in unchanged.
 */
export class PolicyAuditLog {
    constructor({ sink, dir } = {}) {
        this._sink = sink || new FileSystemPolicyAuditSink({ dir });
    }

    record(entry) {
        try {
            this._sink.append({ ts: new Date().toISOString(), ...entry });
        } catch (err) {
            console.error(`[ploinky] failed to append policy audit: ${err?.message || err}`);
        }
    }
}

export default PolicyAuditLog;
