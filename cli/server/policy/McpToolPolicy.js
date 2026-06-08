import fs from 'node:fs';
import path from 'node:path';

import { REPOS_DIR } from '../../services/config.js';

/**
 * McpToolPolicy — MCP tool access decisions (DS014). Maps mcp-config `tags` to
 * default access classes, bootstraps persisted policy at boot (persisted wins),
 * and evaluates whether a caller may invoke a tool. Fail-closed: missing /
 * unknown / ambiguous policy denies.
 *
 * Access classes: `authenticated` (any router-authenticated session — a `user`
 * or a `guest` that passed the agent's route auth), `admin` (admin users only),
 * `internal` (source agents only). Reads/writes via an injected repository.
 */

const ACCESS_TAGS = new Set(['authenticated', 'internal', 'admin']);

export class McpToolPolicy {
    constructor({ repository }) {
        this._repo = repository;
    }

    // Classify a tool's tags. Only access tags are recognized; any other tag is
    // invalid (fail closed). `internal`+`admin` is invalid. Empty → authenticated.
    accessFromTags(tags) {
        const list = Array.isArray(tags)
            ? tags.map((tag) => String(tag || '').trim().toLowerCase()).filter(Boolean)
            : [];
        for (const tag of list) {
            if (!ACCESS_TAGS.has(tag)) {
                return { invalid: true, reason: `unknown tag '${tag}'` };
            }
        }
        const set = new Set(list);
        if (set.has('internal') && set.has('admin')) {
            return { invalid: true, reason: 'internal+admin is not a valid combination' };
        }
        if (set.has('internal')) return { access: 'internal' };
        if (set.has('admin')) return { access: 'admin' };
        return { access: 'authenticated' };
    }

    _readMcpConfigTools(agentDir) {
        if (!agentDir) return [];
        try {
            const parsed = JSON.parse(fs.readFileSync(path.join(agentDir, 'mcp-config.json'), 'utf8'));
            return Array.isArray(parsed?.tools) ? parsed.tools : [];
        } catch {
            return [];
        }
    }

    _resolveAgentDir(route) {
        if (route && typeof route.hostPath === 'string' && route.hostPath) {
            return route.hostPath;
        }
        const repo = String(route?.repo || '').trim();
        const agent = String(route?.agent || '').trim();
        return repo && agent ? path.join(REPOS_DIR, repo, agent) : '';
    }

    // Build `[{ agent, tool, access }]` defaults from each route's mcp-config
    // tags. Tools with invalid tags are skipped (logged) → deny by default.
    // The policy key is the ROUTE KEY (the URL/alias segment), because that is
    // the identifier enforcement evaluates against (`evaluate({ agent })` where
    // `agent` is the route segment from the request URL). Keying on `route.agent`
    // instead would leave aliased routes failing closed at runtime.
    collectDefaults(routes = {}) {
        const defaults = [];
        for (const [routeKey, route] of Object.entries(routes || {})) {
            const agentName = String(routeKey || route?.agent || '').trim();
            if (!agentName) continue;
            for (const tool of this._readMcpConfigTools(this._resolveAgentDir(route))) {
                const toolName = typeof tool?.name === 'string' ? tool.name : '';
                if (!toolName) continue;
                const classified = this.accessFromTags(tool.tags);
                if (classified.invalid) {
                    console.error(`[ploinky] MCP tool ${agentName}/${toolName} has invalid access tags (${classified.reason}); leaving it deny-by-default.`);
                    continue;
                }
                defaults.push({ agent: agentName, tool: toolName, access: classified.access });
            }
        }
        return defaults;
    }

    // Persist a default entry for any agent+tool with no existing entry. A
    // persisted entry (e.g. admin-edited) always wins and is never overwritten.
    bootstrapDefaults(defaults = []) {
        if (!Array.isArray(defaults) || !defaults.length) return { added: 0 };
        let added = 0;
        try {
            this._repo.mutate((state) => {
                const seen = new Set(state.mcpTools.map((entry) => `${entry.agent} ${entry.tool}`));
                const now = new Date().toISOString();
                for (const def of defaults) {
                    const key = `${def.agent} ${def.tool}`;
                    if (seen.has(key)) continue;
                    state.mcpTools.push({
                        agent: def.agent,
                        tool: def.tool,
                        access: def.access,
                        source: 'mcp-config',
                        enabled: true,
                        createdAt: now,
                        createdBy: 'router:boot',
                        updatedAt: now,
                        updatedBy: 'router:boot',
                    });
                    seen.add(key);
                    added += 1;
                }
                return state;
            });
        } catch (err) {
            console.error(`[ploinky] MCP policy bootstrap skipped: ${err?.message || err}`);
        }
        return { added };
    }

    // Convenience for boot: collect defaults from routes, then persist them.
    bootstrap(routes = {}) {
        return this.bootstrapDefaults(this.collectDefaults(routes));
    }

    // Decide whether `caller` may invoke `agent`/`tool`. Fail-closed.
    evaluate({ agent, tool, caller }) {
        const entry = this._repo.getMcpToolEntry(agent, tool);
        if (entry && entry.corrupt) {
            return { allow: false, code: 'POLICY_PERSISTENCE_ERROR', status: 500 };
        }
        if (!entry || entry.enabled === false) {
            return { allow: false, code: 'AGENT_POLICY_DENIED', status: 403 };
        }
        const access = entry.access;
        const kind = caller?.kind;
        if (kind === 'agent') {
            return access === 'internal'
                ? { allow: true, access }
                : { allow: false, code: 'AGENT_POLICY_DENIED', status: 403 };
        }
        if (kind === 'user' || kind === 'guest') {
            if (access === 'authenticated') {
                return { allow: true, access };
            }
            if (access === 'admin') {
                return caller.isAdmin
                    ? { allow: true, access }
                    : { allow: false, code: 'ADMIN_REQUIRED', status: 403 };
            }
            return { allow: false, code: 'AGENT_POLICY_DENIED', status: 403 };
        }
        return { allow: false, code: 'AUTH_REQUIRED', status: 401 };
    }

    // Decide whether `caller` may read/list MCP resources. Resources are not in
    // the per-tool policy model (per-resource admin/internal tagging is deferred,
    // DS014); they are an `authenticated`-class capability — any router-
    // authenticated session (user/guest/admin) may read, but internal agent
    // callers and anonymous callers may not. Fail-closed for unknown kinds.
    evaluateResource({ caller }) {
        const kind = caller?.kind;
        if (kind === 'user' || kind === 'guest') {
            return { allow: true };
        }
        if (kind === 'agent') {
            return { allow: false, code: 'AGENT_POLICY_DENIED', status: 403 };
        }
        return { allow: false, code: 'AUTH_REQUIRED', status: 401 };
    }

    // Keep only the tools the caller is allowed to invoke (for tools/list).
    filterTools(agent, tools, caller) {
        if (!Array.isArray(tools)) return [];
        return tools.filter((tool) => {
            const name = typeof tool?.name === 'string' ? tool.name : '';
            return name ? this.evaluate({ agent, tool: name, caller }).allow : false;
        });
    }
}

export default McpToolPolicy;
