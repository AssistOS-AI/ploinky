import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

import { deriveAgentRequestSecret } from '../../utils/security/masterKey.js';
import { createRoutePlan } from '../proxy/RoutePlan.js';
import { resolveConvention } from '../agentPortConvention/resolveConvention.js';
import { RelayRequestMinter } from '../runtimeRelay/relayRequestMinter.js';
import { RuntimeRelayManager } from '../runtimeRelay/RuntimeRelayManager.js';
import { activateGeneration } from './activateGeneration.js';
import { GenerationStore } from './GenerationStore.js';
import { evaluateGenerationAccess } from './evaluateGenerationAccess.js';
import { normalizeAuthority } from './authority.js';

const AGENT_HTTP_SERVICE_PORT = 7000;

export class RoutingRuntime {
    constructor({ routingFile, policy, publicAuthority, privateAuthority = '127.0.0.1:8081' } = {}) {
        if (!routingFile || !policy || !publicAuthority) throw new Error('RoutingRuntime: routing file, policy, and public authority required');
        this.routingFile = routingFile;
        this.policy = policy;
        this.publicAuthority = normalizeAuthority(publicAuthority);
        this.privateAuthority = normalizeAuthority(privateAuthority);
        this.store = new GenerationStore();
        this.minter = new RelayRequestMinter({ resolveAgentSecret: deriveAgentRequestSecret });
        // Capacity counters span generation replacement and failed candidate
        // activation so committed requests cannot escape global bounds.
        this.relayManager = new RuntimeRelayManager({ minter: this.minter });
        this.lastError = null;
        this.watcher = null;
    }

    _policyBytes() {
        if (typeof this.policy.repository?.captureStateBytes === 'function') {
            return this.policy.repository.captureStateBytes();
        }
        const loaded = this.policy.repository?.listHttpRoutes?.() || { entries: [] };
        if (loaded.corrupt) throw new Error('RoutingRuntime: HTTP route policy is corrupt');
        return Buffer.from(JSON.stringify({ entries: loaded.entries || [] }), 'utf8');
    }

    refresh() {
        try {
            const routingBytes = fs.readFileSync(this.routingFile);
            const generation = activateGeneration(this.store, {
                routingBytes,
                policyBytes: this._policyBytes(),
                publicAuthority: this.publicAuthority,
                privateAuthority: this.privateAuthority,
            });
            this.lastError = null;
            return generation;
        } catch (error) {
            this.lastError = error;
            this.store.deactivate();
            throw error;
        }
    }

    watch(onError = () => {}) {
        if (this.watcher) return;
        const directory = path.dirname(this.routingFile);
        const basename = path.basename(this.routingFile);
        this.watcher = fs.watch(directory, { persistent: false }, (_event, filename) => {
            if (filename && String(filename) !== basename) return;
            try { this.refresh(); } catch (error) { onError(error); }
        });
    }

    close() {
        this.watcher?.close();
        this.watcher = null;
        this.relayManager.close();
        this.store.deactivate();
    }

    acquire({ listenerClass = 'public', authority } = {}) {
        return this.store.acquire({ listenerClass, authority: normalizeAuthority(authority) });
    }

    resolveConvention({ lease, requestTarget, method, authority, listenerClass = 'public', scheme = 'http', transport = 'http' }) {
        return resolveConvention({
            requestTarget,
            method,
            authority,
            listenerClass,
            scheme,
            transport,
            generation: lease.generation,
            evaluateAccess: input => evaluateGenerationAccess({ generation: lease.generation, ...input }),
        });
    }

    resolvePrimary({ lease, routeKey, method, externalPath, targetPath, query = '', authority, listenerClass = 'public', scheme = 'http', transport = 'http', forwardedPrefix, declaredAccess, declaredGuestScope }) {
        const generation = lease.generation;
        const route = generation.routes?.[routeKey];
        if (!route || !route.primaryService || !route.relay) return null;
        const access = evaluateGenerationAccess({
            generation,
            pathname: externalPath,
            method,
            routeKey,
            surfaceKind: 'agent-primary',
            declaredAccess,
            declaredGuestScope,
        });
        return createRoutePlan({
            listenerClass,
            authority: normalizeAuthority(authority),
            surfaceKind: 'agent-primary',
            owner: { effectiveInstanceId: route.effectiveInstanceId, enableGeneration: route.enableGeneration },
            routeKey,
            port: route.primaryService.port,
            policyPath: externalPath,
            convention: 'agent-primary',
            forwardedPrefix: forwardedPrefix || `/${encodeURIComponent(routeKey)}`,
            unmatchedSuffix: targetPath || '/',
            relay: route.relay,
            deniedPorts: route.deniedPorts,
            allowedRouterCapabilities: [],
            access,
            scheme,
            origin: `${scheme}://${normalizeAuthority(authority)}`,
            limits: route.limits,
            generationDigest: generation.digest,
            auditId: crypto.randomUUID(),
            method: String(method || 'GET').toUpperCase(),
            query,
            transport,
            credentialPolicy: route.credentialPolicy,
            responsePolicy: route.responsePolicy,
            originPolicy: route.originPolicy,
            allowRequestStreaming: route.allowRequestStreaming,
        });
    }

    resolveHttpService({ lease, routeKey, method, externalPath, targetPath, query = '', authority, listenerClass = 'public', scheme = 'http', transport = 'http', forwardedPrefix, declaredAccess, declaredGuestScope }) {
        const generation = lease.generation;
        const route = generation.routes?.[routeKey];
        if (!route?.relay) return null;
        const port = route.primaryService?.port || AGENT_HTTP_SERVICE_PORT;
        if (route.deniedPorts?.includes(port)) return null;
        const access = evaluateGenerationAccess({
            generation,
            pathname: externalPath,
            method,
            routeKey,
            surfaceKind: 'agent-http-service',
            declaredAccess,
            declaredGuestScope,
        });
        return createRoutePlan({
            listenerClass,
            authority: normalizeAuthority(authority),
            surfaceKind: 'agent-http-service',
            owner: { effectiveInstanceId: route.effectiveInstanceId, enableGeneration: route.enableGeneration },
            routeKey,
            port,
            policyPath: externalPath,
            convention: 'manifest-http-service',
            forwardedPrefix,
            unmatchedSuffix: targetPath || '/',
            relay: route.relay,
            deniedPorts: route.deniedPorts,
            allowedRouterCapabilities: [],
            access,
            scheme,
            origin: `${scheme}://${normalizeAuthority(authority)}`,
            limits: route.limits,
            generationDigest: generation.digest,
            auditId: crypto.randomUUID(),
            method: String(method || 'GET').toUpperCase(),
            query,
            transport,
            credentialPolicy: route.credentialPolicy,
            responsePolicy: route.responsePolicy,
            originPolicy: route.originPolicy,
            allowRequestStreaming: route.allowRequestStreaming,
        });
    }
}

export default RoutingRuntime;
