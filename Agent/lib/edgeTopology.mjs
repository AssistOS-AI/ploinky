import fs from 'node:fs';
import path from 'node:path';

const TOPOLOGY_STATES = new Set(['ready', 'reconciling', 'error']);
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
    if (!GENERATION_PATTERN.test(String(document.configurationGeneration || ''))) {
        throw new Error('edgeTopology: invalid configurationGeneration');
    }
    if (!GENERATION_PATTERN.test(String(document.authorizationGeneration || ''))) {
        throw new Error('edgeTopology: invalid authorizationGeneration');
    }
    if (!Number.isSafeInteger(document.publicationGeneration) || document.publicationGeneration < 1) {
        throw new Error('edgeTopology: invalid publicationGeneration');
    }
    if (!TOPOLOGY_STATES.has(document.state)) throw new Error('edgeTopology: invalid state');
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
    // Filesystem event delivery is advisory and can coalesce or miss a rapid
    // atomic replacement under load. Polling keeps the generation watcher
    // correct without keeping the process alive.
    const poller = setInterval(publish, 100);
    poller.unref();
    let closed = false;
    return Object.freeze({
        close: () => {
            if (closed) return;
            closed = true;
            clearInterval(poller);
            watcher.close();
        },
    });
}

export default {
    readEdgeTopology,
    watchEdgeTopology,
};
