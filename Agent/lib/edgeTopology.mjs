import fs from 'node:fs';
import path from 'node:path';

const SUPPORTED_SCHEMA_VERSION = 2;
const ACTIVE_STATES = new Set(['local-ready', 'cloudflare-ready']);
const GENERATION_PATTERN = /^sha256:[a-f0-9]{64}$/;

function topologyFile(file, env) {
    const resolved = String(file || env?.PLOINKY_EDGE_TOPOLOGY_FILE || '').trim();
    if (!resolved) throw new Error('edgeTopology: PLOINKY_EDGE_TOPOLOGY_FILE is required');
    return resolved;
}

function validateTopology(document) {
    if (!document || typeof document !== 'object' || Array.isArray(document)) {
        throw new Error('edgeTopology: snapshot must be an object');
    }
    if (document.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
        throw new Error(`edgeTopology: unsupported schemaVersion '${document.schemaVersion}'`);
    }
    if (!GENERATION_PATTERN.test(String(document.configurationGeneration || ''))) {
        throw new Error('edgeTopology: invalid configurationGeneration');
    }
    if (!GENERATION_PATTERN.test(String(document.authorizationGeneration || ''))) {
        throw new Error('edgeTopology: invalid authorizationGeneration');
    }
    if (!Number.isSafeInteger(document.publicationGeneration) || document.publicationGeneration < 1) {
        throw new Error('edgeTopology: invalid publicationGeneration');
    }
    if (!Array.isArray(document.services)) {
        throw new Error('edgeTopology: services must be an array');
    }
    const keys = new Set();
    for (const service of document.services) {
        const routeKey = String(service?.routeKey || '').trim();
        const slug = String(service?.slug || '').trim();
        if (!routeKey || !slug) throw new Error('edgeTopology: service routeKey and slug are required');
        const key = `${routeKey}\0${slug}`;
        if (keys.has(key)) throw new Error(`edgeTopology: duplicate service '${routeKey}/${slug}'`);
        keys.add(key);
        for (const field of ['configuredBrowserUrl', 'activeBrowserUrl']) {
            if (service[field] === undefined) continue;
            let value;
            try { value = new URL(String(service[field])); } catch (_) {
                throw new Error(`edgeTopology: invalid ${field} for '${routeKey}/${slug}'`);
            }
            if (!['http:', 'https:', 'ws:', 'wss:'].includes(value.protocol)) {
                throw new Error(`edgeTopology: unsupported ${field} scheme for '${routeKey}/${slug}'`);
            }
        }
    }
    return document;
}

export function readEdgeTopology({ file, env = process.env } = {}) {
    const selected = topologyFile(file, env);
    let document;
    try {
        document = JSON.parse(fs.readFileSync(selected, 'utf8'));
    } catch (error) {
        throw new Error(`edgeTopology: cannot read current snapshot: ${error?.message || error}`);
    }
    return validateTopology(document);
}

export function resolveEdgeService({
    routeKey,
    slug,
    requireActive = true,
    file,
    env = process.env,
} = {}) {
    const wantedRouteKey = String(routeKey || '').trim();
    const wantedSlug = String(slug || '').trim();
    if (!wantedRouteKey || !wantedSlug) {
        throw new Error('edgeTopology: routeKey and slug are required');
    }
    const topology = readEdgeTopology({ file, env });
    const matches = topology.services.filter((service) => (
        service.routeKey === wantedRouteKey && service.slug === wantedSlug
    ));
    if (matches.length !== 1) {
        throw new Error(`edgeTopology: service '${wantedRouteKey}/${wantedSlug}' is unavailable or ambiguous`);
    }
    const service = matches[0];
    if (requireActive && (!ACTIVE_STATES.has(topology.state) || !service.activeBrowserUrl)) {
        throw new Error(`edgeTopology: service '${wantedRouteKey}/${wantedSlug}' is not active`);
    }
    return Object.freeze({
        schemaVersion: topology.schemaVersion,
        configurationGeneration: topology.configurationGeneration,
        publicationGeneration: topology.publicationGeneration,
        state: topology.state,
        service: Object.freeze({ ...service }),
        ...(topology.media ? { media: Object.freeze(structuredClone(topology.media)) } : {}),
    });
}

export function watchEdgeTopology({ file, env = process.env, onChange, onError } = {}) {
    if (typeof onChange !== 'function') throw new Error('edgeTopology: onChange callback is required');
    const selected = topologyFile(file, env);
    let lastGeneration = '';
    const publish = () => {
        try {
            const topology = readEdgeTopology({ file: selected, env });
            const generation = `${topology.configurationGeneration}:${topology.authorizationGeneration}:${topology.publicationGeneration}`;
            if (generation === lastGeneration) return;
            lastGeneration = generation;
            onChange(topology);
        } catch (error) {
            if (typeof onError === 'function') onError(error);
        }
    };
    publish();
    // current.json is replaced atomically. Watching the file inode directly
    // stops observing after the first rename on Linux, so watch its owning
    // directory and filter for the exact basename instead.
    const selectedDirectory = path.dirname(selected);
    const selectedName = path.basename(selected);
    const watcher = fs.watch(selectedDirectory, { persistent: false }, (_event, filename) => {
        if (filename === null || String(filename) === selectedName) publish();
    });
    watcher.on('error', (error) => {
        if (typeof onError === 'function') onError(error);
    });
    return Object.freeze({ close: () => watcher.close() });
}

export default {
    readEdgeTopology,
    resolveEdgeService,
    watchEdgeTopology,
};
