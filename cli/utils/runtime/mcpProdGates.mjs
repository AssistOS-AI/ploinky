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

// The tools of one agent directory that carry the `prod-disabled` tag, with the
// digest of the mcp-config they came from. A missing or unparsable mcp-config
// gates nothing, exactly as `McpToolPolicy` reads no tools from it.
function readMcpConfigGate(agentDir) {
    const file = path.join(agentDir, MCP_CONFIG);
    let bytes;
    try {
        bytes = fs.readFileSync(file);
    } catch (_) {
        return { file, present: false, tools: [], sha256: null };
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    let tools = [];
    try {
        const parsed = JSON.parse(bytes.toString('utf8'));
        tools = (Array.isArray(parsed?.tools) ? parsed.tools : [])
            .filter((tool) => typeof tool?.name === 'string' && tool.name
                && Array.isArray(tool.tags) && tool.tags.some((tag) => normalizeTag(tag) === PROD_DISABLED_TAG))
            .map((tool) => tool.name);
    } catch (_) {
        tools = [];
    }
    return { file, present: true, tools: [...new Set(tools)].sort(), sha256 };
}

// git with no inherited repository selection, and nothing the repository's
// own configuration can run.
function runGit(directory, args) {
    const env = { ...process.env };
    for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR']) delete env[name];
    try {
        const stdout = execFileSync('git', ['-C', directory, '-c', 'core.fsmonitor=false', ...args], {
            env,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 30_000,
        });
        return { status: 0, stdout };
    } catch (error) {
        return { status: typeof error?.status === 'number' ? error.status : -1, stdout: '' };
    }
}

// Why an mcp-config cannot be trusted to equal git HEAD, or '' when it is
// tracked and identical to HEAD.
function mcpConfigDirtyReason(agentDir, git) {
    const file = path.join(agentDir, MCP_CONFIG);
    try {
        if (fs.lstatSync(file).isSymbolicLink()) return 'is a symbolic link';
    } catch (_) {
        return 'cannot be read';
    }
    if (git(agentDir, ['rev-parse', '--is-inside-work-tree']).status !== 0) {
        return 'is outside a git repository';
    }
    if (git(agentDir, ['ls-files', '--error-unmatch', '--', MCP_CONFIG]).status !== 0) {
        return 'is untracked';
    }
    const diff = git(agentDir, ['diff', '--quiet', 'HEAD', '--', MCP_CONFIG]);
    if (diff.status === 0) return '';
    return diff.status === 1 ? 'differs from git HEAD' : 'could not be compared with git HEAD';
}

function routeEntry(gate) {
    return { tools: gate.tools, sha256: gate.sha256 };
}

// Under PROD, every captured route's mcp-config must be tracked and equal to
// git HEAD, tagged or not: the capture proves the gate set a deploy reviewed.
function assertCleanUnderProd(gates, git) {
    const files = [];
    for (const [routeKey, gate] of gates) {
        if (!gate.present) continue;
        const reason = mcpConfigDirtyReason(path.dirname(gate.file), git);
        if (reason) files.push({ routeKey, file: gate.file, reason });
    }
    if (files.length) {
        throw gateError(
            PROD_GATES_DIRTY_CODE,
            `PROD true: ${files.length} mcp-config file${files.length === 1 ? '' : 's'} must be tracked and identical to git HEAD before the gates are captured: `
            + files.map((entry) => `${entry.routeKey} (${entry.file} ${entry.reason})`).join('; '),
            { files },
        );
    }
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
export function dryCaptureProdGates({ prod = readProd(), routes, git = runGit } = {}) {
    const gates = new Map(normalizeRoutes(routes).map(([routeKey, agentDir]) => [routeKey, readMcpConfigGate(agentDir)]));
    if (prod) assertCleanUnderProd(gates, git);
    return {
        schema: PROD_GATES_SCHEMA,
        prod: Boolean(prod),
        routes: Object.fromEntries([...gates].map(([routeKey, gate]) => [routeKey, routeEntry(gate)])),
    };
}

// Extend a dry capture with routes that were not known when it ran (a graph
// resolved after the repositories were prepared). The dirty check applies to
// the added routes only when the capture's `prod` is true.
export function extendProdCapture(capture, routes, { git = runGit } = {}) {
    const added = normalizeRoutes(routes).filter(([routeKey]) => !Object.hasOwn(capture.routes, routeKey));
    if (!added.length) return capture;
    const gates = new Map(added.map(([routeKey, agentDir]) => [routeKey, readMcpConfigGate(agentDir)]));
    if (capture.prod) assertCleanUnderProd(gates, git);
    return {
        ...capture,
        routes: Object.fromEntries(
            Object.entries({
                ...capture.routes,
                ...Object.fromEntries([...gates].map(([routeKey, gate]) => [routeKey, routeEntry(gate)])),
            }).sort(([left], [right]) => left.localeCompare(right)),
        ),
    };
}

// Atomic write into controller-only state. An identical file is left alone so
// its identity, and the Router's cached read, stay put.
export function writeProdGates(capture, { file = PROD_GATES_FILE } = {}) {
    const text = `${JSON.stringify(capture, null, 2)}\n`;
    try {
        if (fs.readFileSync(file, 'utf8') === text) return { written: false };
    } catch (_) { /* absent or unreadable: write it */ }
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, text, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, file);
    return { written: true };
}

// An enable (CLI, Marketplace or agent-triggered) merges only its own route
// into the existing capture. Under the captured PROD it runs the dirty check
// for that route; it never changes the captured `prod`. With no capture yet
// there is nothing to merge into: the next start captures every route. A
// capture that exists but cannot be read refuses (fail closed).
export function mergeEnabledRouteGates(routeKey, { agentDir, file = PROD_GATES_FILE, git = runGit } = {}) {
    const existing = readCapturedProdGates({ file });
    if (existing.unavailable) {
        if (existing.reason === 'absent') return { merged: false };
        throw gateError(
            PROD_GATES_UNAVAILABLE_CODE,
            `The captured production gates are ${existing.reason}; run a start or whole restart to capture them again.`,
        );
    }
    const gate = readMcpConfigGate(agentDir);
    if (existing.prod) assertCleanUnderProd(new Map([[routeKey, gate]]), git);
    const routes = {};
    for (const [key, entry] of Object.entries({ ...existing.routes, [routeKey]: routeEntry(gate) })
        .sort(([left], [right]) => left.localeCompare(right))) {
        routes[key] = { tools: [...entry.tools], sha256: entry.sha256 };
    }
    writeProdGates({ schema: PROD_GATES_SCHEMA, prod: existing.prod, routes }, { file });
    return { merged: true };
}
