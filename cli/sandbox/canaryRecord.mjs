import fs from 'node:fs';
import path from 'node:path';
import { validateAvailabilityProjection } from '../server/hardwareAvailability.mjs';

// Even an invalid link is a canary marker. Lifecycle readers must never
// prepare it as an ordinary agent while generation compilation rejects it.
export function isCanaryRecord(record) {
    return record != null && Object.hasOwn(record, 'canaryOf');
}

function invalid(message) {
    const error = new Error(message);
    error.code = 'EDGE_GENERATION_INVALID';
    throw error;
}

function exactFields(value, fields, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).length !== fields.length || !fields.every((name) => Object.hasOwn(value, name))) {
        invalid(`${label} requires exactly ${fields.join(', ')}`);
    }
}

function exactString(value) {
    return typeof value === 'string' && value.length > 0 && value.trim() === value && !/[\x00-\x1f\x7f]/u.test(value);
}

function identityPart(value) {
    return exactString(value) && !value.includes('/');
}

export function validateCanaryField(field, label) {
    exactFields(field, [
        'rolloutId', 'container', 'commit', 'codeDigest', 'codePath', 'share',
        'testAccounts', 'salt', 'splitStartedAt', 'mode', 'probe', 'thresholds',
    ], label);
    for (const name of ['rolloutId', 'container', 'commit', 'codeDigest', 'codePath', 'salt', 'splitStartedAt']) {
        if (!exactString(field[name])) invalid(`${label}.${name} must be a non-empty string`);
    }
    for (const name of ['rolloutId', 'container']) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(field[name])) invalid(`${label}.${name} is invalid`);
    }
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(field.commit)) invalid(`${label}.commit is invalid`);
    if (!/^sha256:[a-f0-9]{64}$/.test(field.codeDigest)) invalid(`${label}.codeDigest is invalid`);
    const parts = field.codePath.split('/');
    if (parts.length < 3 || parts[0] !== '.ploinky' || parts[1] !== 'canary' || field.codePath.includes('\\')
        || parts.some((part) => !part || part === '.' || part === '..')) {
        invalid(`${label}.codePath must be a canonical descendant of .ploinky/canary/`);
    }
    if (!Number.isFinite(field.share) || field.share < 0 || field.share > 100) invalid(`${label}.share must be in 0..100`);
    if (!Array.isArray(field.testAccounts) || !field.testAccounts.every(exactString)
        || new Set(field.testAccounts).size !== field.testAccounts.length) invalid(`${label}.testAccounts is invalid`);
    const timestamp = Date.parse(field.splitStartedAt);
    const canonicalTime = field.splitStartedAt.includes('.') ? field.splitStartedAt : field.splitStartedAt.replace(/Z$/, '.000Z');
    if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== canonicalTime) {
        invalid(`${label}.splitStartedAt must be a UTC timestamp`);
    }
    if (!['split', 'all', 'retiring', 'withdrawn'].includes(field.mode)) invalid(`${label}.mode is invalid`);
    const { probe, thresholds } = field;
    exactFields(probe, ['port', 'path', 'status'], `${label}.probe`);
    if (!Number.isInteger(probe.port) || probe.port < 1 || probe.port > 65535) invalid(`${label}.probe.port is invalid`);
    if (!exactString(probe.path) || !probe.path.startsWith('/') || probe.path.startsWith('//') || /[\\#\s]/.test(probe.path)) {
        invalid(`${label}.probe.path must be a local HTTP request path`);
    }
    if (!Number.isInteger(probe.status) || probe.status < 100 || probe.status > 599) invalid(`${label}.probe.status is invalid`);
    exactFields(thresholds, ['errorRate', 'windowSeconds'], `${label}.thresholds`);
    if (!Number.isFinite(thresholds.errorRate) || thresholds.errorRate < 0 || thresholds.errorRate > 1
        || !Number.isSafeInteger(thresholds.windowSeconds) || thresholds.windowSeconds < 1) invalid(`${label}.thresholds is invalid`);
}

// The capture may precede materialization of the export. Check every existing
// component by lstat so an ancestor link cannot redirect even a missing leaf.
// Immutable snapshot replay uses the recorded relative path without live I/O.
function checkExportDirectory(workspaceRoot, codePath) {
    let directory = workspaceRoot;
    for (const part of codePath.split('/')) {
        directory = path.join(directory, part);
        const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
        if (!stat) break;
        if (!stat.isDirectory()) invalid('canary codePath must descend through real workspace directories');
    }
}

export function validateCanaryLinks(routing, agents, workspaceRoot) {
    const routes = routing.routes || {};
    if (isCanaryRecord(agents[routing.static?.container])) invalid('the static container cannot be a canary');
    let pairedRoute;
    for (const [containerName, record] of Object.entries(agents)) {
        if (!isCanaryRecord(record)) continue;
        if (!exactString(record.canaryOf) || !Object.hasOwn(routes, record.canaryOf)
            || routes[record.canaryOf]?.canary?.container !== containerName) {
            invalid(`canary record '${containerName}' has no matching route`);
        }
    }
    for (const [routeKey, route] of Object.entries(routes)) {
        const owner = agents[route.container];
        if (isCanaryRecord(owner)) invalid(`route '${routeKey}' cannot use a canary as its primary container`);
        if (!route.canary) continue;
        if (pairedRoute !== undefined) invalid('a workspace can have only one canary route');
        pairedRoute = routeKey;
        if (workspaceRoot) checkExportDirectory(workspaceRoot, route.canary.codePath);
        const secondary = agents[route.canary.container];
        if (!exactString(route.container) || !Object.hasOwn(agents, route.container)
            || !isCanaryRecord(secondary) || secondary.canaryOf !== routeKey) {
            invalid(`route '${routeKey}' has an incomplete canary pair`);
        }
        // replacementCandidateContainerName rotates the primary's suffix. A
        // canary keeps the name it acquired before that alongside replacement.
        const candidateSuffix = /__candidate_[a-f0-9]{12}$/i;
        const canaryName = route.canary.container;
        if (!canaryName.endsWith('__canary')
            || canaryName.slice(0, -'__canary'.length).replace(candidateSuffix, '') !== route.container.replace(candidateSuffix, '')) {
            invalid(`route '${routeKey}' has a canary name unrelated to its primary`);
        }
        for (const member of [owner, secondary]) {
            if (member?.type !== 'agent' || !identityPart(route.repo) || !identityPart(route.agent)
                || member.repoName !== route.repo || member.agentName !== route.agent
                || !identityPart(member.instanceId) || !identityPart(member.enableGeneration)) {
                invalid(`route '${routeKey}' canary pair requires two exact identities of its principal`);
            }
        }
        const primaryDenial = route.hardwareAvailability;
        if (primaryDenial && (primaryDenial.instanceId !== owner.instanceId
            || primaryDenial.enableGeneration !== owner.enableGeneration)) {
            invalid(`route '${routeKey}' hardware projection requires its current primary tuple`);
        }
        // A third physical record with either member's signing tuple could
        // otherwise authenticate as that member even when selected by name.
        for (const [memberName, member] of [[route.container, owner], [canaryName, secondary]]) {
            const duplicate = Object.entries(agents).some(([name, record]) => name !== memberName && record?.type === 'agent'
                && String(record.repoName || '').trim() === route.repo && String(record.agentName || '').trim() === route.agent
                && String(record.instanceId || '').trim() === member.instanceId
                && String(record.enableGeneration || '').trim() === member.enableGeneration);
            if (duplicate) invalid(`route '${routeKey}' has duplicate canary pair tuples`);
        }
        if (secondary.hostPort != null && (!Number.isInteger(secondary.hostPort) || secondary.hostPort < 1 || secondary.hostPort > 65535)) {
            invalid(`route '${routeKey}' has an invalid canary record port`);
        }
        if (Object.hasOwn(secondary, 'launchId') && !exactString(secondary.launchId)) {
            invalid(`route '${routeKey}' has an invalid canary launch identity`);
        }
        if (Object.hasOwn(secondary, 'hardwareAvailability')) {
            let projection;
            try {
                projection = validateAvailabilityProjection(secondary.hardwareAvailability);
            } catch (error) {
                invalid(`route '${routeKey}' has an invalid canary hardware projection: ${error.message}`);
            }
            if (projection.key !== canaryName || projection.instanceId !== secondary.instanceId
                || projection.enableGeneration !== secondary.enableGeneration
                || secondary.hostPort !== undefined || secondary.serviceTargets !== undefined) {
                invalid(`route '${routeKey}' canary hardware projection requires its exact targetless member`);
            }
        }
    }
}
