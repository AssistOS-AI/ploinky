import fs from 'node:fs';
import path from 'node:path';

import { AGENT_PORT_ROUTE, parseAgentPortSelector } from '../server/agentPortConvention/parseSelector.js';

// An enabled agent may offer coding sessions that `ploinky cs` (`ploinky
// coding-sessions`) lists and opens as WebTTY terminals. The agent declares one
// API base on its own authenticated agent-port surface; Ploinky never names a
// provider, a robot or a coding agent itself, it only reads this declaration.
//
//   "webtty": {
//     "homeProfiles": { ... },
//     "codingSessions": { "version": 1, "api": "/base-agent-additional-server/<agent>/<port>/..." }
//   }
//
// Every route is a POST with an exact JSON body below that base:
//   robots   {}                                       -> {robots: [{id, name, default}]}
//   agents   {robot}                                  -> {robot: {id, name}, active, codingAgents: [name]}
//   history  {robot, codingAgent, directory}          -> {sessions: [{id, title, createdAt, updatedAt}]}
//   launch   {robot, codingAgent, directory, resume}  -> {profile, robot: {id, name}, codingAgent, nativeSessionId}
// `robot` is an id, a name or null for the default robot; `directory` is the
// workspace-relative folder, '' for the root; `resume` is a native session id
// or null. `launch` answers a WebTTY home profile of the same agent, which
// Ploinky opens in that folder. A refusal is a non-2xx answer whose `error` the
// user sees.

export const CODING_SESSION_COMMANDS = Object.freeze(['cs', 'coding-sessions']);
const MAX_MANIFEST_BYTES = 1024 * 1024;

function plainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected) {
    if (!plainObject(value)) return false;
    const keys = Object.keys(value).sort();
    const target = [...expected].sort();
    return keys.length === target.length && keys.every((key, index) => key === target[index]);
}

export function codingSessionDeclaration(manifest, routeKey) {
    const webtty = plainObject(manifest?.webtty) ? manifest.webtty : null;
    const declaration = webtty?.codingSessions;
    // The launched profile is a home profile, so the agent must also provide them.
    if (!plainObject(webtty?.homeProfiles) || !exactKeys(declaration, ['version', 'api'])
        || declaration.version !== 1) return null;
    const { api } = declaration;
    if (typeof api !== 'string' || !api.startsWith(`/${AGENT_PORT_ROUTE}/`) || api.length > 1024
        || /[\u0000- \u007f%?#\\]/.test(api) || api.endsWith('/')) return null;
    let selector;
    try {
        selector = parseAgentPortSelector(api);
    } catch (_) {
        return null;
    }
    if (!selector || selector.agent !== routeKey || selector.rawAgent !== routeKey
        || selector.query !== '' || selector.policyPath !== api) return null;
    return Object.freeze({ version: 1, api });
}

function readJson(file, { readFile = fs.readFileSync, maxBytes = MAX_MANIFEST_BYTES } = {}) {
    try {
        const text = readFile(file, 'utf8');
        if (typeof text !== 'string' || Buffer.byteLength(text) > maxBytes) return null;
        return JSON.parse(text);
    } catch (_) {
        return null;
    }
}

// The enabled agents of a workspace that declare coding sessions, read from the
// workspace routing table and each agent's own manifest. Missing or invalid
// files yield no provider; nothing is written.
export function listCodingSessionProviders(workspaceRoot, { readFile = fs.readFileSync } = {}) {
    if (typeof workspaceRoot !== 'string' || !path.isAbsolute(workspaceRoot)) return [];
    const routing = readJson(path.join(workspaceRoot, '.ploinky', 'routing.json'), { readFile });
    const routes = plainObject(routing?.routes) ? routing.routes : {};
    const providers = [];
    for (const [routeKey, route] of Object.entries(routes)) {
        if (!plainObject(route) || route.disabled || route.draining) continue;
        const { agent, repo, hostPath } = route;
        if (typeof agent !== 'string' || !agent || typeof repo !== 'string' || !repo
            || typeof hostPath !== 'string' || !path.isAbsolute(hostPath)) continue;
        const declaration = codingSessionDeclaration(readJson(path.join(hostPath, 'manifest.json'), { readFile }), routeKey);
        if (!declaration) continue;
        providers.push(Object.freeze({ routeKey, agent, repo, ...declaration }));
    }
    return providers.sort((left, right) => left.routeKey.localeCompare(right.routeKey));
}

export function isCodingSessionsCommand(command) {
    return CODING_SESSION_COMMANDS.includes(command);
}
