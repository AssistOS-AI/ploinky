// Read-only, single-route no-wait startup observation for the Router.
//
// This module deliberately accepts only an already-captured pending route plan.
// It never resolves a browser-supplied route name, scans the registry, starts a
// runtime, or returns producer diagnostics. RoutingServer is responsible for
// authenticating the exact route before calling the resolver.

import {
    createNoWaitRunBinding,
    observeBoundNoWaitRun,
    readNoWaitRunMarker,
    sameNoWaitRun,
    summarizeNoWaitFailure,
} from '../commands/noWaitLogObserver.js';
import { readAgentRegistrySnapshot } from '../utils/agentRegistrySnapshot.js';
import { resolveManifestRuntimeProfile } from '../utils/runtime/profileService.js';

const UNVERIFIED_RESULT = Object.freeze({ state: 'unverified' });
const GENERATION_CHANGED_RESULT = Object.freeze({ state: 'generation_changed' });
const STARTUP_FAILED_RESULT = Object.freeze({ state: 'failed', code: 'startup_failed' });
const STARTUP_TIMED_OUT_RESULT = Object.freeze({ state: 'failed', code: 'startup_timed_out' });
const ROUTE_UNAVAILABLE_RESULT = Object.freeze({ state: 'unavailable', code: 'route_unavailable' });
const INVALID_PUBLICATION = Object.freeze({ ok: false, canPublishHttp: false });

function exactText(value) {
    return typeof value === 'string' && value.length > 0 && value === value.trim()
        ? value
        : '';
}

function normalizedAlias(value) {
    if (value === undefined || value === null || value === '') return '';
    return exactText(value);
}

function immutableRecordMatches(left, right) {
    return Boolean(left && right)
        && String(left.instanceId || '') === String(right.instanceId || '')
        && String(left.enableGeneration || '') === String(right.enableGeneration || '')
        && String(left.repoName || '') === String(right.repoName || '')
        && String(left.agentName || '') === String(right.agentName || '')
        && String(left.alias || '') === String(right.alias || '')
        && String(left.profile || '') === String(right.profile || '');
}

function commitCapturedLease(plan, commitLease) {
    try {
        return commitLease(plan) === true;
    } catch (_) {
        return false;
    }
}

/**
 * Validate the exact snapshot-owned publication contract without lifecycle I/O.
 * Invalid inputs collapse to one fail-closed result with no diagnostic payload.
 */
export function inspectNoWaitAgentPublication(plan, {
    resolveRuntimeProfile = resolveManifestRuntimeProfile,
} = {}) {
    try {
        if (!plan?.ok || plan.kind !== 'agent-root-pending' || plan.target) {
            return INVALID_PUBLICATION;
        }
        const routeKey = exactText(plan.routeKey);
        const snapshot = plan.snapshot;
        const route = plan.route;
        if (!routeKey || !snapshot || typeof snapshot !== 'object'
            || !route || typeof route !== 'object' || Array.isArray(route)) {
            return INVALID_PUBLICATION;
        }

        // The plan must retain the actual route selected from its immutable
        // snapshot, not a lookalike assembled from request-controlled fields.
        const snapshotRoute = snapshot.routing?.routes?.[routeKey];
        if (!snapshotRoute || snapshotRoute !== route
            || route.disabled === true || route.draining === true) {
            return INVALID_PUBLICATION;
        }
        const publishedPort = Number(route.hostPort || 0);
        if (Number.isSafeInteger(publishedPort) && publishedPort > 0 && publishedPort <= 65535) {
            return INVALID_PUBLICATION;
        }

        const containerName = exactText(route.container);
        const repoName = exactText(route.repo);
        const shortAgent = exactText(route.agent);
        const alias = normalizedAlias(route.alias);
        const hostPath = exactText(route.hostPath);
        if (!containerName || !repoName || !shortAgent || !hostPath
            || (route.alias !== undefined && route.alias !== null && route.alias !== '' && !alias)) {
            return INVALID_PUBLICATION;
        }

        const record = snapshot.agents?.[containerName];
        if (!record || record.type !== 'agent'
            || exactText(record.instanceId) === ''
            || exactText(record.enableGeneration) === ''
            || exactText(record.repoName) !== repoName
            || exactText(record.agentName) !== shortAgent
            || normalizedAlias(record.alias) !== alias
            || routeKey !== (alias || shortAgent)) {
            return INVALID_PUBLICATION;
        }
        const persistedProfileName = exactText(record.profile);
        if (!persistedProfileName || persistedProfileName !== persistedProfileName.toLowerCase()) {
            return INVALID_PUBLICATION;
        }

        const manifest = snapshot.manifests?.[routeKey];
        if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
            return INVALID_PUBLICATION;
        }
        const profileResolution = resolveRuntimeProfile(manifest, {
            agentName: `${repoName}/${shortAgent}`,
            persistedProfileName,
            // Keep this classifier snapshot-only even if a replacement resolver
            // is supplied or a malformed record somehow reaches this point.
            fallbackProfileName: 'default',
            path: `captured manifest(${routeKey})`,
        });
        if (profileResolution?.resolvedProfileName !== persistedProfileName
            || !profileResolution.network
            || typeof profileResolution.network.mode !== 'string') {
            return INVALID_PUBLICATION;
        }

        return Object.freeze({
            ok: true,
            containerName,
            routeKey,
            repoName,
            shortAgent,
            alias,
            record,
            manifest,
            profileResolution,
            canPublishHttp: profileResolution.network.mode !== 'none',
        });
    } catch (_) {
        return INVALID_PUBLICATION;
    }
}

export function canNoWaitAgentPublishHttp(plan, options = {}) {
    return inspectNoWaitAgentPublication(plan, options).canPublishHttp === true;
}

/**
 * Observe one exact registry record. Marketplace and the Router share this
 * primitive; neither caller has to scan or rediscover another agent.
 */
export function observeNoWaitAgentRecord(containerName, record, {
    readRunMarker = readNoWaitRunMarker,
    createRunBinding = createNoWaitRunBinding,
    observeRun = observeBoundNoWaitRun,
    readRegistrySnapshot = readAgentRegistrySnapshot,
    observationOptions = {},
} = {}) {
    const marker = readRunMarker(containerName);
    if (!marker) return null;
    const binding = createRunBinding(containerName, record, marker);
    return observeRun(binding, {
        ...observationOptions,
        readRegistrySnapshot,
    });
}

/** Preserve Marketplace's established operator-facing presentation mapping. */
export function mapNoWaitObservationForMarketplace(observation, {
    summarizeFailure = summarizeNoWaitFailure,
} = {}) {
    if (!observation) return null;
    if (observation.state === 'pending' || observation.state === 'starting') {
        return {
            status: 'starting',
            detail: observation.queued
                ? 'Waiting for an earlier startup wave.'
                : 'Background startup is in progress.',
        };
    }
    if (observation.state === 'failed') {
        return {
            status: 'failed',
            detail: summarizeFailure(observation.status),
        };
    }
    if (observation.state === 'running') {
        return { status: 'running', detail: '' };
    }
    return null;
}

function strictStaleFence(binding, publication, {
    readRunMarker,
    createRunBinding,
    readRegistrySnapshot,
}) {
    try {
        const marker = readRunMarker(publication.containerName);
        if (!marker || !sameNoWaitRun(marker, binding)) return false;
        const registry = readRegistrySnapshot();
        const record = registry?.[publication.containerName];
        if (!immutableRecordMatches(record, publication.record)) return false;
        const currentBinding = createRunBinding(publication.containerName, record, marker);
        return sameNoWaitRun(currentBinding, binding);
    } catch (_) {
        return false;
    }
}

/**
 * Return only the allowlisted browser startup state for one authenticated,
 * captured pending route. No producer status or exception text escapes.
 */
export function resolveNoWaitAgentStartupState(plan, {
    inspectPublication = inspectNoWaitAgentPublication,
    resolveRuntimeProfile = resolveManifestRuntimeProfile,
    readRunMarker = readNoWaitRunMarker,
    createRunBinding = createNoWaitRunBinding,
    observeRun = observeBoundNoWaitRun,
    readRegistrySnapshot = readAgentRegistrySnapshot,
    observationOptions = {},
    commitLease = (capturedPlan) => capturedPlan?.lease?.commit?.() === true,
} = {}) {
    const publication = inspectPublication(plan, { resolveRuntimeProfile });
    if (!publication?.ok) return UNVERIFIED_RESULT;

    let marker;
    let binding;
    let observation;
    try {
        marker = readRunMarker(publication.containerName);
        if (!marker) return UNVERIFIED_RESULT;
        binding = createRunBinding(publication.containerName, publication.record, marker);
        observation = observeRun(binding, {
            ...observationOptions,
            readRegistrySnapshot,
        });
        if (!immutableRecordMatches(observation?.record, publication.record)) {
            return UNVERIFIED_RESULT;
        }
    } catch (error) {
        if (error?.code === 'NO_WAIT_RUN_SUPERSEDED') {
            return GENERATION_CHANGED_RESULT;
        }
        if (error?.code !== 'NO_WAIT_OBSERVATION_STALE'
            || !binding
            || !strictStaleFence(binding, publication, {
                readRunMarker,
                createRunBinding,
                readRegistrySnapshot,
            })) {
            return UNVERIFIED_RESULT;
        }
        if (!commitCapturedLease(plan, commitLease)) return GENERATION_CHANGED_RESULT;
        return STARTUP_TIMED_OUT_RESULT;
    }

    if (!commitCapturedLease(plan, commitLease)) return GENERATION_CHANGED_RESULT;
    if (observation.state === 'pending') {
        return Object.freeze({ state: 'starting', queued: false });
    }
    if (observation.state === 'starting') {
        return Object.freeze({ state: 'starting', queued: observation.queued === true });
    }
    if (observation.state === 'failed') return STARTUP_FAILED_RESULT;
    if (observation.state === 'running') {
        return publication.canPublishHttp
            ? GENERATION_CHANGED_RESULT
            : ROUTE_UNAVAILABLE_RESULT;
    }
    return UNVERIFIED_RESULT;
}

export const __testables = Object.freeze({
    immutableRecordMatches,
    strictStaleFence,
});
