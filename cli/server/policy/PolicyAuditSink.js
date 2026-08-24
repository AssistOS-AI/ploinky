/**
 * PolicyAuditSink — the persistence port (Strategy/Adapter seam, DS016) for the
 * router access-control audit trail. `PolicyAuditLog` owns the domain concern
 * (timestamping each record and guaranteeing an audit failure never breaks the
 * request path) and delegates only the durable append to a concrete sink. Swapping
 * the append-only file for a database table is a new subclass.
 *
 * Contract:
 *   append(record): void
 *     Durably append one already-timestamped audit `record` (a plain object). MAY
 *     throw; `PolicyAuditLog` swallows the error so auditing is never request-fatal.
 */
export class PolicyAuditSink {
    append(_record) {
        throw new Error('PolicyAuditSink.append() not implemented');
    }
}

export default PolicyAuditSink;
