import { applicationManifests, cacheOverlay } from '../policy/routeCacheMarks.js';
import { applicationCacheState, applicationRouteRecords } from './cacheSettings.js';
import { decideAgentAnswer } from './cdnCachePolicy.js';

// The administrator-facing view of one application's routes. It is derived from
// the same overlay the response path uses, never from a separate rule set.
export function applicationOverlay(generation, agent, settings) {
    return cacheOverlay({
        parts: applicationManifests(generation, agent),
        records: applicationRouteRecords(settings, agent),
    });
}

// The CDN header the Router would send for a clean anonymous 200 with no upstream Cache-Control.
function anonymousCdnHeader(effective, state) {
    return decideAgentAnswer({
        access: 'public', cacheClass: effective, application: state, method: 'GET',
        requestHasCredential: false, status: 200, headers: {}, routerQueuedSetCookie: false, isStream: false,
    }).cdnCacheControl;
}

function choicesFor(entry, overlay) {
    if (entry.mark === 'never' || entry.neverBy !== null) return [];
    // Only a bound setting shapes this row. An unbound one is listed on its own stale row, which
    // offers the reset, so this row offers what applies to the route now.
    if (entry.bound) return ['default'];
    if (entry.source === 'manifest') return ['off'];
    return entry.mark === null && overlay.hasNever && !entry.publicProtocol ? ['page'] : [];
}

function settingView(record) {
    return { setting: record.setting, at: record.at, by: record.by };
}

export function publicRouteRows(overlay, settings, agent, generation, checkable = () => false) {
    const state = applicationCacheState(agent, settings, generation);
    const rows = overlay.entries.map(entry => ({
        path: entry.path,
        manifest: entry.mark,
        neverBy: entry.neverBy,
        publicProtocol: entry.publicProtocol,
        setting: entry.bound ? settingView(entry.record) : null,
        stale: false,
        effective: entry.effective,
        source: entry.source,
        cdnHeader: anonymousCdnHeader(entry.effective, state),
        choices: choicesFor(entry, overlay),
        checkable: !entry.wildcard && checkable(entry) === true,
    }));
    for (const { path, record } of overlay.stale) {
        const entry = overlay.entries.find(candidate => candidate.path === path);
        rows.push({
            path,
            manifest: entry?.mark ?? null,
            neverBy: entry?.neverBy ?? null,
            publicProtocol: entry?.publicProtocol ?? false,
            setting: settingView(record),
            stale: true,
            effective: null,
            source: null,
            cdnHeader: 'no-store',
            choices: ['default'],
            checkable: false,
        });
    }
    return rows;
}
