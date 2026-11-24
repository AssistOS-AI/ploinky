import { readCacheSettings } from './cacheSettingsStore.js';

export function isApplicationHeld(repoAgent, snapshot) {
    const settings = snapshot?.settings ?? readCacheSettings();
    const generation = snapshot?.generation?.routing ? snapshot.generation : snapshot;
    return Object.hasOwn(settings.held, repoAgent)
        || Object.values(generation?.routing?.routes || {}).some(route =>
            route && `${route.repo}/${route.agent}` === repoAgent && Object.hasOwn(route, 'canary'));
}

export function getApplicationCacheState(repoAgent, generation) {
    const settings = readCacheSettings();
    const application = settings.applications[repoAgent];
    return {
        enabled: application?.enabled ?? false,
        pageSeconds: application?.pageSeconds ?? 300,
        held: isApplicationHeld(repoAgent, { settings, generation }),
    };
}
