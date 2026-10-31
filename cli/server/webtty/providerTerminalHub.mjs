import { ProviderTerminalClient } from './providerTerminalClient.mjs';
import { terminalError, terminalLaunchHash } from './providerTerminalProtocol.mjs';
import { openProviderTerminalTransport } from './providerTerminalTransport.mjs';
import { planProviderEndpoint } from '../executionProvider/providerEndpointPlan.mjs';
import { canonicalOriginCallerKey } from '../executionProvider/originToken.mjs';
import { adminActorRoles } from './providerTerminalTargets.mjs';
import { isAdminUser } from '../auth/localService.js';
import { captureEdgeRoutingLease } from '../../sandbox/edgeGeneration.js';
import { buildRouterRequest } from '../mcp-proxy/invocationMinter.js';

export const PROVIDER_TERMINAL_LAUNCH_TOOL = '__provider_terminal_launch__';
export const PROVIDER_TERMINAL_LAUNCH_METHOD = 'LAUNCH';

// The Router's explicit local budgets for the provider terminal client. The
// provider side grants a 15 s lease renewed by heartbeats; every number here
// is chosen against that, not copied from a fixture.
export const PROVIDER_TERMINAL_HUB_LIMITS = Object.freeze({
    // Each wait for the worker during connect (token, open, challenge, hello-ok).
    handshakeMs: 10_000,
    // One frame handed to the transport must be written within this time.
    sendMs: 10_000,
    // A launch or a heartbeat reply is bounded by this time.
    operationMs: 10_000,
    // Heartbeat every 5 s: three beats fit in one lease.
    heartbeatMs: 5_000,
    // Local liveness deadline, equal to the worker's 15 s lease expiry.
    leaseMs: 15_000,
    // Queued, not yet written outbound bytes per channel.
    queueBytes: 1024 * 1024,
    // Unacknowledged input bytes retained for replay across a reattach.
    inputBytes: 1024 * 1024,
    // Launch operations remembered per client (bounded by pruning on end).
    operations: 256,
    // Live PTYs per client; the worker's own cap is lower.
    ptys: 128,
});

export const PROVIDER_TERMINAL_HUB_TIMING = Object.freeze({
    backoffBaseMs: 250,
    backoffMaxMs: 5_000,
    // A connection that held at least this long was healthy: only then does
    // the next attempt start again from the shortest backoff.
    stableMs: 30_000,
    // How often the hub looks for a stale routing lease of a connected client.
    routingCheckMs: 1_000,
    // A launch can outlast one operationMs (the provider fetches its sources and
    // prepares the target first). The hub keeps retrying the SAME operation id
    // for this long, within the held ownership; the provider joins the launch
    // that is in flight, so a retry never starts a second one. Without a retry a
    // launch that outlives the provider's unclaimed bound ends `unclaimed`.
    launchWindowMs: 45_000,
    // How long an operation waits for a client to become usable.
    connectWaitMs: 10_000,
});

// A routing lease is current exactly when its edge generation still is. The
// session adapter passes {routing, admin}; the hub's own connect and rotate
// leases are plain routing leases.
export function isRoutingLeaseCurrent(lease) {
    const routing = lease?.routing ?? lease;
    return typeof routing?.isCurrent === 'function' && routing.isCurrent() === true;
}

// One provider terminal client per declaring provider route. The hub owns the
// connection state machine and nothing else: it connects with backoff, keeps
// ownership across a channel loss or a routing generation change by rotating
// (make-before-break, only while the ownership deadline holds), and replaces
// the client only when the client is permanently closed (its own shutdown(),
// including lease expiry) or reports that its ownership is unavailable.
export class ProviderTerminalHub {
    #relayManager;
    #tokenService;
    #validateAdmin;
    #mintRouterRequest;
    #plan;
    #captureLease;
    #openTransport;
    #clientFactory;
    #limits;
    #timing;
    #now;
    #setTimeout;
    #clearTimeout;
    #audit;
    #entries = new Map();
    #watchers = new Map();
    #routingTimer = null;
    #closed = false;

    constructor({
        relayManager,
        routerServiceTokenService,
        validateAdmin,
        mintRouterRequest = buildRouterRequest,
        planEndpoint = planProviderEndpoint,
        captureLease = captureEdgeRoutingLease,
        openTransport = openProviderTerminalTransport,
        clientFactory = (options) => new ProviderTerminalClient(options),
        limits = PROVIDER_TERMINAL_HUB_LIMITS,
        timing = PROVIDER_TERMINAL_HUB_TIMING,
        now = Date.now,
        setTimeout: schedule = setTimeout,
        clearTimeout: cancel = clearTimeout,
        audit = () => {},
    } = {}) {
        if (typeof routerServiceTokenService?.mint !== 'function' || typeof validateAdmin !== 'function') {
            throw terminalError('configuration');
        }
        this.#relayManager = relayManager;
        this.#tokenService = routerServiceTokenService;
        this.#validateAdmin = validateAdmin;
        this.#mintRouterRequest = mintRouterRequest;
        this.#plan = planEndpoint;
        this.#captureLease = captureLease;
        this.#openTransport = openTransport;
        this.#clientFactory = clientFactory;
        this.#limits = Object.freeze({ ...limits });
        this.#timing = Object.freeze({ ...PROVIDER_TERMINAL_HUB_TIMING, ...timing });
        this.#now = now;
        this.#setTimeout = schedule;
        this.#clearTimeout = cancel;
        this.#audit = audit;
    }

    get limits() { return this.#limits; }

    // A fresh routing lease of the active edge generation, for an operation
    // that is not tied to one request (input, resize, close, reattach).
    routingLease() { return this.#captureLease(); }

    isLeaseCurrent(lease) { return isRoutingLeaseCurrent(lease); }

    // ---- launch evidence --------------------------------------------------

    // Mints the launch evidence from the creating request's administrator
    // lease, revalidated now, and never from hub or client state: a retry
    // re-mints, and a demoted administrator gets nothing. The actor carries
    // the role `admin` exactly because this very check passed.
    async mintLaunchEvidence({ targetAgentId, tool, method, path, rch, launch, lease } = {}) {
        const admin = lease?.admin;
        if (!admin || tool !== PROVIDER_TERMINAL_LAUNCH_TOOL || method !== PROVIDER_TERMINAL_LAUNCH_METHOD) {
            throw terminalError('forbidden');
        }
        if (rch !== terminalLaunchHash(launch)) throw terminalError('operation_conflict');
        const verdict = await this.#validateAdmin(admin);
        const user = verdict?.ok === true ? verdict.session?.user : null;
        if (!user || !isAdminUser(user) || String(user.id || '') !== String(admin.userId || '')) {
            throw terminalError('forbidden');
        }
        const key = canonicalOriginCallerKey({ user });
        if (!key) throw terminalError('forbidden');
        const { token } = this.#mintRouterRequest({
            targetAgentId,
            sub: key,
            actor: { kind: 'user', id: key, roles: adminActorRoles(user) },
            method,
            path,
            tool,
            rch,
        });
        return token;
    }

    // ---- entries and clients ----------------------------------------------

    #entry(routeKey) {
        let entry = this.#entries.get(routeKey);
        if (!entry) {
            entry = {
                routeKey, client: null, identity: null, state: 'idle', lease: null,
                running: false, waiters: new Set(), failure: null, sleeper: null,
                // Attempt pacing carried across supervision loops: how many
                // attempts since the last healthy connection, when the next
                // one may start, and when the connection last came up.
                attempt: 0, notBefore: 0, connectedAt: null,
            };
            this.#entries.set(routeKey, entry);
        }
        return entry;
    }

    // The provider's principal and declared terminal path from a freshly
    // planned websocket operation; an unavailable provider throws.
    #identity(routeKey) {
        let plan;
        try {
            plan = this.#plan({ routeKey, endpoint: 'terminals', subpath: '', method: 'GET', transport: 'websocket' });
        } catch (_) {
            throw terminalError('provider_unavailable');
        }
        if (!plan?.ok || !plan.relay?.targetAgentId || typeof plan.unmatchedSuffix !== 'string') {
            throw terminalError('provider_unavailable');
        }
        return { principal: plan.relay.targetAgentId, path: plan.unmatchedSuffix };
    }

    async #open(routeKey, { provider, path, lease, signal, headers }) {
        const plan = this.#plan({ routeKey, endpoint: 'terminals', subpath: '', method: 'GET', transport: 'websocket' });
        if (!plan?.ok || plan.relay?.targetAgentId !== provider || plan.unmatchedSuffix !== path
            || (lease?.id && plan.generationDigest !== lease.id)) {
            throw terminalError('provider_unavailable');
        }
        return this.#openTransport({
            plan, lease: plan.lease, relayManager: this.#relayManager, signal,
            authInfo: headers?.['x-ploinky-auth-info'],
        });
    }

    #createClient(entry, identity) {
        const client = this.#clientFactory({
            provider: identity.principal,
            path: identity.path,
            openTransport: (request) => this.#open(entry.routeKey, request),
            routerServiceTokenService: this.#tokenService,
            mintLaunchEvidence: (request) => this.mintLaunchEvidence(request),
            isLeaseCurrent: (lease) => this.isLeaseCurrent(lease),
            now: this.#now,
            setTimeout: this.#setTimeout,
            clearTimeout: this.#clearTimeout,
            limits: this.#limits,
        });
        client.on('output', (frame) => this.#watchers.get(frame.ptySessionId)?.handlers.output?.(frame));
        client.on('gap', (info) => this.#watchers.get(info.ptySessionId)?.handlers.gap?.(info));
        client.on('ended', (frame) => this.#finish(frame.ptySessionId, frame));
        client.on('unavailable', ({ ptySessionId }) => this.#finish(ptySessionId,
            { v: 1, type: 'ended', ptySessionId, cause: 'unavailable', local: true }));
        client.on('diagnostic', () => this.#onChannelLost(entry, client));
        client.on('shutdown', ({ ptySessionIds }) => this.#onShutdown(entry, client, ptySessionIds));
        return client;
    }

    #finish(ptySessionId, frame) {
        const watcher = this.#watchers.get(ptySessionId);
        this.#watchers.delete(ptySessionId);
        try { watcher?.handlers.ended?.(frame); } catch (_) { }
    }

    // A PTY's session is told about output, gaps, its end and a completed
    // reattachment by PTY identity. The subscription survives a client
    // replacement because the end of every PTY of a replaced client is
    // delivered (a local notice with cause 'shutdown').
    watch(routeKey, ptySessionId, handlers) {
        const watcher = { routeKey, handlers };
        this.#watchers.set(ptySessionId, watcher);
        return () => { if (this.#watchers.get(ptySessionId) === watcher) this.#watchers.delete(ptySessionId); };
    }

    // ---- state machine ----------------------------------------------------

    // The client is permanently closed (explicit shutdown, or the lease
    // expired): every PTY it knew ended with cause 'shutdown' and the entry is
    // reset, so the next use builds a fresh client with a new hello.
    #onShutdown(entry, client, ptySessionIds = []) {
        for (const ptySessionId of ptySessionIds) {
            this.#finish(ptySessionId, { v: 1, type: 'ended', ptySessionId, cause: 'shutdown', local: true });
        }
        if (entry.client !== client) return;
        entry.client = null;
        entry.identity = null;
        entry.lease = null;
        entry.state = 'idle';
        this.#audit('provider_terminal_client_replaced', { provider: entry.routeKey });
        if (entry.waiters.size && !this.#closed) this.#kick(entry);
    }

    // A channel closed while the client still holds ownership: keep the
    // ownership by rotating under a fresh lease. Without ownership there is
    // nothing to keep; a later use connects.
    #onChannelLost(entry, client) {
        if (this.#closed || entry.client !== client) return;
        if (entry.state === 'connected') entry.state = 'reconnecting';
        if (client.ownershipHeld()) this.#kick(entry);
    }

    #backoff(attempt) {
        return Math.min(this.#timing.backoffMaxMs, this.#timing.backoffBaseMs * (2 ** Math.min(attempt, 16)));
    }

    #sleep(entry, ms) {
        return new Promise((resolve) => {
            const timer = this.#setTimeout(() => { entry.sleeper = null; resolve(); }, ms);
            entry.sleeper = () => { this.#clearTimeout(timer); entry.sleeper = null; resolve(); };
        });
    }

    #kick(entry) {
        if (entry.running || this.#closed) return;
        entry.running = true;
        void this.#run(entry).finally(() => {
            entry.running = false;
            // A state change that arrived while the loop ended is not lost.
            if (!this.#closed && entry.waiters.size && entry.state !== 'connected' && !entry.running) this.#kick(entry);
        });
    }

    #wanted(entry) {
        return !this.#closed && (entry.waiters.size > 0 || Boolean(entry.client?.ownershipHeld()));
    }

    // One supervision loop per provider: connect (no ownership yet) or rotate
    // (ownership held) until it succeeds, nobody wants the connection any more,
    // or the hub closes. Every attempt, successful or not, pushes the next one
    // back by an exponentially growing interval that is carried in the entry
    // across loops, so competing demand and a flapping channel cannot make the
    // hub reconnect faster than the backoff; the interval starts over only
    // after a connection held for `stableMs`. Only the client's own shutdown
    // ends ownership; this loop never gives up an ownership whose deadline holds.
    async #run(entry) {
        while (this.#wanted(entry)) {
            const wait = entry.notBefore - this.#now();
            if (wait > 0) {
                await this.#sleep(entry, wait);
                continue;
            }
            if (entry.connectedAt !== null && this.#now() - entry.connectedAt >= this.#timing.stableMs) entry.attempt = 0;
            entry.connectedAt = null;
            entry.notBefore = this.#now() + this.#backoff(entry.attempt);
            entry.attempt += 1;
            let client = entry.client;
            try {
                const identity = this.#identity(entry.routeKey);
                if (!client) {
                    client = this.#createClient(entry, identity);
                    entry.client = client;
                    entry.identity = identity;
                } else if (identity.principal !== entry.identity?.principal || identity.path !== entry.identity?.path) {
                    // The provider was re-enabled as another agent or declares
                    // another path: the held ownership belongs to a worker that
                    // is no longer the one the route reaches.
                    throw Object.assign(new Error('provider identity changed'), { code: 'PROVIDER_IDENTITY_CHANGED' });
                }
                const lease = this.#captureLease();
                if (client.ownershipHeld()) await client.rotate({ lease });
                else await client.connect({ lease });
                entry.lease = lease;
                entry.state = 'connected';
                entry.connectedAt = this.#now();
                entry.failure = null;
                this.#settle(entry, true);
                this.#resumed(entry);
                return;
            } catch (error) {
                const code = String(error?.code || '');
                if (code === 'PROVIDER_TERMINAL_ALREADY_CONNECTED') {
                    entry.state = 'connected';
                    this.#settle(entry, true);
                    return;
                }
                entry.failure = code || 'unavailable';
                if (client && (code === 'PROVIDER_TERMINAL_OWNERSHIP_UNAVAILABLE'
                    || code === 'PROVIDER_IDENTITY_CHANGED' || client.closed)) {
                    // Nothing to rotate: build a new client, with a new hello,
                    // on the next paced attempt (its shutdown event resets the entry).
                    if (!client.closed) void client.shutdown();
                    if (entry.client === client) {
                        entry.client = null;
                        entry.identity = null;
                    }
                    continue;
                }
                entry.state = client?.ownershipHeld() ? 'reconnecting' : 'backoff';
            }
        }
    }

    // After a connect or rotation the worker needs an attach per PTY to send
    // output again (reconcile detaches them all); each watcher re-attaches.
    #resumed(entry) {
        for (const watcher of [...this.#watchers.values()]) {
            if (watcher.routeKey === entry.routeKey) {
                try { watcher.handlers.resumed?.(); } catch (_) { }
            }
        }
    }

    #settle(entry, ok) {
        const waiters = [...entry.waiters];
        entry.waiters.clear();
        for (const waiter of waiters) waiter(ok);
    }

    // Resolves the client once it is connected under a current routing lease.
    // A stale connect lease is rotated here, before the operation, so that
    // the first operation after a routing change does not fail on it.
    async #usable(routeKey) {
        if (this.#closed) throw terminalError('closed');
        const entry = this.#entry(routeKey);
        if (entry.state === 'connected' && entry.client && !entry.client.closed) {
            if (entry.lease && !entry.lease.isCurrent()) {
                if (entry.client.ownershipHeld()) entry.state = 'reconnecting';
                else entry.state = 'idle';
            } else {
                return entry.client;
            }
        }
        await new Promise((resolve, reject) => {
            let timer;
            const waiter = (ok) => {
                this.#clearTimeout(timer);
                if (ok) resolve();
                else reject(terminalError('provider_unavailable'));
            };
            timer = this.#setTimeout(() => {
                entry.waiters.delete(waiter);
                reject(terminalError('provider_unavailable'));
            }, this.#timing.connectWaitMs);
            entry.waiters.add(waiter);
            this.#kick(entry);
        });
        if (!entry.client || entry.client.closed || entry.state !== 'connected') {
            throw terminalError('provider_unavailable');
        }
        this.#armRoutingCheck();
        return entry.client;
    }

    #armRoutingCheck() {
        if (this.#routingTimer || this.#closed) return;
        this.#routingTimer = this.#setTimeout(() => {
            this.#routingTimer = null;
            let any = false;
            for (const entry of this.#entries.values()) {
                if (!entry.client || entry.client.closed) continue;
                any = true;
                if (entry.state === 'connected' && entry.lease && !entry.lease.isCurrent()
                    && entry.client.ownershipHeld()) {
                    entry.state = 'reconnecting';
                    this.#kick(entry);
                }
            }
            if (any) this.#armRoutingCheck();
        }, this.#timing.routingCheckMs);
        this.#routingTimer.unref?.();
    }

    // ---- operations used by the session adapter ----------------------------

    // Retries the same operation id (a fresh evidence token each time, a fresh
    // routing lease) while the launch is only uncertain, the client still holds
    // its ownership and the launch window has not passed. A delivered refusal,
    // a stale administrator lease or any other failure is final.
    async launch(routeKey, fields, lease) {
        const deadline = this.#now() + this.#timing.launchWindowMs;
        let current = lease;
        for (;;) {
            const client = await this.#usable(routeKey);
            try {
                return await client.launch(fields, { lease: current });
            } catch (error) {
                const uncertain = error?.code === 'PROVIDER_TERMINAL_LAUNCH_UNCERTAIN';
                if (!uncertain || this.#closed || !client.ownershipHeld() || this.#now() >= deadline) throw error;
                current = { ...lease, routing: this.routingLease() };
            }
        }
    }

    async attach(routeKey, ptySessionId, options = {}) {
        const client = await this.#usable(routeKey);
        return client.attach(ptySessionId, { lease: this.routingLease(), ...options });
    }

    async input(routeKey, ptySessionId, payload) {
        const client = await this.#usable(routeKey);
        return client.input(ptySessionId, payload, { lease: this.routingLease() });
    }

    async resize(routeKey, ptySessionId, cols, rows) {
        const client = await this.#usable(routeKey);
        return client.resize(ptySessionId, cols, rows, { lease: this.routingLease() });
    }

    async close(routeKey, ptySessionId) {
        const client = await this.#usable(routeKey);
        return client.close(ptySessionId, { lease: this.routingLease() });
    }

    forgetOperation(routeKey, operationId) {
        return this.#entries.get(routeKey)?.client?.forget(operationId) === true;
    }

    // Graceful Router shutdown: every client sends router-shutdown closes and
    // closes locally. The hub accepts no further use.
    async shutdown() {
        this.#closed = true;
        this.#clearTimeout(this.#routingTimer);
        this.#routingTimer = null;
        const clients = [];
        for (const entry of this.#entries.values()) {
            entry.sleeper?.();
            this.#settle(entry, false);
            if (entry.client) clients.push(entry.client);
            entry.client = null;
            entry.state = 'closed';
        }
        await Promise.allSettled(clients.map((client) => client.shutdown()));
        this.#watchers.clear();
    }

    // Test and diagnostics view: state names only, never ownership material.
    status(routeKey) {
        const entry = this.#entries.get(routeKey);
        return entry ? { state: entry.state, hasClient: Boolean(entry.client), failure: entry.failure } : null;
    }
}

export default ProviderTerminalHub;
