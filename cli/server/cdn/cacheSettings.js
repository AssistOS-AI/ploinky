import { applicationManifests, cacheOverlay, hasCacheMark, matchOverlayEntry } from '../policy/routeCacheMarks.js';
import { readCacheSettings } from './cacheSettingsStore.js';

export function isApplicationHeld(repoAgent, snapshot) {
    const settings = snapshot?.settings ?? readCacheSettings();
    const generation = snapshot?.generation?.routing ? snapshot.generation : snapshot;
    return Object.hasOwn(settings.held, repoAgent)
        || Object.values(generation?.routing?.routes || {}).some(route =>
            route && `${route.repo}/${route.agent}` === repoAgent && Object.hasOwn(route, 'canary'));
}

// The switch, freshness and hold of one application from an already read settings snapshot.
export function applicationCacheState(repoAgent, settings, generation) {
    const application = settings.applications[repoAgent];
    return {
        enabled: application?.enabled ?? false,
        pageSeconds: application?.pageSeconds ?? 300,
        held: isApplicationHeld(repoAgent, { settings, generation }),
    };
}

export function getApplicationCacheState(repoAgent, generation) {
    return applicationCacheState(repoAgent, readCacheSettings(), generation);
}

// An application's administrator route choices from a settings snapshot (normalized path -> record).
export function applicationRouteRecords(settings, repoAgent) {
    return settings.routes && Object.hasOwn(settings.routes, repoAgent) ? settings.routes[repoAgent] : null;
}

// The effective class of the public route a plan serves, for the response path.
// Any error is an answer that must not be cached.
export function getRouteCacheState(plan, access) {
    const none = { cacheClass: null, application: undefined };
    try {
        const route = plan?.route;
        const snapshot = plan?.snapshot;
        if (access !== 'public' || !route?.repo || !route?.agent) return none;
        const agent = `${route.repo}/${route.agent}`;
        const parts = applicationManifests(snapshot, agent);
        // Most applications carry no mark: answer without a generation check or reading the settings file.
        if (!hasCacheMark(parts)) return none;
        if (plan.lease?.isCurrent?.() !== true) return none;
        const settings = readCacheSettings();
        const overlay = cacheOverlay({ parts, records: applicationRouteRecords(settings, agent) });
        const cacheClass = matchOverlayEntry(overlay, plan.policyPath ?? plan.canonicalPath)?.effective ?? null;
        if (!cacheClass) return none;
        return { cacheClass, application: applicationCacheState(agent, settings, snapshot) };
    } catch {
        return none;
    }
}
