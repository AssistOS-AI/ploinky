import { FileSystemPolicyStateStore } from './FileSystemPolicyStateStore.js';

/**
 * PolicyStateRepository — the domain layer for the router access-control policy
 * (`policy-state.json`, schema `router-policy`). Holds the two collections —
 * `httpRoutes` (HTTP whitelist) and `mcpTools` (MCP access policy).
 *
 * Single responsibility: validate/index/cache the policy state and run the
 * read-modify-write `mutate` transaction with fail-closed semantics. A corrupt or
 * schema-invalid document FAILS CLOSED — readers report `corrupt` so callers deny,
 * and `mutate` refuses rather than clobbering. The raw persistence mechanism is a
 * pluggable `PolicyStateStore` (Strategy/Adapter); it defaults to the filesystem
 * (`FileSystemPolicyStateStore`) but a database can be dropped in unchanged. DS014.
 */

const SCHEMA = 'router-policy';
const MCP_ACCESS_VALUES = new Set(['authenticated', 'internal', 'admin']);
const HTTP_ROUTE_ACCESS_VALUES = new Set(['public', 'guest', 'authenticated']);

function emptyState() {
    return { schema: SCHEMA, httpRoutes: [], mcpTools: [] };
}

function cloneState(state) {
    return {
        schema: SCHEMA,
        httpRoutes: state.httpRoutes.map((entry) => ({ ...entry })),
        mcpTools: state.mcpTools.map((entry) => ({ ...entry })),
    };
}

function validateState(parsed) {
    if (!parsed || typeof parsed !== 'object' || parsed.schema !== SCHEMA) {
        throw new Error('policy-state: unexpected schema');
    }
    const httpRoutes = Array.isArray(parsed.httpRoutes) ? parsed.httpRoutes : null;
    const mcpTools = Array.isArray(parsed.mcpTools) ? parsed.mcpTools : null;
    if (!httpRoutes || !mcpTools) {
        throw new Error('policy-state: missing httpRoutes/mcpTools collections');
    }
    for (const entry of mcpTools) {
        if (!entry || typeof entry.agent !== 'string' || !entry.agent
            || typeof entry.tool !== 'string' || !entry.tool
            || !MCP_ACCESS_VALUES.has(entry.access)) {
            throw new Error('policy-state: invalid mcpTools entry');
        }
    }
    for (const entry of httpRoutes) {
        if (!entry || typeof entry.path !== 'string' || !entry.path
            || !HTTP_ROUTE_ACCESS_VALUES.has(String(entry.access || '').trim().toLowerCase())) {
            throw new Error('policy-state: invalid httpRoutes entry');
        }
    }
    return { schema: SCHEMA, httpRoutes, mcpTools };
}

function buildIndex(state) {
    const mcp = new Map();
    const http = new Map();
    for (const entry of state.mcpTools) {
        mcp.set(`${entry.agent} ${entry.tool}`, entry);
    }
    for (const entry of state.httpRoutes) {
        http.set(entry.path, entry);
    }
    return { mcp, http };
}

export class PolicyStateRepository {
    constructor({ store } = {}) {
        this._store = store || new FileSystemPolicyStateStore();
        this._cache = null;
        this._cacheKey = '';
    }

    // Returns { ok:true, state, index } or { ok:false, corrupt:true }.
    _load() {
        let version;
        try {
            version = this._store.currentVersion();
        } catch (err) {
            // A store that cannot even report its version is treated as corrupt (fail closed).
            console.error(`[ploinky] policy-state is unavailable; failing closed: ${err?.message || err}`);
            this._cache = { ok: false, corrupt: true };
            this._cacheKey = '';
            return this._cache;
        }
        if (version === null || version === undefined) {
            // Nothing persisted yet: a valid EMPTY state (callers still deny on missing entries).
            const state = emptyState();
            this._cache = { ok: true, state, index: buildIndex(state) };
            this._cacheKey = '';
            return this._cache;
        }
        if (this._cache && this._cacheKey === version) {
            return this._cache;
        }
        try {
            const { document } = this._store.read();
            const state = validateState(document);
            this._cache = { ok: true, state, index: buildIndex(state) };
        } catch (err) {
            console.error(`[ploinky] policy-state is invalid; failing closed: ${err?.message || err}`);
            this._cache = { ok: false, corrupt: true };
        }
        this._cacheKey = version;
        return this._cache;
    }

    invalidate() {
        this._cache = null;
        this._cacheKey = '';
    }

    isCorrupt() {
        return this._load().ok === false;
    }

    getMcpToolEntry(agent, tool) {
        const loaded = this._load();
        if (!loaded.ok) return { corrupt: true };
        return loaded.index.mcp.get(`${String(agent)} ${String(tool)}`) || null;
    }

    listMcpTools() {
        const loaded = this._load();
        if (!loaded.ok) return { corrupt: true, entries: [] };
        return { corrupt: false, entries: loaded.state.mcpTools.map((entry) => ({ ...entry })) };
    }

    listHttpRoutes() {
        const loaded = this._load();
        if (!loaded.ok) return { corrupt: true, entries: [] };
        return { corrupt: false, entries: loaded.state.httpRoutes.map((entry) => ({ ...entry })) };
    }

    getHttpRouteEntry(normalizedPath) {
        const loaded = this._load();
        if (!loaded.ok) return { corrupt: true };
        return loaded.index.http.get(String(normalizedPath)) || null;
    }

    /**
     * Read the current state (failing closed if corrupt), pass a deep clone to
     * `updater`, validate the result, and atomically persist it. Returns the new
     * persisted state. Throws a `POLICY_PERSISTENCE_ERROR`-coded error on a
     * corrupt existing file so a bad state is never silently overwritten.
     */
    mutate(updater) {
        const loaded = this._load();
        if (!loaded.ok) {
            const err = new Error('policy-state is corrupt; refusing to overwrite');
            err.code = 'POLICY_PERSISTENCE_ERROR';
            throw err;
        }
        const draft = cloneState(loaded.state);
        const result = updater(draft) || draft;
        const validated = validateState(result);
        this._store.write(validated);
        this.invalidate();
        return validated;
    }
}

export { SCHEMA, MCP_ACCESS_VALUES, HTTP_ROUTE_ACCESS_VALUES };
export default PolicyStateRepository;
