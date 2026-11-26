// The captured PROD state: `.ploinky/data/mcp-prod-gates.json`.
//
// The file lives in controller-only state, which agent runtimes mask entirely.
// A deploy-path command (start, whole restart) writes it from a capture that
// ran the dirty check; the Router and the agents read only this file, never
// the stored `PROD` var, `.env` or `process.env`. A stored change therefore
// takes effect at the next start or whole restart, never per call.
//
// Shape: { schema: 1, prod: boolean, routes: { <routeKey>: { tools: [..], sha256 } } }
// `tools` is the set of tools that carry the `prod-disabled` modifier tag.

import fs from 'node:fs';
import path from 'node:path';

import { CONTROLLER_STATE_DIR } from '../config.js';

export const PROD_GATES_SCHEMA = 1;
export const PROD_GATES_FILE_NAME = 'mcp-prod-gates.json';
export const PROD_GATES_FILE = path.join(CONTROLLER_STATE_DIR, PROD_GATES_FILE_NAME);

const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;

function unavailable(reason) {
    return Object.freeze({ unavailable: true, reason });
}

// Parse and validate a capture. Anything malformed is unavailable, never a
// partial value, because consumers treat unavailable as PROD true.
export function parseProdGates(text) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (_) {
        return unavailable('corrupt');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
        || parsed.schema !== PROD_GATES_SCHEMA
        || typeof parsed.prod !== 'boolean'
        || !parsed.routes || typeof parsed.routes !== 'object' || Array.isArray(parsed.routes)) {
        return unavailable('corrupt');
    }
    const routes = Object.create(null);
    for (const [routeKey, entry] of Object.entries(parsed.routes)) {
        if (!entry || typeof entry !== 'object' || !Array.isArray(entry.tools)
            || entry.tools.some((tool) => typeof tool !== 'string')) {
            return unavailable('corrupt');
        }
        routes[routeKey] = Object.freeze({
            tools: Object.freeze([...entry.tools]),
            sha256: typeof entry.sha256 === 'string' ? entry.sha256 : null,
        });
    }
    return Object.freeze({ schema: PROD_GATES_SCHEMA, prod: parsed.prod, routes: Object.freeze(routes) });
}

const cache = new Map();

// The captured value, cached on the file's identity (dev, inode, mtime, size)
// so a replaced or rewritten capture is re-read on its next use and an
// unchanged one costs one stat. Unavailable (absent, unreadable or corrupt) is
// returned as `{ unavailable: true, reason }`; the Router and the agents treat
// it as PROD true.
export function readCapturedProdGates({ file = PROD_GATES_FILE } = {}) {
    let stat;
    try {
        stat = fs.statSync(file);
    } catch (error) {
        cache.delete(file);
        return unavailable(error?.code === 'ENOENT' ? 'absent' : 'unreadable');
    }
    if (!stat.isFile() || stat.size > MAX_CAPTURE_BYTES) {
        cache.delete(file);
        return unavailable('corrupt');
    }
    const key = `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.size}`;
    const hit = cache.get(file);
    if (hit && hit.key === key) return hit.value;
    let value;
    try {
        value = parseProdGates(fs.readFileSync(file, 'utf8'));
    } catch (_) {
        cache.delete(file);
        return unavailable('unreadable');
    }
    cache.set(file, { key, value });
    return value;
}

// The PROD value a process acts on: the captured value, or true when the
// capture is unavailable (fail closed).
export function capturedProdOrClosed(options) {
    const captured = readCapturedProdGates(options);
    return captured.unavailable ? true : captured.prod;
}

// The PROD value a CLI enforcement point (enable, expose) acts on before any
// start has captured one: absent means not captured yet, hence false, so a
// workspace that never started is not treated as production. A capture that
// exists but cannot be read is true (fail closed).
export function capturedProdIfCaptured(options) {
    const captured = readCapturedProdGates(options);
    if (!captured.unavailable) return captured.prod;
    return captured.reason !== 'absent';
}
