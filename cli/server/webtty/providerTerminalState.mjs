import {
    launchFields, terminalError, terminalLaunchHash, terminalSequence, validateTerminalLaunch,
} from './providerTerminalProtocol.mjs';

export class ProviderTerminalState {
    constructor(limits) {
        this.limits = limits;
        this.operations = new Map();
        this.ptys = new Map();
        this.inputBytes = 0;
    }

    operation(fields) {
        validateTerminalLaunch(fields);
        const hash = terminalLaunchHash(fields);
        const existing = this.operations.get(fields.operationId);
        if (existing) {
            if (existing.hash !== hash) throw terminalError('operation_conflict');
            return existing;
        }
        const unresolved = [...this.operations.values()].filter((op) => !op.result && !op.failure).length;
        if (this.operations.size >= this.limits.operations || this.ptys.size + unresolved >= this.limits.ptys) {
            throw terminalError('capacity');
        }
        const immutable = Object.freeze({ ...launchFields(fields),
            project: fields.project === null ? null : Object.freeze({ ...fields.project }),
        });
        const operation = { fields: immutable, hash, result: null, failure: false, attempt: null };
        this.operations.set(fields.operationId, operation);
        return operation;
    }

    reply(frame, channel) {
        const operation = this.operations.get(frame.operationId);
        if (!operation) return;
        if (operation.result) {
            if (frame.type !== 'launched' || operation.result !== frame.ptySessionId) throw terminalError();
            return;
        }
        if (!operation.attempt?.dispatched || operation.attempt.channel !== channel) return;
        if (frame.type === 'launch-failed') {
            operation.failure = true;
            // The worker's validated refusal code (for example target_not_ready),
            // delivered to the caller as a refusal and not as an uncertainty.
            operation.refusal = frame.code;
            operation.attempt.finish(true);
            // The refusal is delivered; the operation is not retained, so
            // refused launches never fill the operation table.
            this.operations.delete(frame.operationId);
            return;
        }
        if (this.ptys.has(frame.ptySessionId)) throw terminalError();
        operation.result = frame.ptySessionId;
        this.ptys.set(frame.ptySessionId, {
            id: frame.ptySessionId, nextInput: 1n, dispatched: 0n, acknowledged: 0n, output: 0n,
            attached: null, inputs: new Map(), available: true, closing: false,
        });
        operation.attempt.finish(null, frame.ptySessionId);
    }

    pty(id) {
        const pty = this.ptys.get(id);
        if (!pty || !pty.available || pty.closing) throw terminalError('unknown_pty');
        return pty;
    }

    acknowledge(pty, sequence) {
        if (sequence > pty.dispatched) throw terminalError();
        if (sequence <= pty.acknowledged) return;
        pty.acknowledged = sequence;
        for (const [number, frame] of pty.inputs) {
            if (number <= sequence) {
                this.inputBytes -= frame.length;
                pty.inputs.delete(number);
            }
        }
    }

    // Removes an operation that never produced a PTY and has no attempt in
    // flight; returns whether anything was removed.
    forget(operationId) {
        const operation = this.operations.get(operationId);
        if (!operation || operation.result || operation.attempt) return false;
        return this.operations.delete(operationId);
    }

    reconcile(inventory) {
        // Validate the entire inventory before mutating any known cursor.
        for (const entry of inventory) {
            const pty = this.ptys.get(entry.ptySessionId);
            if (!pty) continue;
            const inputNext = terminalSequence(entry.inputNext, { exhausted: true });
            const outputLast = terminalSequence(entry.outputLast, { zero: true });
            if (inputNext > pty.dispatched + 1n || inputNext <= pty.acknowledged || outputLast < pty.output) {
                throw terminalError();
            }
        }
        const ids = new Set(inventory.map((entry) => entry.ptySessionId));
        for (const pty of this.ptys.values()) {
            pty.attached = null;
            pty.available = ids.has(pty.id);
        }
        for (const entry of inventory) {
            const pty = this.ptys.get(entry.ptySessionId);
            if (pty) this.acknowledge(pty, terminalSequence(entry.inputNext, { exhausted: true }) - 1n);
        }
        // A PTY the worker no longer lists has ended: forget it (and its
        // operation) and report it, so no entry stays unavailable for ever.
        const lost = [];
        for (const pty of [...this.ptys.values()]) {
            if (!pty.available) {
                lost.push(pty.id);
                this.ended(pty.id);
            }
        }
        return lost;
    }

    disconnect(channel) {
        for (const operation of this.operations.values()) {
            if (operation.attempt?.channel === channel) operation.attempt.finish(true);
        }
        for (const pty of this.ptys.values()) if (pty.attached === channel) pty.attached = null;
    }

    ended(id) {
        const pty = this.ptys.get(id);
        if (!pty) return false;
        for (const frame of pty.inputs.values()) this.inputBytes -= frame.length;
        this.ptys.delete(id);
        for (const [operationId, operation] of this.operations) {
            if (operation.result === id) this.operations.delete(operationId);
        }
        return true;
    }

    clear() {
        this.operations.clear();
        this.ptys.clear();
        this.inputBytes = 0;
    }
}
