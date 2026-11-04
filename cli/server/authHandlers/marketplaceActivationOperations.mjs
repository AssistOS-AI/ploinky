import { randomUUID } from 'node:crypto';

export const isMarketplaceOperationId = value => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);

// Receipts observe the existing lifecycle promise; they do not own or cancel it.
export function createMarketplaceActivationOperations({ now = Date.now, maxPending = 16, maxTerminal = 64, ttlMs = 600_000 } = {}) {
    const records = new Map();
    const prune = () => {
        const terminal = [];
        for (const [id, record] of records) {
            if (record.operation.state === 'pending') continue;
            if (now() - record.completedAt >= ttlMs) records.delete(id);
            else terminal.push(id);
        }
        while (terminal.length > maxTerminal) records.delete(terminal.shift());
    };
    return {
        read(id, scope) {
            prune();
            const record = records.get(id);
            return record?.scope === scope ? structuredClone(record.operation) : null;
        },
        start({ scope, agentRef, mode, run, failure }) {
            prune();
            let pending = 0;
            for (const record of records.values()) {
                if (record.operation.state !== 'pending') continue;
                pending++;
                if (record.scope === scope && record.operation.agentRef === agentRef && record.operation.mode === mode) {
                    return structuredClone(record.operation);
                }
            }
            if (pending >= maxPending) return null;
            const operation = { id: randomUUID(), agentRef, mode, state: 'pending' };
            const record = { scope, operation };
            records.set(operation.id, record);
            const settle = (state, error) => {
                operation.state = state;
                if (error) operation.error = failure(error);
                record.completedAt = now();
                prune();
            };
            // Attach both handlers immediately, including for a synchronous throw.
            Promise.resolve().then(run).then(() => settle('succeeded'), error => settle('failed', error));
            return structuredClone(operation);
        },
    };
}
