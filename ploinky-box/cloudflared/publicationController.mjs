import { readSecretsFile } from '../../cli/utils/security/encryptedSecretsFile.js';
import { createCloudflarePublicationApi } from './cloudflareApi.mjs';
import { createCloudflaredConnector } from './connector.mjs';
import { createCloudflarePublicationJournal } from './journal.mjs';
import { createCloudflareManagedTunnelRegistry } from './managedTunnelRegistry.mjs';
import {
    CLOUDFLARE_TERMINAL_SERVICE,
    CloudflarePublicationError,
    materializeManagedCloudflarePublicationPlan,
    normalizeCloudflarePublicationDesired,
    publicationDigest,
    publicPlanSummary,
    redactCloudflareText,
    stablePublicationJson,
    toPublicationError,
} from './publicationPlan.mjs';

const REQUIRED_API_METHODS = Object.freeze([
    'validateAccountZone',
    'validateScope',
    'listTunnels',
    'createTunnel',
    'getTunnelToken',
    'deleteTunnel',
    'putTunnelIngress',
    'readTunnelIngress',
    'listDnsRecords',
    'createDnsRecord',
    'updateDnsRecord',
    'deleteDnsRecord',
    'listTunnelConnections',
]);

function requireMethods(value, label, methods) {
    for (const method of methods) {
        if (typeof value?.[method] !== 'function') {
            throw new TypeError(`${label} requires ${method}()`);
        }
    }
}

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}

function freezeClone(value) {
    const cloned = cloneJson(value);
    const freeze = (entry) => {
        if (!entry || typeof entry !== 'object' || Object.isFrozen(entry)) return entry;
        for (const child of Object.values(entry)) freeze(child);
        return Object.freeze(entry);
    };
    return freeze(cloned);
}

function sameScope(left, right) {
    return Boolean(left && right
        && left.accountId === right.accountId
        && left.zoneId === right.zoneId
        && left.tunnelId === right.tunnelId);
}

function journalManagedIngressHostnames(journal) {
    if (Array.isArray(journal?.managedIngressHostnames)) {
        return journal.managedIngressHostnames.map(String);
    }
    return Array.isArray(journal?.managedDnsRecords)
        ? journal.managedDnsRecords.map((entry) => String(entry.hostname || '')).filter(Boolean)
        : [];
}

function connectionId(connection) {
    return String(connection?.id || connection?.uuid || connection?.client_id || '').trim();
}

function errorStatus(error, secrets = []) {
    const normalized = toPublicationError(error, { secrets });
    return Object.freeze({
        code: String(normalized.code || 'CLOUDFLARE_PUBLICATION_ERROR'),
        operation: String(normalized.operation || 'publication'),
        message: redactCloudflareText(normalized.message, secrets).slice(0, 1024),
        retryable: normalized.retryable === true,
    });
}

function recordBody(entry) {
    return {
        type: 'CNAME',
        name: entry.hostname,
        content: entry.content,
        ttl: 1,
        proxied: true,
    };
}

function recordMatches(record, expected) {
    return String(record?.type || '').toUpperCase() === 'CNAME'
        && String(record?.name || '').toLowerCase() === expected.hostname
        && String(record?.content || '').toLowerCase() === expected.content.toLowerCase()
        && record?.proxied === true
        && Number(record?.ttl) === 1;
}

function asHostObject(plan) {
    return Object.fromEntries(plan.hosts.map(({ hostname, selector }) => [hostname, cloneJson(selector)]));
}

function ingressHostname(entry) {
    return String(entry?.hostname || '').trim().toLowerCase();
}

function isTerminalIngress(entry) {
    return Boolean(entry && typeof entry === 'object' && !Array.isArray(entry))
        && !String(entry.hostname || '').trim()
        && !String(entry.path || '').trim();
}

function splitTunnelIngress(ingress) {
    if (!Array.isArray(ingress)) {
        throw new CloudflarePublicationError('Cloudflare tunnel ingress is not an array', {
            code: 'CLOUDFLARE_INGRESS_INVALID',
            operation: 'reconcile-ingress',
        });
    }
    if (!ingress.length) {
        return {
            rules: [],
            terminal: { service: CLOUDFLARE_TERMINAL_SERVICE },
        };
    }
    const terminal = ingress.at(-1);
    if (!isTerminalIngress(terminal)
        || ingress.slice(0, -1).some(isTerminalIngress)) {
        throw new CloudflarePublicationError(
            'Cloudflare tunnel ingress must have exactly one terminal catch-all rule at the end',
            {
                code: 'CLOUDFLARE_INGRESS_INVALID',
                operation: 'reconcile-ingress',
            },
        );
    }
    return {
        rules: ingress.slice(0, -1).map(cloneJson),
        terminal: cloneJson(terminal),
    };
}

export function mergeOwnedTunnelIngress({
    installedIngress,
    desiredIngress,
    previouslyManagedHostnames = [],
} = {}) {
    const installed = splitTunnelIngress(installedIngress);
    const desired = splitTunnelIngress(desiredIngress);
    const desiredHostnames = new Set(
        desired.rules.map(ingressHostname).filter(Boolean),
    );
    const ownedHostnames = new Set([
        ...previouslyManagedHostnames.map((hostname) => String(hostname || '').trim().toLowerCase()),
        ...desiredHostnames,
    ].filter(Boolean));
    const preserved = installed.rules.filter((entry) => {
        const hostname = ingressHostname(entry);
        return !hostname || !ownedHostnames.has(hostname);
    });
    return [
        ...preserved,
        ...desired.rules,
        installed.terminal,
    ];
}

function assertNoUnmanagedTunnelRoutes({
    installedIngress,
    desiredIngress,
    previouslyManagedHostnames = [],
} = {}) {
    const installed = splitTunnelIngress(installedIngress);
    const desired = splitTunnelIngress(desiredIngress);
    const ownedHostnames = new Set([
        ...previouslyManagedHostnames,
        ...desired.rules.map(ingressHostname),
    ].map((hostname) => String(hostname || '').trim().toLowerCase()).filter(Boolean));
    const unmanaged = installed.rules.filter((entry) => {
        const hostname = ingressHostname(entry);
        return !hostname || !ownedHostnames.has(hostname);
    });
    if (unmanaged.length) {
        throw new CloudflarePublicationError(
            'Refusing to start an integrated connector on a tunnel with routes not owned by this Ploinky Box; select a dedicated tunnel or migrate every route into this desired state',
            {
                code: 'CLOUDFLARE_SHARED_TUNNEL_UNSAFE',
                operation: 'reconcile-ingress',
            },
        );
    }
}

function journalValue(plan, phase, {
    managedIngressHostnames = plan.hosts?.map((entry) => entry.hostname) || [],
    managedDnsRecords = [],
    ingress = plan.ingress,
    lastError = null,
} = {}) {
    const cloudflare = plan.mode === 'cloudflare' && plan.management === 'api-managed';
    return {
        mode: plan.mode,
        configurationGeneration: plan.configurationGeneration,
        desiredDigest: plan.desiredDigest,
        phase,
        scope: cloudflare ? plan.scope : null,
        ingressDigest: cloudflare ? publicationDigest(ingress) : '',
        managedIngressHostnames: cloudflare ? managedIngressHostnames : [],
        managedDnsRecords: cloudflare ? managedDnsRecords : [],
        lastError,
    };
}

function readSecretStore(secretStore) {
    const secrets = secretStore.readAll();
    if (!secrets || typeof secrets !== 'object' || Array.isArray(secrets)) {
        throw new CloudflarePublicationError('Encrypted secret store is unreadable', {
            code: 'CLOUDFLARE_SECRET_STORE_INVALID',
            operation: 'resolve-secrets',
        });
    }
    return secrets;
}

function resolveConnectorSecret(secretStore, plan) {
    const secrets = readSecretStore(secretStore);
    const tunnelToken = Object.prototype.hasOwnProperty.call(secrets, plan.secretHandles.tunnelToken)
        ? String(secrets[plan.secretHandles.tunnelToken] || '').trim()
        : '';
    if (!tunnelToken) {
        throw new CloudflarePublicationError('Cloudflare connector secret handle is unresolved', {
            code: 'CLOUDFLARE_CONNECTOR_SECRET_UNRESOLVED',
            operation: 'resolve-secrets',
        });
    }
    return tunnelToken;
}

function resolveSecretPair(secretStore, plan) {
    const secrets = readSecretStore(secretStore);
    const tunnelToken = Object.prototype.hasOwnProperty.call(secrets, plan.secretHandles.tunnelToken)
        ? String(secrets[plan.secretHandles.tunnelToken] || '').trim()
        : '';
    const apiToken = Object.prototype.hasOwnProperty.call(secrets, plan.secretHandles.apiToken)
        ? String(secrets[plan.secretHandles.apiToken] || '').trim()
        : '';
    if (!tunnelToken) {
        throw new CloudflarePublicationError('Cloudflare connector secret handle is unresolved', {
            code: 'CLOUDFLARE_CONNECTOR_SECRET_UNRESOLVED',
            operation: 'resolve-secrets',
        });
    }
    if (!apiToken) {
        throw new CloudflarePublicationError('Cloudflare API secret handle is unresolved', {
            code: 'CLOUDFLARE_API_SECRET_UNRESOLVED',
            operation: 'resolve-secrets',
        });
    }
    if (tunnelToken === apiToken) {
        throw new CloudflarePublicationError('Cloudflare connector and API tokens must be distinct credentials', {
            code: 'CLOUDFLARE_SECRET_SEPARATION_REQUIRED',
            operation: 'resolve-secrets',
        });
    }
    return { tunnelToken, apiToken };
}

function resolveApiSecret(secretStore, plan) {
    const secrets = readSecretStore(secretStore);
    const apiToken = Object.prototype.hasOwnProperty.call(secrets, plan.secretHandles.apiToken)
        ? String(secrets[plan.secretHandles.apiToken] || '').trim()
        : '';
    if (!apiToken) {
        throw new CloudflarePublicationError('Cloudflare API secret handle is unresolved', {
            code: 'CLOUDFLARE_API_SECRET_UNRESOLVED',
            operation: 'resolve-secrets',
        });
    }
    return apiToken;
}

async function delay(milliseconds, signal) {
    if (signal?.aborted) throw signal.reason || new Error('aborted');
    await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, milliseconds);
        timer.unref?.();
        const abort = () => {
            clearTimeout(timer);
            reject(signal.reason || new Error('aborted'));
        };
        signal?.addEventListener?.('abort', abort, { once: true });
    });
}

export function createCloudflareConnectorProbe({
    timeoutMs = 30000,
    pollIntervalMs = 500,
} = {}) {
    return async function probeConnector({
        api,
        apiToken,
        scope,
        connector,
        baselineConnectionIds = [],
        signal,
    } = {}) {
        const baseline = new Set(baselineConnectionIds.map(String));
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (!connector.isRunning()) {
                throw new CloudflarePublicationError('cloudflared exited before connector readiness', {
                    code: 'CLOUDFLARED_NOT_RUNNING',
                    operation: 'probe-connector',
                    retryable: true,
                });
            }
            const connections = await api.listTunnelConnections({ apiToken, ...scope, signal });
            const current = connections.map(connectionId).filter(Boolean);
            if (current.some((id) => !baseline.has(id))) return { connectionIds: current };
            await delay(pollIntervalMs, signal);
        }
        throw new CloudflarePublicationError('cloudflared did not establish a new connection to the selected tunnel', {
            code: 'CLOUDFLARED_HEALTH_TIMEOUT',
            operation: 'probe-connector',
            retryable: true,
        });
    };
}

export class CloudflarePublicationController {
    constructor({
        api,
        apiFactory,
        connector,
        journal,
        managedTunnelRegistry,
        secretStore,
        routeCoordinator,
        probeConnector,
        probeHostname,
        publishState = () => {},
        audit = () => {},
        restartPolicy = {},
    } = {}) {
        if (api !== undefined && api !== null) {
            requireMethods(api, 'Cloudflare publication API', REQUIRED_API_METHODS);
        }
        if (!api && typeof apiFactory !== 'function') {
            throw new TypeError('Cloudflare publication requires api or apiFactory()');
        }
        requireMethods(connector, 'cloudflared connector', ['start', 'stop', 'isRunning']);
        requireMethods(journal, 'Cloudflare publication journal', ['read', 'write']);
        requireMethods(managedTunnelRegistry, 'Cloudflare managed tunnel registry', [
            'findDesired',
            'findScope',
            'begin',
            'commit',
            'remove',
        ]);
        requireMethods(secretStore, 'Cloudflare secret store', ['readAll']);
        requireMethods(routeCoordinator, 'Cloudflare route coordinator', ['inactivate', 'commit']);
        if (typeof probeConnector !== 'function') throw new TypeError('Cloudflare publication requires probeConnector()');
        if (typeof probeHostname !== 'function') throw new TypeError('Cloudflare publication requires probeHostname()');
        this.api = api || null;
        this.apiFactory = apiFactory;
        this.connector = connector;
        this.journal = journal;
        this.managedTunnelRegistry = managedTunnelRegistry;
        this.secretStore = secretStore;
        this.routeCoordinator = routeCoordinator;
        this.probeConnector = probeConnector;
        this.probeHostname = probeHostname;
        this.publishState = publishState;
        this.audit = audit;
        this.restartPolicy = {
            maximumRestarts: Math.max(0, Number(restartPolicy.maximumRestarts ?? 5)),
            windowMs: Math.max(1000, Number(restartPolicy.windowMs ?? 60000)),
            initialBackoffMs: Math.max(0, Number(restartPolicy.initialBackoffMs ?? 1000)),
            maximumBackoffMs: Math.max(0, Number(restartPolicy.maximumBackoffMs ?? 30000)),
        };
        this.state = {
            state: 'local-only',
            mode: 'local-only',
            management: null,
            configurationGeneration: '',
            publicationGeneration: 0,
            connectorState: 'absent',
            hostnames: [],
            reconciliation: null,
            error: null,
            retry: null,
            scope: null,
        };
        this.queue = Promise.resolve();
        this.requestRevision = 0;
        this.currentAbort = null;
        this.lastInput = null;
        this.lastApiManagedInput = null;
        this.restartHistory = [];
        this.restartTimer = null;
        this.activeRequest = null;
        this.readyRequestKey = null;
        this.stopped = false;
    }

    getStatus() {
        return freezeClone(this.state);
    }

    requireApi() {
        if (!this.api) {
            this.api = this.apiFactory();
            requireMethods(this.api, 'Cloudflare publication API', REQUIRED_API_METHODS);
        }
        return this.api;
    }

    async ensureManagedTunnel(plan, { apiToken, signal } = {}) {
        const desired = {
            accountId: plan.accountId,
            zoneId: plan.zoneId,
            tunnelName: plan.managedTunnel.name,
            deleteOnTeardown: plan.managedTunnel.deleteOnTeardown,
        };
        let allocation = this.managedTunnelRegistry.begin(desired);
        const candidates = (await this.api.listTunnels({
            apiToken,
            accountId: plan.accountId,
            name: allocation.cloudflareName,
            signal,
        })).filter((tunnel) => (
            String(tunnel?.name || '') === allocation.cloudflareName
            && !tunnel?.deleted_at
        ));
        if (candidates.length > 1) {
            throw new CloudflarePublicationError(
                `Managed tunnel name ${allocation.cloudflareName} resolved ambiguously`,
                {
                    code: 'CLOUDFLARE_MANAGED_TUNNEL_AMBIGUOUS',
                    operation: 'resolve-managed-tunnel',
                },
            );
        }
        let tunnel = candidates[0] || null;
        if (allocation.tunnelId && tunnel
            && String(tunnel.id || '') !== allocation.tunnelId) {
            throw new CloudflarePublicationError(
                'Cloudflare managed tunnel identity changed outside Ploinky',
                {
                    code: 'CLOUDFLARE_MANAGED_TUNNEL_OWNERSHIP_LOST',
                    operation: 'resolve-managed-tunnel',
                },
            );
        }
        if (allocation.tunnelId && !tunnel) {
            throw new CloudflarePublicationError(
                'Cloudflare managed tunnel no longer exists under its Ploinky ownership record',
                {
                    code: 'CLOUDFLARE_MANAGED_TUNNEL_OWNERSHIP_LOST',
                    operation: 'resolve-managed-tunnel',
                },
            );
        }
        if (!tunnel) {
            tunnel = await this.api.createTunnel({
                apiToken,
                accountId: plan.accountId,
                name: allocation.cloudflareName,
                signal,
            });
        }
        const tunnelId = String(tunnel?.id || '').trim();
        const accountId = String(tunnel?.account_tag || plan.accountId);
        const configSource = String(tunnel?.config_src || '').trim();
        if (!tunnelId
            || accountId !== plan.accountId
            || String(tunnel?.name || '') !== allocation.cloudflareName
            || tunnel?.deleted_at
            || (configSource && configSource !== 'cloudflare')
            || (!configSource && tunnel?.remote_config === false)) {
            throw new CloudflarePublicationError(
                'Cloudflare returned an invalid managed tunnel allocation',
                {
                    code: 'CLOUDFLARE_MANAGED_TUNNEL_INVALID',
                    operation: 'resolve-managed-tunnel',
                },
            );
        }
        allocation = this.managedTunnelRegistry.commit({
            ownershipId: allocation.ownershipId,
            tunnelId,
        });
        const tunnelToken = await this.api.getTunnelToken({
            apiToken,
            accountId: plan.accountId,
            tunnelId,
            signal,
        });
        this.safeAudit('cloudflare-managed-tunnel-ready', {
            accountId: plan.accountId,
            zoneId: plan.zoneId,
            tunnelId,
            tunnelName: allocation.cloudflareName,
            created: candidates.length === 0,
        });
        return {
            allocation,
            plan: materializeManagedCloudflarePublicationPlan(plan, tunnelId),
            tunnelToken,
        };
    }

    materializeManagedTeardown(plan, currentJournal) {
        let allocation = this.managedTunnelRegistry.findDesired({
            accountId: plan.accountId,
            zoneId: plan.zoneId,
            tunnelName: plan.managedTunnel.name,
        });
        if (!allocation?.tunnelId) {
            if (currentJournal?.mode !== 'cloudflare') return plan;
            throw new CloudflarePublicationError(
                'Managed tunnel teardown requires the exact Ploinky ownership record',
                {
                    code: 'CLOUDFLARE_MANAGED_TUNNEL_OWNERSHIP_REQUIRED',
                    operation: 'resolve-managed-tunnel',
                },
            );
        }
        if (currentJournal?.mode === 'cloudflare'
            && (allocation.tunnelId !== currentJournal.scope?.tunnelId
                || allocation.accountId !== currentJournal.scope?.accountId
                || allocation.zoneId !== currentJournal.scope?.zoneId)) {
            throw new CloudflarePublicationError(
                'Managed tunnel teardown does not match the selected Cloudflare scope',
                {
                    code: 'CLOUDFLARE_MANAGED_TUNNEL_OWNERSHIP_REQUIRED',
                    operation: 'resolve-managed-tunnel',
                },
            );
        }
        allocation = this.managedTunnelRegistry.begin({
            accountId: plan.accountId,
            zoneId: plan.zoneId,
            tunnelName: plan.managedTunnel.name,
            deleteOnTeardown: plan.managedTunnel.deleteOnTeardown,
        });
        return materializeManagedCloudflarePublicationPlan(plan, allocation.tunnelId);
    }

    async deleteManagedTunnelIfOwned({ scope, apiToken, signal } = {}) {
        const allocation = this.managedTunnelRegistry.findScope(scope);
        if (!allocation?.deleteOnTeardown) return false;
        const candidates = (await this.api.listTunnels({
            apiToken,
            accountId: scope.accountId,
            name: allocation.cloudflareName,
            signal,
        })).filter((tunnel) => (
            String(tunnel?.name || '') === allocation.cloudflareName
            && !tunnel?.deleted_at
        ));
        if (candidates.length > 1
            || (candidates.length === 1 && String(candidates[0]?.id || '') !== allocation.tunnelId)) {
            throw new CloudflarePublicationError(
                'Refusing to delete a managed tunnel after Cloudflare ownership changed',
                {
                    code: 'CLOUDFLARE_MANAGED_TUNNEL_OWNERSHIP_LOST',
                    operation: 'delete-managed-tunnel',
                },
            );
        }
        if (candidates.length === 1) {
            await this.api.deleteTunnel({
                apiToken,
                accountId: scope.accountId,
                tunnelId: allocation.tunnelId,
                signal,
            });
        }
        const remaining = (await this.api.listTunnels({
            apiToken,
            accountId: scope.accountId,
            name: allocation.cloudflareName,
            signal,
        })).filter((tunnel) => (
            String(tunnel?.name || '') === allocation.cloudflareName
            && !tunnel?.deleted_at
        ));
        if (remaining.length) {
            throw new CloudflarePublicationError(
                'Cloudflare managed tunnel deletion did not verify',
                {
                    code: 'CLOUDFLARE_MANAGED_TUNNEL_DELETE_UNVERIFIED',
                    operation: 'delete-managed-tunnel',
                    retryable: true,
                },
            );
        }
        this.managedTunnelRegistry.remove({
            ownershipId: allocation.ownershipId,
            tunnelId: allocation.tunnelId,
        });
        this.safeAudit('cloudflare-managed-tunnel-deleted', {
            accountId: allocation.accountId,
            zoneId: allocation.zoneId,
            tunnelId: allocation.tunnelId,
            tunnelName: allocation.cloudflareName,
        });
        return true;
    }

    async transition(patch) {
        this.state = {
            ...this.state,
            ...cloneJson(patch),
            publicationGeneration: this.state.publicationGeneration + 1,
        };
        const snapshot = this.getStatus();
        await this.publishState(snapshot);
        return snapshot;
    }

    safeAudit(event, value = {}) {
        try { this.audit(String(event), freezeClone(value)); } catch (_) {}
    }

    reconcile(input = {}, { reason = 'coordinated-apply' } = {}) {
        if (this.stopped) {
            return Promise.reject(new CloudflarePublicationError('Cloudflare publication controller is stopped', {
                code: 'CLOUDFLARE_CONTROLLER_STOPPED',
                operation: 'reconcile',
            }));
        }
        const captured = cloneJson(input);
        let requestKey = null;
        let requestPlan = null;
        try {
            requestPlan = normalizeCloudflarePublicationDesired(captured);
            requestKey = `${requestPlan.configurationGeneration}:${requestPlan.desiredDigest}`;
        } catch (_) {}
        if (requestKey && this.activeRequest?.key === requestKey) {
            this.safeAudit('cloudflare-reconcile-coalesced', {
                configurationGeneration: String(captured.configurationGeneration || ''),
                reason,
            });
            return this.activeRequest.promise;
        }
        const selectedGenerationRequest = reason === 'selected-edge-generation'
            || reason === 'selected-edge-generation-retry';
        if (requestKey
            && selectedGenerationRequest
            && this.readyRequestKey === requestKey
            && this.state.state === 'ready'
            && this.state.connectorState === 'running'
            && this.connector.isRunning()) {
            const run = this.queue.then(async () => {
                if (this.readyRequestKey !== requestKey
                    || this.state.state !== 'ready'
                    || this.state.connectorState !== 'running'
                    || !this.connector.isRunning()) {
                    throw new CloudflarePublicationError(
                        'Exact ready Cloudflare publication changed before route adoption',
                        {
                            code: 'CLOUDFLARE_RECONCILIATION_SUPERSEDED',
                            operation: 'adopt-ready-route',
                            retryable: true,
                        },
                    );
                }
                await this.routeCoordinator.commit({
                    mode: 'cloudflare',
                    publicationState: 'ready',
                    configurationGeneration: requestPlan.configurationGeneration,
                    hosts: asHostObject(requestPlan),
                    canonicalScheme: 'https',
                });
                if (this.readyRequestKey !== requestKey
                    || this.state.state !== 'ready'
                    || this.state.connectorState !== 'running'
                    || !this.connector.isRunning()) {
                    await this.inactivate(captured, 'cloudflared-exit-during-route-adoption');
                    throw new CloudflarePublicationError(
                        'Cloudflare connector changed during exact ready route adoption',
                        {
                            code: 'CLOUDFLARED_NOT_RUNNING',
                            operation: 'adopt-ready-route',
                            retryable: true,
                        },
                    );
                }
                this.safeAudit('cloudflare-reconcile-adopted-ready', {
                    configurationGeneration: String(captured.configurationGeneration || ''),
                    reason,
                });
                return this.getStatus();
            });
            this.queue = run.catch(() => {});
            this.activeRequest = { key: requestKey, promise: run };
            const clearActiveRequest = () => {
                if (this.activeRequest?.promise === run) this.activeRequest = null;
            };
            run.then(clearActiveRequest, clearActiveRequest);
            return run;
        }
        const revision = ++this.requestRevision;
        this.currentAbort?.abort(new CloudflarePublicationError('Cloudflare publication was superseded', {
            code: 'CLOUDFLARE_RECONCILIATION_SUPERSEDED',
            operation: 'reconcile',
        }));
        const run = this.queue.then(() => this.runReconcile(captured, { revision, reason }));
        this.queue = run.catch(() => {});
        if (requestKey) this.activeRequest = { key: requestKey, promise: run };
        run.then(
            (status) => {
                if (requestKey && status?.state === 'ready' && status?.connectorState === 'running') {
                    this.readyRequestKey = requestKey;
                }
                if (this.activeRequest?.promise === run) this.activeRequest = null;
            },
            () => {
                if (this.activeRequest?.promise === run) this.activeRequest = null;
            },
        );
        return run;
    }

    async retry() {
        if (!this.lastInput) {
            throw new CloudflarePublicationError('No selected Cloudflare state is available to retry', {
                code: 'CLOUDFLARE_RETRY_UNAVAILABLE',
                operation: 'retry',
            });
        }
        return this.reconcile(this.lastInput, { reason: 'selected-state-retry' });
    }

    assertCurrent(revision, signal) {
        if (signal?.aborted || revision !== this.requestRevision) {
            throw new CloudflarePublicationError('Cloudflare publication was superseded before activation', {
                code: 'CLOUDFLARE_RECONCILIATION_SUPERSEDED',
                operation: 'reconcile',
            });
        }
    }

    async inactivate(input, reason) {
        await this.routeCoordinator.inactivate({
            configurationGeneration: String(input?.configurationGeneration || ''),
            reason,
        });
    }

    async runReconcile(input, { revision, reason }) {
        const abortController = new AbortController();
        this.currentAbort = abortController;
        let plan = null;
        let secretPair = null;
        let managedIngressHostnames = [];
        let managedDnsRecords = [];
        let reconciledIngress = null;
        let currentJournal = null;
        let adoptSelectedLocalState = false;
        await this.connector.stop('reconcile');
        try {
            plan = normalizeCloudflarePublicationDesired(input);
            currentJournal = this.journal.read();
            adoptSelectedLocalState = plan.mode === 'local-only'
                && input?.selectedPublicationState === 'ready'
                && currentJournal?.mode !== 'cloudflare';
            // A coordinated edge apply already commits local-only generations
            // as ready. Re-applying that same generation from the Router
            // process races normal agent enable operations and does not publish
            // anything. Adopt it only when there is no prior Cloudflare scope
            // to tear down; every Cloudflare transition still inactivates first.
            if (!adoptSelectedLocalState) await this.inactivate(input, reason);
            this.lastInput = cloneJson(input);
            if (plan.tunnelManagement === 'ploinky-managed') {
                const apiToken = resolveApiSecret(this.secretStore, plan);
                const api = this.requireApi();
                const signal = abortController.signal;
                secretPair = { apiToken };
                await api.validateAccountZone({
                    apiToken,
                    accountId: plan.accountId,
                    zoneId: plan.zoneId,
                    signal,
                });
                if (plan.mode === 'cloudflare') {
                    const managed = await this.ensureManagedTunnel(plan, { apiToken, signal });
                    plan = managed.plan;
                    secretPair = { apiToken, tunnelToken: managed.tunnelToken };
                } else {
                    plan = this.materializeManagedTeardown(plan, currentJournal);
                }
            }
            const summary = publicPlanSummary(plan);
            managedDnsRecords = plan.management === 'api-managed'
                && sameScope(currentJournal?.scope, plan.scope)
                ? currentJournal.managedDnsRecords.map((entry) => ({ ...entry }))
                : [];
            managedIngressHostnames = plan.management === 'api-managed'
                && sameScope(currentJournal?.scope, plan.scope)
                ? journalManagedIngressHostnames(currentJournal)
                : [];
            if (plan.mode === 'local-only') {
                if (currentJournal?.mode === 'cloudflare') {
                    let previousPlan;
                    try {
                        previousPlan = plan.tunnelManagement === 'ploinky-managed' && plan.scope
                            ? plan
                            : normalizeCloudflarePublicationDesired(
                                this.lastApiManagedInput || input || {},
                            );
                    } catch (_) {
                        previousPlan = null;
                    }
                    if (previousPlan?.management !== 'api-managed'
                        || !sameScope(previousPlan.scope, currentJournal.scope)) {
                        throw new CloudflarePublicationError(
                            'Local-only activation requires the previously selected Cloudflare credential handles until owned ingress and DNS teardown verifies; reselect the prior Cloudflare state and retry removal',
                            {
                                code: 'CLOUDFLARE_TEARDOWN_CREDENTIALS_REQUIRED',
                                operation: 'clear-final-host',
                            },
                        );
                    }
                    if (previousPlan.tunnelManagement !== 'ploinky-managed') {
                        secretPair = resolveSecretPair(this.secretStore, previousPlan);
                    }
                    this.requireApi();
                    await this.clearPreviousScope({
                        previous: currentJournal,
                        apiToken: secretPair.apiToken,
                        signal: abortController.signal,
                        revision,
                    });
                    currentJournal = this.journal.read();
                    if (currentJournal?.mode !== 'cloudflare'
                        || currentJournal.managedDnsRecords.length !== 0) {
                        throw new CloudflarePublicationError('Final Cloudflare hostname teardown did not converge', {
                            code: 'CLOUDFLARE_FINAL_HOST_NOT_CLEARED',
                            operation: 'clear-final-host',
                            retryable: true,
                        });
                    }
                }
                this.assertCurrent(revision, abortController.signal);
                if (!adoptSelectedLocalState) {
                    await this.routeCoordinator.commit({
                        mode: 'local-only',
                        publicationState: 'ready',
                        configurationGeneration: plan.configurationGeneration,
                        hosts: {},
                        canonicalScheme: 'http',
                    });
                }
                currentJournal = this.journal.write(journalValue(plan, 'local-only'));
                if (plan.tunnelManagement === 'ploinky-managed' && plan.scope) {
                    await this.deleteManagedTunnelIfOwned({
                        scope: plan.scope,
                        apiToken: secretPair.apiToken,
                        signal: abortController.signal,
                    });
                }
                this.lastApiManagedInput = null;
                this.safeAudit('cloudflare-local-only', summary);
                return this.transition({
                    state: 'local-only',
                    mode: 'local-only',
                    management: null,
                    configurationGeneration: plan.configurationGeneration,
                    connectorState: 'absent',
                    hostnames: [],
                    reconciliation: { desiredDigest: plan.desiredDigest, phase: 'local-only' },
                    error: null,
                    retry: null,
                    scope: null,
                });
            }

            if (plan.management === 'connector-only') {
                if (currentJournal?.mode === 'cloudflare') {
                    throw new CloudflarePublicationError(
                        'Direct API-managed to connector-only transition is unsafe while Ploinky-owned Cloudflare resources remain; apply local-only first -> verify API-managed teardown -> apply connector-only',
                        {
                            code: 'CLOUDFLARE_MANAGEMENT_TRANSITION_UNSAFE',
                            operation: 'transition-management',
                        },
                    );
                }
                const signal = abortController.signal;
                await this.transition({
                    state: 'reconciling',
                    mode: 'cloudflare',
                    management: 'connector-only',
                    configurationGeneration: plan.configurationGeneration,
                    connectorState: 'stopped',
                    hostnames: plan.hosts.map((entry) => entry.hostname),
                    scope: null,
                    reconciliation: { desiredDigest: plan.desiredDigest, phase: 'routes-committing' },
                    error: null,
                    retry: null,
                });
                this.assertCurrent(revision, signal);
                await this.routeCoordinator.commit({
                    mode: 'cloudflare',
                    publicationState: 'reconciling',
                    configurationGeneration: plan.configurationGeneration,
                    hosts: asHostObject(plan),
                    canonicalScheme: 'https',
                });
                this.assertCurrent(revision, signal);
                const tunnelToken = resolveConnectorSecret(this.secretStore, plan);
                secretPair = { tunnelToken };
                await this.transition({
                    connectorState: 'starting',
                    reconciliation: { desiredDigest: plan.desiredDigest, phase: 'connector-starting' },
                });
                await this.connector.start({
                    tunnelToken,
                    onExit: (event) => { void this.onConnectorExit(event, revision); },
                    onOutput: ({ stream, message }) => this.safeAudit('cloudflared-output', { stream, message }),
                });
                if (!this.connector.isRunning()) {
                    throw new CloudflarePublicationError('cloudflared exited during readiness verification', {
                        code: 'CLOUDFLARED_NOT_RUNNING',
                        operation: 'probe-connector',
                        retryable: true,
                    });
                }
                for (const host of plan.hosts) {
                    const proof = await this.probeHostname({
                        hostname: host.hostname,
                        selector: cloneJson(host.selector),
                        canonicalScheme: 'https',
                        configurationGeneration: plan.configurationGeneration,
                        connector: this.connector,
                        signal,
                    });
                    if (!proof || proof.ok !== true) {
                        if (!this.connector.isRunning()) {
                            throw new CloudflarePublicationError('cloudflared exited during hostname verification', {
                                code: 'CLOUDFLARED_NOT_RUNNING',
                                operation: 'probe-hostname',
                                retryable: true,
                            });
                        }
                        throw new CloudflarePublicationError(`External route probe failed for ${host.hostname}`, {
                            code: 'CLOUDFLARE_HOST_PROBE_FAILED',
                            operation: 'probe-hostname',
                            retryable: true,
                        });
                    }
                }
                if (!this.connector.isRunning()) {
                    throw new CloudflarePublicationError('cloudflared exited during readiness verification', {
                        code: 'CLOUDFLARED_NOT_RUNNING',
                        operation: 'probe-hostname',
                        retryable: true,
                    });
                }
                this.assertCurrent(revision, signal);
                await this.routeCoordinator.commit({
                    mode: 'cloudflare',
                    publicationState: 'ready',
                    configurationGeneration: plan.configurationGeneration,
                    hosts: asHostObject(plan),
                    canonicalScheme: 'https',
                });
                this.assertCurrent(revision, signal);
                this.safeAudit('ready', summary);
                return this.transition({
                    state: 'ready',
                    mode: 'cloudflare',
                    management: 'connector-only',
                    connectorState: 'running',
                    reconciliation: { desiredDigest: plan.desiredDigest, phase: 'ready' },
                    error: null,
                    retry: null,
                    scope: null,
                });
            }

            this.lastApiManagedInput = cloneJson(input);
            await this.transition({
                state: 'reconciling',
                mode: 'cloudflare',
                management: 'api-managed',
                configurationGeneration: plan.configurationGeneration,
                connectorState: 'stopped',
                hostnames: plan.hosts.map((entry) => entry.hostname),
                scope: { ...plan.scope },
                reconciliation: { desiredDigest: plan.desiredDigest, phase: 'validate' },
                error: null,
                retry: null,
            });
            if (plan.tunnelManagement !== 'ploinky-managed') {
                secretPair = resolveSecretPair(this.secretStore, plan);
            }
            const { apiToken, tunnelToken } = secretPair;
            const signal = abortController.signal;
            this.assertCurrent(revision, signal);
            const api = this.requireApi();
            await api.validateScope({ apiToken, ...plan.scope, signal });
            if (currentJournal?.mode === 'cloudflare'
                && !sameScope(currentJournal.scope, plan.scope)) {
                await this.clearPreviousScope({
                    previous: currentJournal,
                    apiToken,
                    signal,
                    revision,
                });
                currentJournal = this.journal.read();
            }
            managedDnsRecords = sameScope(currentJournal?.scope, plan.scope)
                ? currentJournal.managedDnsRecords.map((entry) => ({ ...entry }))
                : [];
            managedIngressHostnames = sameScope(currentJournal?.scope, plan.scope)
                ? journalManagedIngressHostnames(currentJournal)
                : [];
            const installedIngress = await api.readTunnelIngress({
                apiToken,
                ...plan.scope,
                signal,
            });
            assertNoUnmanagedTunnelRoutes({
                installedIngress,
                desiredIngress: plan.ingress,
                previouslyManagedHostnames: managedIngressHostnames,
            });
            reconciledIngress = mergeOwnedTunnelIngress({
                installedIngress,
                desiredIngress: plan.ingress,
                previouslyManagedHostnames: managedIngressHostnames,
            });
            managedIngressHostnames = plan.hosts.map((entry) => entry.hostname);
            this.journal.write(journalValue(plan, 'prepared', {
                managedIngressHostnames,
                managedDnsRecords,
                ingress: reconciledIngress,
            }));
            await api.putTunnelIngress({
                apiToken,
                ...plan.scope,
                ingress: reconciledIngress,
                signal,
            });
            this.assertCurrent(revision, signal);
            this.journal.write(journalValue(plan, 'ingress-applied', {
                managedIngressHostnames,
                managedDnsRecords,
                ingress: reconciledIngress,
            }));

            for (const dns of plan.dns) {
                const existingManaged = managedDnsRecords.find((entry) => entry.hostname === dns.hostname) || null;
                const saved = await this.upsertDns({ dns, existingManaged, apiToken, scope: plan.scope, signal });
                managedDnsRecords = [
                    ...managedDnsRecords.filter((entry) => entry.hostname !== dns.hostname),
                    saved,
                ].sort((left, right) => left.hostname.localeCompare(right.hostname));
                this.journal.write(journalValue(plan, 'ingress-applied', {
                    managedIngressHostnames,
                    managedDnsRecords,
                    ingress: reconciledIngress,
                }));
            }
            const desiredHostnames = new Set(plan.dns.map((entry) => entry.hostname));
            for (const stale of managedDnsRecords.filter((entry) => !desiredHostnames.has(entry.hostname))) {
                await this.removeOwnedDns({ record: stale, apiToken, signal });
                managedDnsRecords = managedDnsRecords.filter((entry) => entry.hostname !== stale.hostname);
                this.journal.write(journalValue(plan, 'ingress-applied', {
                    managedIngressHostnames,
                    managedDnsRecords,
                    ingress: reconciledIngress,
                }));
            }
            this.journal.write(journalValue(plan, 'dns-reconciled', {
                managedIngressHostnames,
                managedDnsRecords,
                ingress: reconciledIngress,
            }));
            await this.verifyRemote({
                plan,
                apiToken,
                managedDnsRecords,
                expectedIngress: reconciledIngress,
                signal,
            });
            this.assertCurrent(revision, signal);
            this.journal.write(journalValue(plan, 'remote-verified', {
                managedIngressHostnames,
                managedDnsRecords,
                ingress: reconciledIngress,
            }));

            await this.routeCoordinator.commit({
                mode: 'cloudflare',
                publicationState: 'reconciling',
                configurationGeneration: plan.configurationGeneration,
                hosts: asHostObject(plan),
                canonicalScheme: 'https',
            });
            this.assertCurrent(revision, signal);
            this.journal.write(journalValue(plan, 'routes-committed', {
                managedIngressHostnames,
                managedDnsRecords,
                ingress: reconciledIngress,
            }));

            const baselineConnections = await api.listTunnelConnections({ apiToken, ...plan.scope, signal });
            const baselineConnectionIds = baselineConnections.map(connectionId).filter(Boolean);
            this.journal.write(journalValue(plan, 'connector-starting', {
                managedIngressHostnames,
                managedDnsRecords,
                ingress: reconciledIngress,
            }));
            await this.transition({
                connectorState: 'starting',
                reconciliation: { desiredDigest: plan.desiredDigest, phase: 'connector-starting' },
            });
            await this.connector.start({
                tunnelToken,
                onExit: (event) => { void this.onConnectorExit(event, revision); },
                onOutput: ({ stream, message }) => this.safeAudit('cloudflared-output', { stream, message }),
            });
            await this.probeConnector({
                api,
                apiToken,
                scope: plan.scope,
                connector: this.connector,
                baselineConnectionIds,
                signal,
            });
            if (!this.connector.isRunning()) {
                throw new CloudflarePublicationError('cloudflared exited during readiness verification', {
                    code: 'CLOUDFLARED_NOT_RUNNING',
                    operation: 'probe-connector',
                    retryable: true,
                });
            }
            for (const host of plan.hosts) {
                const proof = await this.probeHostname({
                    hostname: host.hostname,
                    selector: cloneJson(host.selector),
                    canonicalScheme: 'https',
                    configurationGeneration: plan.configurationGeneration,
                    connector: this.connector,
                    signal,
                });
                if (!proof || proof.ok !== true) {
                    if (!this.connector.isRunning()) {
                        throw new CloudflarePublicationError('cloudflared exited during hostname verification', {
                            code: 'CLOUDFLARED_NOT_RUNNING',
                            operation: 'probe-hostname',
                            retryable: true,
                        });
                    }
                    throw new CloudflarePublicationError(`External route probe failed for ${host.hostname}`, {
                        code: 'CLOUDFLARE_HOST_PROBE_FAILED',
                        operation: 'probe-hostname',
                        retryable: true,
                    });
                }
            }
            if (!this.connector.isRunning()) {
                throw new CloudflarePublicationError('cloudflared exited during readiness verification', {
                    code: 'CLOUDFLARED_NOT_RUNNING',
                    operation: 'probe-hostname',
                    retryable: true,
                });
            }
            this.assertCurrent(revision, signal);
            await this.routeCoordinator.commit({
                mode: 'cloudflare',
                publicationState: 'ready',
                configurationGeneration: plan.configurationGeneration,
                hosts: asHostObject(plan),
                canonicalScheme: 'https',
            });
            this.assertCurrent(revision, signal);
            this.journal.write(journalValue(plan, 'ready', {
                managedIngressHostnames,
                managedDnsRecords,
                ingress: reconciledIngress,
            }));
            this.safeAudit('ready', summary);
            return await this.transition({
                state: 'ready',
                mode: 'cloudflare',
                management: 'api-managed',
                connectorState: 'running',
                reconciliation: { desiredDigest: plan.desiredDigest, phase: 'ready' },
                error: null,
                retry: null,
            });
        } catch (error) {
            await this.connector.stop('error');
            try {
                await this.inactivate(input, 'cloudflare-error');
                if (plan?.management === 'connector-only') {
                    this.assertCurrent(revision, abortController.signal);
                    await this.routeCoordinator.commit({
                        mode: 'cloudflare',
                        publicationState: 'error',
                        configurationGeneration: plan.configurationGeneration,
                        hosts: asHostObject(plan),
                        canonicalScheme: 'https',
                    });
                }
            } catch (_) {}
            const statusError = errorStatus(error, secretPair ? Object.values(secretPair) : []);
            if (plan?.mode === 'local-only' && currentJournal?.mode === 'cloudflare') {
                try {
                    // A final-host teardown journals each verified DNS deletion.
                    // Preserve that newest reduced ownership set if a later
                    // deletion fails; rewriting the pre-loop snapshot would
                    // falsely reclaim records that were already removed.
                    let preservedJournal = currentJournal;
                    try {
                        const latestJournal = this.journal.read();
                        if (latestJournal?.mode === 'cloudflare'
                            && sameScope(latestJournal.scope, currentJournal.scope)) {
                            preservedJournal = latestJournal;
                        }
                    } catch (_) {}
                    this.journal.write({
                        ...preservedJournal,
                        phase: 'error',
                        managedDnsRecords: preservedJournal.managedDnsRecords,
                        lastError: statusError,
                    });
                } catch (_) {}
            } else if (plan?.management === 'api-managed') {
                try {
                    this.journal.write(journalValue(plan, 'error', {
                        managedIngressHostnames,
                        managedDnsRecords,
                        ...(reconciledIngress ? { ingress: reconciledIngress } : {}),
                        lastError: statusError,
                    }));
                } catch (_) {}
            } else if (!plan && currentJournal) {
                try {
                    this.journal.write({
                        ...currentJournal,
                        phase: 'error',
                        lastError: statusError,
                    });
                } catch (_) {}
            }
            this.safeAudit('cloudflare-error', statusError);
            if (revision === this.requestRevision) {
                await this.transition({
                    state: 'error',
                    mode: plan?.mode || 'invalid',
                    management: plan?.management || null,
                    configurationGeneration: String(plan?.configurationGeneration || input?.configurationGeneration || ''),
                    connectorState: 'stopped',
                    hostnames: plan?.hosts?.map((entry) => entry.hostname) || [],
                    reconciliation: plan ? { desiredDigest: plan.desiredDigest, phase: 'error' } : null,
                    error: statusError,
                    retry: null,
                    scope: plan?.scope ? { ...plan.scope } : null,
                });
            }
            throw toPublicationError(error, { secrets: secretPair ? Object.values(secretPair) : [] });
        } finally {
            if (this.currentAbort === abortController) this.currentAbort = null;
            secretPair = null;
        }
    }

    async upsertDns({ dns, existingManaged, apiToken, scope, signal }) {
        const records = await this.api.listDnsRecords({ apiToken, zoneId: scope.zoneId, hostname: dns.hostname, signal });
        if (records.length > 1) {
            throw new CloudflarePublicationError(`DNS name ${dns.hostname} has ambiguous existing records`, {
                code: 'CLOUDFLARE_DNS_AMBIGUOUS',
                operation: 'reconcile-dns',
            });
        }
        const existing = records[0] || null;
        if (existing && String(existing.type || '').toUpperCase() !== 'CNAME') {
            throw new CloudflarePublicationError(`DNS name ${dns.hostname} is owned by a non-CNAME record`, {
                code: 'CLOUDFLARE_DNS_CONFLICT',
                operation: 'reconcile-dns',
            });
        }
        if (existingManaged && existing && String(existing.id || '') !== existingManaged.recordId) {
            throw new CloudflarePublicationError(`DNS ownership changed for ${dns.hostname}`, {
                code: 'CLOUDFLARE_DNS_OWNERSHIP_LOST',
                operation: 'reconcile-dns',
            });
        }
        const result = existing
            ? await this.api.updateDnsRecord({
                apiToken,
                zoneId: scope.zoneId,
                recordId: existing.id,
                record: recordBody(dns),
                signal,
            })
            : await this.api.createDnsRecord({
                apiToken,
                zoneId: scope.zoneId,
                record: recordBody(dns),
                signal,
            });
        const recordId = String(result?.id || existing?.id || '').trim();
        if (!recordId) {
            throw new CloudflarePublicationError(`Cloudflare returned no DNS record id for ${dns.hostname}`, {
                code: 'CLOUDFLARE_DNS_RESULT_INVALID',
                operation: 'reconcile-dns',
            });
        }
        return {
            hostname: dns.hostname,
            recordId,
            zoneId: scope.zoneId,
            content: dns.content,
        };
    }

    async removeOwnedDns({ record, apiToken, signal }) {
        const records = await this.api.listDnsRecords({
            apiToken,
            zoneId: record.zoneId,
            hostname: record.hostname,
            signal,
        });
        if (!records.length) return;
        const owned = records.find((entry) => String(entry?.id || '') === record.recordId);
        if (!owned || records.length !== 1 || !recordMatches(owned, {
            hostname: record.hostname,
            content: record.content,
        })) {
            throw new CloudflarePublicationError(`Refusing to delete changed DNS ownership for ${record.hostname}`, {
                code: 'CLOUDFLARE_DNS_OWNERSHIP_LOST',
                operation: 'remove-dns-record',
            });
        }
        await this.api.deleteDnsRecord({
            apiToken,
            zoneId: record.zoneId,
            recordId: record.recordId,
            signal,
        });
        const remaining = await this.api.listDnsRecords({
            apiToken,
            zoneId: record.zoneId,
            hostname: record.hostname,
            signal,
        });
        if (remaining.some((entry) => String(entry?.id || '') === record.recordId)) {
            throw new CloudflarePublicationError(`Cloudflare did not remove DNS record ${record.hostname}`, {
                code: 'CLOUDFLARE_DNS_REMOVE_UNVERIFIED',
                operation: 'remove-dns-record',
                retryable: true,
            });
        }
    }

    async clearPreviousScope({ previous, apiToken, signal, revision }) {
        await this.api.validateScope({ apiToken, ...previous.scope, signal });
        const installedBefore = await this.api.readTunnelIngress({
            apiToken,
            ...previous.scope,
            signal,
        });
        const clearedIngress = mergeOwnedTunnelIngress({
            installedIngress: installedBefore,
            desiredIngress: [{ service: CLOUDFLARE_TERMINAL_SERVICE }],
            previouslyManagedHostnames: journalManagedIngressHostnames(previous),
        });
        await this.api.putTunnelIngress({
            apiToken,
            ...previous.scope,
            ingress: clearedIngress,
            signal,
        });
        const installed = await this.api.readTunnelIngress({ apiToken, ...previous.scope, signal });
        if (stablePublicationJson(installed) !== stablePublicationJson(clearedIngress)) {
            throw new CloudflarePublicationError('Previous tunnel ingress teardown did not verify', {
                code: 'CLOUDFLARE_PREVIOUS_SCOPE_NOT_CLEARED',
                operation: 'clear-previous-scope',
                retryable: true,
            });
        }
        let remaining = previous.managedDnsRecords.map((entry) => ({ ...entry }));
        for (const record of [...remaining]) {
            await this.removeOwnedDns({ record, apiToken, signal });
            remaining = remaining.filter((entry) => entry.hostname !== record.hostname);
            this.journal.write({
                ...previous,
                phase: 'previous-scope-cleared',
                ingressDigest: publicationDigest(clearedIngress),
                managedIngressHostnames: [],
                managedDnsRecords: remaining,
                lastError: null,
            });
        }
        this.assertCurrent(revision, signal);
    }

    async verifyRemote({
        plan,
        apiToken,
        managedDnsRecords,
        expectedIngress = plan.ingress,
        signal,
    }) {
        const installedIngress = await this.api.readTunnelIngress({ apiToken, ...plan.scope, signal });
        if (stablePublicationJson(installedIngress) !== stablePublicationJson(expectedIngress)) {
            throw new CloudflarePublicationError('Cloudflare tunnel ingress does not match the selected desired state', {
                code: 'CLOUDFLARE_INGRESS_MISMATCH',
                operation: 'verify-remote',
                retryable: true,
            });
        }
        for (const dns of plan.dns) {
            const records = await this.api.listDnsRecords({ apiToken, zoneId: plan.scope.zoneId, hostname: dns.hostname, signal });
            const managed = managedDnsRecords.find((entry) => entry.hostname === dns.hostname);
            if (records.length !== 1
                || !managed
                || String(records[0]?.id || '') !== managed.recordId
                || !recordMatches(records[0], dns)) {
                throw new CloudflarePublicationError(`Cloudflare DNS does not match selected hostname ${dns.hostname}`, {
                    code: 'CLOUDFLARE_DNS_MISMATCH',
                    operation: 'verify-remote',
                    retryable: true,
                });
            }
        }
    }

    async onConnectorExit(event, revision) {
        if (event?.intentional || this.stopped || revision !== this.requestRevision) return;
        if (this.state.state !== 'ready') return;
        let plan = null;
        try { plan = normalizeCloudflarePublicationDesired(this.lastInput); } catch (_) {}
        if (plan?.tunnelManagement === 'ploinky-managed') {
            try {
                const allocation = this.managedTunnelRegistry.findDesired({
                    accountId: plan.accountId,
                    zoneId: plan.zoneId,
                    tunnelName: plan.managedTunnel.name,
                });
                if (allocation?.tunnelId) {
                    plan = materializeManagedCloudflarePublicationPlan(plan, allocation.tunnelId);
                }
            } catch (_) {}
        }
        try {
            await this.inactivate(this.lastInput, 'cloudflared-exit');
            if (plan?.management === 'connector-only') {
                this.assertCurrent(revision);
                await this.routeCoordinator.commit({
                    mode: 'cloudflare',
                    publicationState: 'error',
                    configurationGeneration: plan.configurationGeneration,
                    hosts: asHostObject(plan),
                    canonicalScheme: 'https',
                });
            }
        } catch (_) {}
        const now = Date.now();
        this.restartHistory = this.restartHistory
            .filter((timestamp) => now - timestamp < this.restartPolicy.windowMs);
        this.restartHistory.push(now);
        const count = this.restartHistory.length;
        const exhausted = count > this.restartPolicy.maximumRestarts;
        const backoffMs = exhausted ? null : Math.min(
            this.restartPolicy.initialBackoffMs * (2 ** Math.max(0, count - 1)),
            this.restartPolicy.maximumBackoffMs,
        );
        const statusError = errorStatus(event?.error || new CloudflarePublicationError(
            `cloudflared exited${event?.code == null ? '' : ` with code ${event.code}`}`,
            {
                code: 'CLOUDFLARED_EXITED',
                operation: 'connector-process',
                retryable: !exhausted,
            },
        ));
        if (plan?.management === 'api-managed') {
            try {
                const existing = this.journal.read();
                if (existing?.mode === 'cloudflare'
                    && sameScope(existing.scope, plan.scope)) {
                    this.journal.write({
                        ...existing,
                        configurationGeneration: plan.configurationGeneration,
                        desiredDigest: plan.desiredDigest,
                        phase: 'error',
                        lastError: statusError,
                    });
                } else {
                    this.journal.write(journalValue(plan, 'error', {
                        managedDnsRecords: [],
                        lastError: statusError,
                    }));
                }
            } catch (_) {}
        }
        await this.transition({
            state: 'error',
            connectorState: 'stopped',
            error: statusError,
            retry: exhausted ? { exhausted: true, attempts: count } : { exhausted: false, attempts: count, backoffMs },
        });
        this.safeAudit('cloudflared-exit', {
            code: event?.code ?? null,
            signal: event?.signal ?? null,
            restartAttempts: count,
            restartBackoffMs: backoffMs,
        });
        if (exhausted || !this.lastInput) return;
        clearTimeout(this.restartTimer);
        this.restartTimer = setTimeout(() => {
            this.restartTimer = null;
            this.reconcile(this.lastInput, { reason: 'cloudflared-bounded-restart' }).catch(() => {});
        }, backoffMs);
        this.restartTimer.unref?.();
    }

    async stop() {
        this.stopped = true;
        this.requestRevision += 1;
        this.currentAbort?.abort(new Error('Cloudflare publication controller stopped'));
        clearTimeout(this.restartTimer);
        this.restartTimer = null;
        await this.connector.stop('controller-stop');
        try { await this.inactivate(this.lastInput || {}, 'cloudflare-controller-stop'); } catch (_) {}
        await this.transition({
            state: 'stopped',
            connectorState: this.state.mode === 'local-only' ? 'absent' : 'stopped',
            error: null,
            retry: null,
        });
    }
}

export function createEncryptedCloudflareSecretStore({ readAll = readSecretsFile } = {}) {
    return Object.freeze({ readAll });
}

export function createCloudflarePublicationController({
    workspaceRoot,
    routeCoordinator,
    probeHostname,
    publishState,
    audit,
    api,
    apiFactory = createCloudflarePublicationApi,
    connector = createCloudflaredConnector(),
    journal = createCloudflarePublicationJournal({ workspaceRoot }),
    managedTunnelRegistry = createCloudflareManagedTunnelRegistry({ workspaceRoot }),
    secretStore = createEncryptedCloudflareSecretStore(),
    probeConnector = createCloudflareConnectorProbe(),
    restartPolicy,
} = {}) {
    return new CloudflarePublicationController({
        api,
        apiFactory,
        connector,
        journal,
        managedTunnelRegistry,
        secretStore,
        routeCoordinator,
        probeConnector,
        probeHostname,
        publishState,
        audit,
        restartPolicy,
    });
}

export {
    CLOUDFLARE_ORIGIN,
    CloudflarePublicationError,
    normalizeCloudflarePublicationDesired,
    publicPlanSummary,
} from './publicationPlan.mjs';
