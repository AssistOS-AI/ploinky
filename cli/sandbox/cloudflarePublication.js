import { readSecretsFile } from '../utils/security/encryptedSecretsFile.js';
import { createCloudflarePublicationApi } from './cloudflarePublicationApi.js';
import { createCloudflaredConnector } from './cloudflarePublicationConnector.js';
import { createCloudflarePublicationJournal } from './cloudflarePublicationJournal.js';
import {
    CLOUDFLARE_TERMINAL_SERVICE,
    CloudflarePublicationError,
    normalizeCloudflarePublicationDesired,
    publicationDigest,
    publicPlanSummary,
    redactCloudflareText,
    stablePublicationJson,
    toPublicationError,
} from './cloudflarePublicationPlan.js';

const REQUIRED_API_METHODS = Object.freeze([
    'validateScope',
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

function journalValue(plan, phase, {
    managedDnsRecords = [],
    lastError = null,
} = {}) {
    const cloudflare = plan.mode === 'cloudflare';
    return {
        mode: plan.mode,
        configurationGeneration: plan.configurationGeneration,
        desiredDigest: plan.desiredDigest,
        phase,
        scope: cloudflare ? plan.scope : null,
        ingressDigest: cloudflare ? publicationDigest(plan.ingress) : '',
        managedDnsRecords: cloudflare ? managedDnsRecords : [],
        lastError,
    };
}

function resolveSecretPair(secretStore, plan) {
    const secrets = secretStore.readAll();
    if (!secrets || typeof secrets !== 'object' || Array.isArray(secrets)) {
        throw new CloudflarePublicationError('Encrypted secret store is unreadable', {
            code: 'CLOUDFLARE_SECRET_STORE_INVALID',
            operation: 'resolve-secrets',
        });
    }
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
        connector,
        journal,
        secretStore,
        routeCoordinator,
        probeConnector,
        probeHostname,
        publishState = () => {},
        audit = () => {},
        restartPolicy = {},
    } = {}) {
        requireMethods(api, 'Cloudflare publication API', REQUIRED_API_METHODS);
        requireMethods(connector, 'cloudflared connector', ['start', 'stop', 'isRunning']);
        requireMethods(journal, 'Cloudflare publication journal', ['read', 'write']);
        requireMethods(secretStore, 'Cloudflare secret store', ['readAll']);
        requireMethods(routeCoordinator, 'Cloudflare route coordinator', ['inactivate', 'commit']);
        if (typeof probeConnector !== 'function') throw new TypeError('Cloudflare publication requires probeConnector()');
        if (typeof probeHostname !== 'function') throw new TypeError('Cloudflare publication requires probeHostname()');
        this.api = api;
        this.connector = connector;
        this.journal = journal;
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
        this.lastCloudflareInput = null;
        this.restartHistory = [];
        this.restartTimer = null;
        this.stopped = false;
    }

    getStatus() {
        return freezeClone(this.state);
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
        const revision = ++this.requestRevision;
        this.currentAbort?.abort(new CloudflarePublicationError('Cloudflare publication was superseded', {
            code: 'CLOUDFLARE_RECONCILIATION_SUPERSEDED',
            operation: 'reconcile',
        }));
        const run = this.queue.then(() => this.runReconcile(captured, { revision, reason }));
        this.queue = run.catch(() => {});
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
        let managedDnsRecords = [];
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
            if (plan.mode === 'cloudflare') this.lastCloudflareInput = cloneJson(input);
            const summary = publicPlanSummary(plan);
            managedDnsRecords = plan.mode === 'cloudflare' && sameScope(currentJournal?.scope, plan.scope)
                ? currentJournal.managedDnsRecords.map((entry) => ({ ...entry }))
                : [];
            if (plan.mode === 'local-only') {
                if (currentJournal?.mode === 'cloudflare') {
                    let previousPlan;
                    try {
                        previousPlan = normalizeCloudflarePublicationDesired(this.lastCloudflareInput || {});
                    } catch (_) {
                        previousPlan = null;
                    }
                    if (previousPlan?.mode !== 'cloudflare'
                        || !sameScope(previousPlan.scope, currentJournal.scope)) {
                        throw new CloudflarePublicationError(
                            'Local-only activation requires the previously selected Cloudflare credential handles until owned ingress and DNS teardown verifies; reselect the prior Cloudflare state and retry removal',
                            {
                                code: 'CLOUDFLARE_TEARDOWN_CREDENTIALS_REQUIRED',
                                operation: 'clear-final-host',
                            },
                        );
                    }
                    secretPair = resolveSecretPair(this.secretStore, previousPlan);
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
                this.journal.write(journalValue(plan, 'local-only'));
                this.lastCloudflareInput = null;
                this.safeAudit('cloudflare-local-only', summary);
                return this.transition({
                    state: 'local-only',
                    mode: 'local-only',
                    configurationGeneration: plan.configurationGeneration,
                    connectorState: 'absent',
                    hostnames: [],
                    reconciliation: { desiredDigest: plan.desiredDigest, phase: 'local-only' },
                    error: null,
                    retry: null,
                    scope: null,
                });
            }

            await this.transition({
                state: 'reconciling',
                mode: 'cloudflare',
                configurationGeneration: plan.configurationGeneration,
                connectorState: 'stopped',
                hostnames: plan.hosts.map((entry) => entry.hostname),
                scope: { ...plan.scope },
                reconciliation: { desiredDigest: plan.desiredDigest, phase: 'validate' },
                error: null,
                retry: null,
            });
            secretPair = resolveSecretPair(this.secretStore, plan);
            const { apiToken, tunnelToken } = secretPair;
            const signal = abortController.signal;
            this.assertCurrent(revision, signal);
            await this.api.validateScope({ apiToken, ...plan.scope, signal });
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
            this.journal.write(journalValue(plan, 'prepared', { managedDnsRecords }));
            await this.api.putTunnelIngress({ apiToken, ...plan.scope, ingress: plan.ingress, signal });
            this.assertCurrent(revision, signal);
            this.journal.write(journalValue(plan, 'ingress-applied', { managedDnsRecords }));

            for (const dns of plan.dns) {
                const existingManaged = managedDnsRecords.find((entry) => entry.hostname === dns.hostname) || null;
                const saved = await this.upsertDns({ dns, existingManaged, apiToken, scope: plan.scope, signal });
                managedDnsRecords = [
                    ...managedDnsRecords.filter((entry) => entry.hostname !== dns.hostname),
                    saved,
                ].sort((left, right) => left.hostname.localeCompare(right.hostname));
                this.journal.write(journalValue(plan, 'ingress-applied', { managedDnsRecords }));
            }
            const desiredHostnames = new Set(plan.dns.map((entry) => entry.hostname));
            for (const stale of managedDnsRecords.filter((entry) => !desiredHostnames.has(entry.hostname))) {
                await this.removeOwnedDns({ record: stale, apiToken, signal });
                managedDnsRecords = managedDnsRecords.filter((entry) => entry.hostname !== stale.hostname);
                this.journal.write(journalValue(plan, 'ingress-applied', { managedDnsRecords }));
            }
            this.journal.write(journalValue(plan, 'dns-reconciled', { managedDnsRecords }));
            await this.verifyRemote({ plan, apiToken, managedDnsRecords, signal });
            this.assertCurrent(revision, signal);
            this.journal.write(journalValue(plan, 'remote-verified', { managedDnsRecords }));

            await this.routeCoordinator.commit({
                mode: 'cloudflare',
                publicationState: 'reconciling',
                configurationGeneration: plan.configurationGeneration,
                hosts: asHostObject(plan),
                canonicalScheme: 'https',
            });
            this.assertCurrent(revision, signal);
            this.journal.write(journalValue(plan, 'routes-committed', { managedDnsRecords }));

            const baselineConnections = await this.api.listTunnelConnections({ apiToken, ...plan.scope, signal });
            const baselineConnectionIds = baselineConnections.map(connectionId).filter(Boolean);
            this.journal.write(journalValue(plan, 'connector-starting', { managedDnsRecords }));
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
                api: this.api,
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
                    signal,
                });
                if (!proof || proof.ok !== true) {
                    throw new CloudflarePublicationError(`External route probe failed for ${host.hostname}`, {
                        code: 'CLOUDFLARE_HOST_PROBE_FAILED',
                        operation: 'probe-hostname',
                        retryable: true,
                    });
                }
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
            this.journal.write(journalValue(plan, 'ready', { managedDnsRecords }));
            this.safeAudit('ready', summary);
            return await this.transition({
                state: 'ready',
                mode: 'cloudflare',
                connectorState: 'running',
                reconciliation: { desiredDigest: plan.desiredDigest, phase: 'ready' },
                error: null,
                retry: null,
            });
        } catch (error) {
            await this.connector.stop('error');
            try { await this.inactivate(input, 'cloudflare-error'); } catch (_) {}
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
            } else if (plan) {
                try {
                    this.journal.write(journalValue(plan, 'error', {
                        managedDnsRecords,
                        lastError: statusError,
                    }));
                } catch (_) {}
            } else if (currentJournal) {
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
        await this.api.putTunnelIngress({
            apiToken,
            ...previous.scope,
            ingress: [{ service: CLOUDFLARE_TERMINAL_SERVICE }],
            signal,
        });
        const installed = await this.api.readTunnelIngress({ apiToken, ...previous.scope, signal });
        if (stablePublicationJson(installed) !== stablePublicationJson([{ service: CLOUDFLARE_TERMINAL_SERVICE }])) {
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
                managedDnsRecords: remaining,
                lastError: null,
            });
        }
        this.assertCurrent(revision, signal);
    }

    async verifyRemote({ plan, apiToken, managedDnsRecords, signal }) {
        const installedIngress = await this.api.readTunnelIngress({ apiToken, ...plan.scope, signal });
        if (stablePublicationJson(installedIngress) !== stablePublicationJson(plan.ingress)) {
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
        try { await this.inactivate(this.lastInput, 'cloudflared-exit'); } catch (_) {}
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
        try {
            const plan = normalizeCloudflarePublicationDesired(this.lastInput);
            const existing = this.journal.read();
            this.journal.write(journalValue(plan, 'error', {
                managedDnsRecords: sameScope(existing?.scope, plan.scope)
                    ? existing.managedDnsRecords
                    : [],
                lastError: statusError,
            }));
        } catch (_) {}
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
    api = createCloudflarePublicationApi(),
    connector = createCloudflaredConnector(),
    journal = createCloudflarePublicationJournal({ workspaceRoot }),
    secretStore = createEncryptedCloudflareSecretStore(),
    probeConnector = createCloudflareConnectorProbe(),
    restartPolicy,
} = {}) {
    return new CloudflarePublicationController({
        api,
        connector,
        journal,
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
} from './cloudflarePublicationPlan.js';
