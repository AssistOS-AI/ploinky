import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateCanaryLinks } from '../canaryRecord.mjs';
import { readRouterGenerationHealth, ROUTER_GENERATION_SOURCE_FORMAT } from '../../utils/runtime/routerGenerationReadiness.mjs';
import { assertExactContainerOwnership, IMMUTABLE_CONTAINER_ID } from '../docker/containerOwnership.js';
import { assertCanaryLaunchIdentity, inspectCanaryContainer } from '../docker/containerFleet.js';
import {
    assertActiveEdgeRoutingSourcesCurrent, loadActiveEdgeRoutingGeneration, loadEdgeRoutingGenerationForEvidence,
    readEdgeRoutingSelection, withEdgeGenerationApplyLock,
} from '../edgeGeneration.js';
import { workspaceNetworkIdentity } from '../networkIdentity.js';
import { inspectStartReceipt, recoverPublishedStartReceipt } from './receipt.mjs';

async function routerRunning(dependencies) {
    try {
        const health = dependencies.readRouterHealth ? await dependencies.readRouterHealth()
            : await readRouterGenerationHealth({ socketPath: (await import('../../commands/workspaceUtil.js')).workspaceRouterHealthSocket() });
        if (health.generationSourceFormat !== ROUTER_GENERATION_SOURCE_FORMAT) throw new Error('Router generation format is unknown');
        return true;
    } catch (error) {
        if (['ENOENT', 'ECONNREFUSED'].includes(error.cause?.code || error.code)) return false;
        throw error;
    }
}

function publishedIdentity(context, generation) {
    const { routeKey, workspaceRoot } = context;
    const route = generation.routing.routes[routeKey];
    const field = route?.canary;
    const record = generation.agents[field?.container];
    if (!field || record?.canaryOf !== routeKey || record.runtime !== 'podman'
        || !IMMUTABLE_CONTAINER_ID.test(record.containerId) || !record.launchId
        || record.containerId === generation.agents[route.container]?.containerId) {
        throw new Error('start cannot prove an exact published canary runtime');
    }
    return {
        rolloutId: field.rolloutId, canaryCommit: field.commit, canaryContainerName: field.container,
        canaryContainerId: record.containerId, canaryLaunchId: record.launchId,
        canaryInstanceId: record.instanceId, canaryEnableGeneration: record.enableGeneration,
        repoName: route.repo, agentName: route.agent, workspaceIdentity: workspaceNetworkIdentity(workspaceRoot).hash,
    };
}

async function inspectPublication(context, generation, identity) {
    const name = identity.canaryContainerName, record = generation.agents[name];
    const inspect = context.dependencies.inspectContainer || inspectCanaryContainer;
    const container = await inspect(record.runtime, record.containerId);
    if (container) {
        assertExactContainerOwnership(name, record, container, record.containerId, identity.workspaceIdentity);
        assertCanaryLaunchIdentity(record, container, identity.rolloutId);
    }
    return container;
}

// Only a previously activated publication proves ownership when its receipt
// cannot be read. A merely prepared inactive generation is insufficient.
function recoveryGeneration(context, selector, paths) {
    const generation = selector.state === 'active' ? assertActiveEdgeRoutingSourcesCurrent(context).generation
        : loadEdgeRoutingGenerationForEvidence(selector.previousGeneration, context);
    const prepared = selector.state === 'inactive' && selector.generation
        ? loadEdgeRoutingGenerationForEvidence(selector.generation, context) : null;
    for (const key of ['routing', 'agents']) {
        const digest = 'sha256:' + createHash('sha256').update(fs.readFileSync(paths[key + 'File'])).digest('hex');
        if (digest !== generation.sourceDigests[key] || (prepared && digest !== prepared.sourceDigests[key])) {
            throw new Error('start cannot recover a canary receipt from changed publication sources');
        }
    }
    const field = generation.routing.routes[context.routeKey]?.canary;
    if (!field) throw new Error('start cannot recover a receipt without its published route');
    const exportPath = path.posix.join('.ploinky', 'canary', context.routeKey, field.commit);
    if (field.codePath !== exportPath && field.codePath !== exportPath + '/code') throw new Error('canary export identity disagrees');
    validateCanaryLinks(generation.routing, generation.agents, context.workspaceRoot);
    return generation;
}

function promotionStep(value) {
    return Number.isInteger(value) && value >= 1 && value <= 7;
}

function validProgress(receipt) {
    const { step, intent } = receipt;
    return (step === 'published' || promotionStep(step))
        && (intent === null || intent === 'checkout' || promotionStep(intent) || promotionStep(intent?.step))
        && [receipt.lastCompletedStep, receipt.promotionStep].every(n => n == null || n === 0 || promotionStep(n));
}

function completeIdentity(receipt, identity) {
    let complete = true;
    for (const [key, expected] of Object.entries(identity)) {
        if (receipt[key] == null) {
            if (key !== 'workspaceIdentity') complete = false;
        } else if (receipt[key] !== expected) throw new Error('canary receipt disagrees with publication: ' + key);
    }
    return complete;
}

function teardownJournal(receipt) {
    const t = receipt.teardown;
    return t && typeof t.published === 'boolean' && t.runtime === 'podman' && typeof t.home === 'string'
        && path.isAbsolute(t.home) && t.name === receipt.canaryContainerName && t.commit === receipt.canaryCommit
        && ['aborted', 'reset', 'promoted'].includes(t.outcome) && typeof t.reason === 'string'
        && (!t.published || IMMUTABLE_CONTAINER_ID.test(t.id))
        && (receipt.canaryContainerId == null || t.id === receipt.canaryContainerId)
        && (receipt.canaryLaunchId == null || t.launchId === receipt.canaryLaunchId)
        && (receipt.canaryInstanceId == null || t.instanceId === receipt.canaryInstanceId)
        && (receipt.canaryEnableGeneration == null || t.enableGeneration === receipt.canaryEnableGeneration);
}

function verifiedProgressForRecovery(receipt, identity, mode, routeKey) {
    const validHeader = receipt?.schemaVersion === 1 && receipt.routeKey === routeKey;
    if (mode === 'split') {
        if (validHeader && receipt.terminal === null) completeIdentity(receipt, identity);
        return {};
    }
    const matches = validHeader && completeIdentity(receipt, identity);
    const completed = receipt?.lastCompletedStep ?? receipt?.promotionStep ?? receipt?.step;
    if (matches && validProgress(receipt) && receipt.intent === null && promotionStep(completed)
        && receipt.terminal?.outcome === (completed >= 3 ? 'reset' : 'aborted')
        && !receipt.failurePhase && (mode !== 'retiring' || completed >= 5)) return { lastCompletedStep: completed };
    throw new Error('start cannot recover the canary outcome without a published split or exact terminal promotion step');
}

export async function repairStartReceipt(context, before) {
    await withEdgeGenerationApplyLock(async () => {
        const { selector, paths } = readEdgeRoutingSelection(context);
        const generation = recoveryGeneration(context, selector, paths);
        const identity = publishedIdentity(context, generation);
        const mode = generation.routing.routes[context.routeKey].canary.mode;
        const progress = verifiedProgressForRecovery(before.value, identity, mode, context.routeKey);
        await inspectPublication(context, generation, identity);
        recoverPublishedStartReceipt(context.routeKey, before.bytes, { ...identity, ...progress }, context);
    }, context);
    return false;
}

async function serving(context, generation, identity) {
    const container = await inspectPublication(context, generation, identity);
    if (!container || container.State?.Running === false) return false;
    if (container.State?.Running !== true) throw new Error('start cannot determine canary container state');
    return routerRunning(context.dependencies);
}

// The workspace and network lifecycle locks span classification and teardown.
// Partial publications and retirements have their own recovery journals.
export async function keepCanaryOnStart(context) {
    const { routeKey } = context;
    const before = inspectStartReceipt(routeKey, context);
    let receipt = before.value;
    const open = receipt?.schemaVersion === 1 && receipt.terminal === null && typeof receipt.rolloutId === 'string'
        && receipt.rolloutId.length > 0 && receipt.step != null;
    if (!open) return repairStartReceipt(context, before);
    if (receipt.routeKey !== routeKey) throw new Error('canary receipt belongs to another route');
    if (receipt.teardown || receipt.teardownPublication) return teardownJournal(receipt) ? false : repairStartReceipt(context, before);
    if (receipt.intent === 'withdraw' || receipt.step === 'opened') return false;
    const starting = ['exported', 'created'].includes(receipt.step);
    const settings = ['set', 'resume'].includes(receipt.intent) && receipt.settingsChange?.action === receipt.intent;
    if (starting || settings) {
        if (readEdgeRoutingSelection(context).selector.state !== 'active') return false;
        const { generation } = loadActiveEdgeRoutingGeneration(context);
        if (!generation.routing.routes[routeKey]?.canary) return false; // An unpublished launch still belongs to teardown.
        const identity = publishedIdentity(context, generation);
        if (!completeIdentity(receipt, identity)) return repairStartReceipt(context, before);
        if (!await serving(context, generation, identity)) return false;
        const { reconcilePublishedCanaryReceipt } = await import('./start.mjs');
        await reconcilePublishedCanaryReceipt(receipt, context.workspaceRoot);
        receipt = inspectStartReceipt(routeKey, context).value;
    }
    if (!validProgress(receipt) || receipt.publication || receipt.preparationLease) return repairStartReceipt(context, before);
    // A missing member tuple cannot bind the receipt to a healthy published rollout.
    if (!receipt.repoName || !receipt.agentName || !receipt.canaryCommit || !receipt.canaryContainerName
        || !receipt.canaryContainerId || !receipt.canaryLaunchId || !receipt.canaryInstanceId || !receipt.canaryEnableGeneration) {
        return repairStartReceipt(context, before);
    }
    return withEdgeGenerationApplyLock(async () => {
        if (readEdgeRoutingSelection(context).selector.state !== 'active') return false;
        const { generation } = assertActiveEdgeRoutingSourcesCurrent(context);
        const identity = publishedIdentity(context, generation);
        completeIdentity(receipt, identity);
        return serving(context, generation, identity);
    }, context);
}
