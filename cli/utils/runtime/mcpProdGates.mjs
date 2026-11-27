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

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { CONTROLLER_STATE_DIR } from '../config.js';
import { readProd } from '../prodMode.mjs';

export const PROD_DISABLED_TAG = 'prod-disabled';
export const PROD_GATES_DIRTY_CODE = 'PLOINKY_PROD_GATES_DIRTY';
export const PROD_GATES_UNAVAILABLE_CODE = 'PLOINKY_PROD_POLICY_UNAVAILABLE';
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
    if (parsed.workspaceProfile !== undefined && (typeof parsed.workspaceProfile !== 'string' || !parsed.workspaceProfile)) return unavailable('corrupt');
    return Object.freeze({ schema: PROD_GATES_SCHEMA, prod: parsed.prod, routes: Object.freeze(routes),
        ...(parsed.workspaceProfile !== undefined ? { workspaceProfile: parsed.workspaceProfile } : {}) });
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

// ---------------------------------------------------------------------------
// Capture (CLI side, deploy path)
// ---------------------------------------------------------------------------

const MCP_CONFIG = 'mcp-config.json';

function gateError(code, message, details = {}) {
    return Object.assign(new Error(message), { code }, details);
}

function normalizeTag(tag) {
    return String(tag || '').trim().toLowerCase();
}

// Compare the exact bytes that supply the tool list with the committed blob.
// Reading HEAD through ls-tree also distinguishes a service without an MCP
// config from a tracked config that was deleted from the working tree.
function runGit(directory, args) {
    const env = { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' };
    for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR']) delete env[name];
    try {
        return execFileSync('git', ['-C', directory, '-c', 'core.fsmonitor=false', ...args], {
            env,
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 30_000,
            maxBuffer: MAX_CAPTURE_BYTES,
        });
    } catch {
        return null;
    }
}

function readRouteEntry(agentDir, prod) {
    const file = path.join(agentDir, MCP_CONFIG);
    let bytes = null;
    let stat = null;
    try {
        stat = fs.lstatSync(file);
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    if (stat) {
        if (prod && !stat.isFile()) throw new Error('is not a regular file');
        bytes = fs.readFileSync(file);
    }
    if (prod) {
        const tree = runGit(agentDir, ['ls-tree', '-z', 'HEAD', '--', MCP_CONFIG]);
        if (tree === null) throw new Error('cannot inspect git HEAD');
        const tracked = tree.toString('utf8');
        if (tracked || bytes !== null) {
            const entry = /^(100644|100755) blob ([0-9a-f]{40,64})\tmcp-config\.json\0$/.exec(tracked);
            if (!entry || bytes === null) throw new Error('must be a present regular file tracked in git HEAD');
            const [, mode, object] = entry;
            const index = runGit(agentDir, ['ls-files', '--stage', '-z', '--', MCP_CONFIG]);
            const original = runGit(agentDir, ['cat-file', 'blob', object]);
            if (index?.toString() !== `${mode} ${object} 0\t${MCP_CONFIG}\0`
                || !original?.equals(bytes)) throw new Error('differs from git HEAD');
        }
    }
    if (bytes === null) return { tools: [], sha256: null };
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    let parsed;
    try {
        parsed = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
        if (prod) throw new Error('contains invalid JSON');
        return { tools: [], sha256 };
    }
    const tools = (Array.isArray(parsed?.tools) ? parsed.tools : [])
        .filter((tool) => typeof tool?.name === 'string' && tool.name
            && Array.isArray(tool.tags) && tool.tags.some((tag) => normalizeTag(tag) === PROD_DISABLED_TAG))
        .map((tool) => tool.name);
    return { tools: [...new Set(tools)].sort(), sha256 };
}

function normalizeRoutes(routes) {
    const entries = Array.isArray(routes)
        ? routes.map((route) => [route?.routeKey, route?.agentDir])
        : Object.entries(routes || {});
    const byKey = new Map();
    for (const [routeKey, agentDir] of entries) {
        if (typeof routeKey !== 'string' || !routeKey || typeof agentDir !== 'string' || !agentDir) continue;
        byKey.set(routeKey, agentDir);
    }
    return [...byKey.entries()].sort(([left], [right]) => left.localeCompare(right));
}

// The capture a start or whole restart will write, computed with no write
// and run before the first mutation. `routes` names every enabled route and
// graph route as `{ routeKey, agentDir }`. Under PROD it refuses
// (PLOINKY_PROD_GATES_DIRTY) when any route's mcp-config is not tracked and
// identical to git HEAD.
export function dryCaptureProdGates({ prod = readProd(), routes, workspaceProfile } = {}) {
    const entries = [];
    const files = [];
    for (const [routeKey, agentDir] of normalizeRoutes(routes)) {
        try {
            entries.push([routeKey, readRouteEntry(agentDir, prod)]);
        } catch (error) {
            if (!prod) throw error;
            files.push({ routeKey, file: path.join(agentDir, MCP_CONFIG), reason: error.message });
        }
    }
    if (files.length) {
        const summary = files.map(({ routeKey, reason }) => `${routeKey} (${reason})`).join('; ');
        throw gateError(PROD_GATES_DIRTY_CODE, `Production policy capture refused: ${summary}`, { files });
    }
    return { schema: PROD_GATES_SCHEMA, prod: Boolean(prod), routes: Object.fromEntries(entries),
        ...(workspaceProfile ? { workspaceProfile } : {}) };
}

// Stage a policy no weaker than either generation while the selector changes.
// An unavailable predecessor stays unavailable until the new selector exists,
// except an absent one under a PROD capture: lease-less readers (the Router,
// Marketplace) must see PROD before the new selector does, so the capture
// itself is staged and its rollback removes it again.
export function stageProdGates(capture, { file = PROD_GATES_FILE } = {}) {
    let previousBytes;
    try { previousBytes = fs.readFileSync(file); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        previousBytes = null;
    }
    const previous = previousBytes === null ? unavailable('absent') : parseProdGates(previousBytes.toString('utf8'));
    let staged = false;
    if (!previous.unavailable) {
        const routes = {};
        for (const key of new Set([...Object.keys(previous.routes), ...Object.keys(capture.routes)])) {
            const oldEntry = previous.routes[key];
            const newEntry = capture.routes[key];
            routes[key] = { tools: [...new Set([...(oldEntry?.tools || []), ...(newEntry?.tools || [])])].sort(),
                sha256: newEntry?.sha256 || oldEntry?.sha256 || null };
        }
        const stagedCapture = { ...capture, prod: previous.prod || capture.prod, routes };
        if (previous.workspaceProfile) stagedCapture.workspaceProfile = previous.workspaceProfile;
        else delete stagedCapture.workspaceProfile;
        writeProdGates(stagedCapture, { file });
        staged = true;
    } else if (previousBytes === null && capture?.prod === true) {
        writeProdGates(capture, { file });
        staged = true;
    }
    return {
        staged,
        rollback() {
            if (!staged) return;
            if (previousBytes === null) {
                fs.rmSync(file, { force: true });
                fsyncDirectory(path.dirname(file));
                return;
            }
            const temporary = `${file}.${process.pid}.${Date.now()}.restore.tmp`;
            writeDurable(temporary, previousBytes);
            fs.renameSync(temporary, file);
            fsyncDirectory(path.dirname(file));
        },
        finalize() { writeProdGates(capture, { file }); },
    };
}

function fsyncDirectory(directory) {
    let fd;
    try {
        fd = fs.openSync(directory, fs.constants.O_RDONLY);
        fs.fsyncSync(fd);
    } catch (error) {
        // Not every host filesystem syncs directories; the file fsync and the
        // rename remain authoritative there.
        if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EBADF'].includes(error?.code)) throw error;
    } finally {
        if (fd !== undefined) {
            try { fs.closeSync(fd); } catch (_) {}
        }
    }
}

function writeDurable(file, bytes) {
    const fd = fs.openSync(file, 'w', 0o600);
    try {
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
}

// Atomic, durable write into controller-only state. An identical file is left
// alone so its identity, and the Router's cached read, stay put.
export function writeProdGates(capture, { file = PROD_GATES_FILE } = {}) {
    const text = `${JSON.stringify(capture, null, 2)}\n`;
    try {
        if (fs.readFileSync(file, 'utf8') === text) return { written: false };
    } catch (_) { /* absent or unreadable: write it */ }
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    writeDurable(temporary, text);
    fs.renameSync(temporary, file);
    fsyncDirectory(path.dirname(file));
    return { written: true };
}

// An enable (CLI, Marketplace or agent-triggered) merges only its own route
// into the existing capture. Under the captured PROD it runs the dirty check
// for that route; it never changes the captured `prod`. With no capture yet
// there is nothing to merge into: the next start captures every route. A
// capture that exists but cannot be read refuses (fail closed).
export function mergeEnabledRouteGates(routeKey, { agentDir, file = PROD_GATES_FILE } = {}) {
    const existing = readCapturedProdGates({ file });
    if (existing.unavailable) {
        if (existing.reason === 'absent') return { merged: false };
        throw gateError(
            PROD_GATES_UNAVAILABLE_CODE,
            `The captured production gates are ${existing.reason}; run a start or whole restart to capture them again.`,
        );
    }
    const capture = dryCaptureProdGates({ prod: existing.prod, routes: [{ routeKey, agentDir }] });
    const routes = {};
    for (const [key, entry] of Object.entries({ ...existing.routes, ...capture.routes })
        .sort(([left], [right]) => left.localeCompare(right))) {
        routes[key] = { tools: [...entry.tools], sha256: entry.sha256 };
    }
    writeProdGates({ schema: PROD_GATES_SCHEMA, prod: existing.prod, routes,
        ...(existing.workspaceProfile ? { workspaceProfile: existing.workspaceProfile } : {}) }, { file });
    return { merged: true };
}
