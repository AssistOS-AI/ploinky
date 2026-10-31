import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';

import { WEBTTY_PROTOCOL_LIMITS } from '../../../core-services/webtty/worker-protocol.mjs';

// The session manager's worker interface (spawn/start/input/resize/close/
// waitForExit plus output, terminal-exit and error events) over one provider
// PTY. The adapter holds no durable record: a provider PTY is bounded by the
// worker's lease, not by a Router-side recovery record, so it can never make
// Router recovery unproven. Only a PTY end that the worker itself reported is
// treated as proven; a local notice (client shutdown, a PTY missing after a
// reconcile) is an unconfirmed end.
export const PROVIDER_TERMINAL_EXIT_WAIT_MS = 10_000;
const RESUME_RETRIES = 5;
const RESUME_RETRY_MS = 500;

// WebTTY accepts 2..1024 columns and 2..512 rows (the provider protocol
// accepts the same); a drift would only surface at the first launch.
export function providerDimensionsFit() {
    return WEBTTY_PROTOCOL_LIMITS.minColumns >= 2 && WEBTTY_PROTOCOL_LIMITS.maxColumns <= 1024
        && WEBTTY_PROTOCOL_LIMITS.minRows >= 2 && WEBTTY_PROTOCOL_LIMITS.maxRows <= 512;
}

function sessionError(code, message = code) {
    const error = new Error(message);
    error.code = code;
    return error;
}

// Maps a provider terminal client error onto the session manager's error
// codes, which the HTTP handler turns into retryable or final answers.
export function mapProviderTerminalError(error) {
    const code = String(error?.code || '');
    if (code === 'PROVIDER_TERMINAL_LAUNCH_FAILED') {
        // The worker's refusal code is a validated token, safe to show; any
        // other value is dropped.
        const refused = sessionError('WEBTTY_PROVIDER_LAUNCH_REFUSED');
        if (typeof error.refusal === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(error.refusal)) refused.reason = error.refusal;
        return refused;
    }
    if (code === 'PROVIDER_TERMINAL_UNKNOWN_PTY') return sessionError('WEBTTY_SESSION_NOT_FOUND');
    if (code === 'PROVIDER_TERMINAL_BACKPRESSURE') return sessionError('WEBTTY_IPC_BACKPRESSURE');
    return sessionError('WEBTTY_UNAVAILABLE');
}

export class ProviderTerminalSessionWorker extends EventEmitter {
    #hub;
    #routeKey;
    #target;
    #adminLease;
    #setTimeout;
    #exitWaitMs;
    #ptySessionId = null;
    #unwatch = null;
    #decoder = new StringDecoder('utf8');
    #sequence = 0;
    #cancelled = false;
    #ended = false;
    #proven = false;
    #waiters = new Set();
    #resumeAttempt = 0;

    constructor({ hub, routeKey, target, adminLease, setTimeout: schedule = setTimeout,
        exitWaitMs = PROVIDER_TERMINAL_EXIT_WAIT_MS } = {}) {
        super();
        this.#hub = hub;
        this.#routeKey = routeKey;
        this.#target = target;
        this.#adminLease = adminLease;
        this.#setTimeout = schedule;
        this.#exitWaitMs = exitWaitMs;
    }

    // There is no worker process to spawn and no identity to record.
    async spawn() { return null; }

    // Launches the PTY under the creating request's administrator lease and
    // attaches to it. A close that arrives while the launch is in flight
    // cancels the session: a PTY that appears afterwards is closed at once.
    async start({ cols, rows } = {}) {
        if (this.#cancelled) throw sessionError('WEBTTY_AUTH_INVALID', 'startup cancelled');
        const operationId = crypto.randomUUID();
        const fields = {
            operationId,
            targetId: this.#target.targetId,
            project: this.#target.project,
            cols,
            rows,
        };
        let ptySessionId;
        try {
            const routing = this.#hub.routingLease();
            ptySessionId = await this.#hub.launch(this.#routeKey, fields, { routing, admin: this.#adminLease });
        } catch (error) {
            try { this.#hub.forgetOperation(this.#routeKey, operationId); } catch (_) { }
            throw mapProviderTerminalError(error);
        }
        this.#ptySessionId = ptySessionId;
        this.#unwatch = this.#hub.watch(this.#routeKey, ptySessionId, {
            output: (frame) => this.#output(frame),
            gap: (info) => this.#gap(info),
            ended: (frame) => this.#end(frame),
            resumed: () => this.#resume(),
        });
        if (this.#cancelled) {
            await this.#closePty();
            throw sessionError('WEBTTY_AUTH_INVALID', 'startup cancelled');
        }
        try {
            await this.#hub.attach(this.#routeKey, ptySessionId);
        } catch (error) {
            await this.#closePty();
            throw mapProviderTerminalError(error);
        }
        return { processIdentity: null };
    }

    #output(frame) {
        const data = this.#decoder.write(frame.payload);
        if (!data) return;
        this.#sequence += 1;
        this.emit('output', { sequence: this.#sequence, data });
    }

    // Output the worker could no longer replay: continue from what it still
    // has. The bytes in between are lost, which the worker's gap frame states.
    #gap({ firstAvailable }) {
        this.#reattach(firstAvailable - 1n);
    }

    #resume() {
        this.#resumeAttempt = 0;
        this.#reattach();
    }

    #reattach(afterOutputSequence) {
        if (this.#ended || this.#cancelled) return;
        const options = afterOutputSequence === undefined ? {} : { afterOutputSequence };
        this.#hub.attach(this.#routeKey, this.#ptySessionId, options).catch((error) => {
            if (this.#ended || this.#cancelled) return;
            if (String(error?.code || '') === 'PROVIDER_TERMINAL_UNKNOWN_PTY') return;
            if (this.#resumeAttempt >= RESUME_RETRIES) return;
            this.#resumeAttempt += 1;
            const timer = this.#setTimeout(() => this.#reattach(afterOutputSequence), RESUME_RETRY_MS);
            timer.unref?.();
        });
    }

    #end(frame) {
        if (this.#ended) return;
        this.#ended = true;
        // Only an `ended` frame from the worker proves the PTY is gone; a
        // local notice (frame.local) reports a loss of knowledge, not an exit.
        this.#proven = frame.local !== true;
        try { this.#unwatch?.(); } catch (_) { }
        this.#unwatch = null;
        for (const waiter of [...this.#waiters]) waiter(this.#proven);
        this.emit('terminal-exit', { category: String(frame.cause || 'exit'), cleanupProven: this.#proven });
    }

    async input(data) {
        if (this.#ended || this.#cancelled || !this.#ptySessionId) throw sessionError('WEBTTY_SESSION_NOT_FOUND');
        try {
            await this.#hub.input(this.#routeKey, this.#ptySessionId, Buffer.from(String(data), 'utf8'));
        } catch (error) {
            throw mapProviderTerminalError(error);
        }
    }

    async resize(cols, rows) {
        if (this.#ended || this.#cancelled || !this.#ptySessionId) throw sessionError('WEBTTY_SESSION_NOT_FOUND');
        try {
            await this.#hub.resize(this.#routeKey, this.#ptySessionId, cols, rows);
        } catch (error) {
            throw mapProviderTerminalError(error);
        }
    }

    async #closePty() {
        if (!this.#ptySessionId || this.#ended) return;
        try { await this.#hub.close(this.#routeKey, this.#ptySessionId); } catch (_) { }
    }

    // Sends the close frame; the PTY's end is observed through waitForExit.
    async close() {
        this.#cancelled = true;
        await this.#closePty();
    }

    // True only when the worker reported the PTY's end. A PTY that was never
    // launched has nothing to prove. A close the worker never confirms within
    // the bound is unconfirmed; its lease expiry still ends the PTY.
    waitForExit() {
        if (!this.#ptySessionId) return Promise.resolve(true);
        if (this.#ended) return Promise.resolve(this.#proven);
        return new Promise((resolve) => {
            let timer;
            const waiter = (proven) => {
                this.#waiters.delete(waiter);
                clearTimeout(timer);
                resolve(proven);
            };
            this.#waiters.add(waiter);
            timer = setTimeout(() => waiter(false), this.#exitWaitMs);
            timer.unref?.();
        });
    }
}

export default ProviderTerminalSessionWorker;
