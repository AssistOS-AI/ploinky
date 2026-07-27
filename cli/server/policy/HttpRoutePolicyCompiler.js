import { normalizeHttpRoutePolicyEntry } from './HttpRouteAccessPolicy.js';
import { HttpRouteAccessPath } from './HttpRouteAccessPath.js';

const ACCESS_RANK = new Map([
    ['public', 1],
    ['guest', 2],
    ['authenticated', 3],
]);

function policyCompileError(message, code = 'HTTP_ROUTE_POLICY_INVALID') {
    const error = new Error(message);
    error.code = code;
    return error;
}

function normalizeRouteDefault(value, routeKey) {
    const access = String(value?.access || '').trim().toLowerCase();
    if (!ACCESS_RANK.has(access)) {
        throw policyCompileError(`route default for '${routeKey}' has invalid access '${access || '<empty>'}'`);
    }
    const selectedRouteKey = String(value?.routeKey || routeKey || '').trim();
    if (!selectedRouteKey) throw policyCompileError(`route default for '${routeKey}' has no route key`);
    const guestScope = value?.guestScope === undefined
        ? ''
        : String(value.guestScope || '').trim();
    if (value?.guestScope !== undefined && !guestScope) {
        throw policyCompileError(`route default for '${routeKey}' has an invalid guest scope`);
    }
    return {
        access,
        routeKey: selectedRouteKey,
        source: String(value?.source || 'routeDefault'),
        ...(guestScope ? { guestScope } : {}),
    };
}

function entryCore(entry) {
    return entry.path.endsWith('/*') ? entry.path.slice(0, -2) : entry.path;
}

function entryIntersectsNamespace(entry, root) {
    const core = entryCore(entry);
    if (entry.path.endsWith('/*')) {
        return core === root || core.startsWith(`${root}/`) || root.startsWith(`${core}/`);
    }
    return core === root || core.startsWith(`${root}/`);
}

function joinPath(segments) {
    return `/${segments.join('/')}`;
}

function representativePaths(root, entries) {
    const rootSegments = root.split('/').filter(Boolean);
    const boundaryCores = entries
        .filter((entry) => entryIntersectsNamespace(entry, root))
        .map(entryCore)
        .filter((core) => core === root || core.startsWith(`${root}/`));
    const boundaries = new Set([root]);
    for (const core of boundaryCores) {
        const segments = core.split('/').filter(Boolean);
        for (let length = rootSegments.length + 1; length <= segments.length; length += 1) {
            boundaries.add(joinPath(segments.slice(0, length)));
        }
    }

    const representatives = new Set(boundaries);
    for (const base of boundaries) {
        const usedChildren = new Set();
        for (const core of boundaryCores) {
            if (!core.startsWith(`${base}/`)) continue;
            const child = core.slice(base.length + 1).split('/')[0];
            if (child) usedChildren.add(child);
        }
        let suffix = 0;
        let candidate = '__ploinky_partition_gap__';
        while (usedChildren.has(candidate)) {
            suffix += 1;
            candidate = `__ploinky_partition_gap_${suffix}__`;
        }
        representatives.add(`${base}/${candidate}`);
    }

    return [...representatives].sort((left, right) => {
        const leftDepth = left.split('/').length;
        const rightDepth = right.split('/').length;
        return leftDepth - rightDepth || left.localeCompare(right);
    });
}

function executionMetadata(decision) {
    if (decision.access === 'public') return { access: 'public' };
    if (decision.access === 'guest') {
        return {
            access: 'guest',
            guestScope: decision.guestScope || `http-route:${decision.routeKey}`,
        };
    }
    return { access: 'authenticated', routeKey: decision.routeKey };
}

function metadataKey(decision) {
    return JSON.stringify(executionMetadata(decision));
}

function methodDecision(winner, method) {
    if (winner.access === 'public' && !HttpRouteAccessPath.isReadOnlyMethod(method)) {
        return {
            access: 'deny',
            status: 403,
            code: 'PUBLIC_ROUTE_WRITE_DENIED',
            routeKey: winner.routeKey,
            source: winner.source,
        };
    }
    return { ...winner };
}

function evaluateRepresentative({ representative, entries, routeDefault }) {
    const matching = entries.filter((entry) => HttpRouteAccessPath.matches(representative, entry.path));
    let winner;
    let tied = [];
    if (matching.length) {
        const rank = Math.max(...matching.map((entry) => ACCESS_RANK.get(entry.access) || 0));
        tied = matching.filter((entry) => ACCESS_RANK.get(entry.access) === rank);
        winner = tied[0];
        const expectedMetadata = metadataKey(winner);
        const conflict = tied.find((entry) => metadataKey(entry) !== expectedMetadata);
        if (conflict) {
            throw policyCompileError(
                `equal-rank HTTP policy tie at '${representative}' has conflicting execution metadata: `
                + `'${winner.source}:${winner.path}' versus '${conflict.source}:${conflict.path}'`,
                'HTTP_ROUTE_POLICY_TIE',
            );
        }
    } else {
        winner = routeDefault;
    }
    return {
        representative,
        matchingProviders: matching.map((entry) => ({
            path: entry.path,
            access: entry.access,
            routeKey: entry.routeKey,
            source: entry.source,
            ...(entry.guestScope ? { guestScope: entry.guestScope } : {}),
        })),
        winner: {
            ...winner,
            ...executionMetadata(winner),
        },
        methods: Object.fromEntries(['GET', 'HEAD', 'POST'].map((method) => [
            method,
            methodDecision(winner, method),
        ])),
    };
}

export function compileHttpRoutePolicy({
    entries = [],
    namespaces = [],
    routeDefaults = {},
} = {}) {
    const normalizedEntries = entries.map((entry, index) => normalizeHttpRoutePolicyEntry(
        entry,
        String(entry?.source || 'policy'),
        { strict: true, label: `HTTP policy provider[${index}]` },
    )).filter(Boolean);
    const normalizedDefaults = Object.fromEntries(Object.entries(routeDefaults).map(([routeKey, value]) => (
        [routeKey, normalizeRouteDefault(value, routeKey)]
    )));
    const seenNamespaces = new Set();
    const compiledNamespaces = namespaces.map((namespace, index) => {
        const id = String(namespace?.id || '').trim();
        const routeKey = String(namespace?.routeKey || '').trim();
        const normalized = HttpRouteAccessPath.normalize(String(namespace?.prefix || ''), { allowWildcard: false });
        if (!id || seenNamespaces.has(id) || !routeKey || !normalized.ok) {
            throw policyCompileError(`HTTP policy namespace[${index}] is invalid or duplicated`);
        }
        seenNamespaces.add(id);
        const routeDefault = normalizedDefaults[routeKey];
        if (!routeDefault) throw policyCompileError(`HTTP policy namespace '${id}' has no route default`);
        const partitions = representativePaths(normalized.path, normalizedEntries).map((representative) => (
            evaluateRepresentative({ representative, entries: normalizedEntries, routeDefault })
        ));
        if (namespace.requireAuthenticated === true) {
            const denied = partitions.find((partition) => (
                Object.values(partition.methods).some((decision) => decision.access !== 'authenticated')
            ));
            if (denied) {
                throw policyCompileError(
                    `private HTTP policy namespace '${id}' is not authenticated for every path/method partition`,
                    'PRIVATE_HTTP_POLICY_INVALID',
                );
            }
        }
        return {
            id,
            kind: String(namespace.kind || 'route'),
            routeKey,
            ...(namespace.slug ? { slug: String(namespace.slug) } : {}),
            prefix: normalized.path,
            requireAuthenticated: namespace.requireAuthenticated === true,
            partitions,
        };
    });
    return {
        entries: normalizedEntries,
        routeDefaults: normalizedDefaults,
        namespaces: compiledNamespaces,
    };
}

export default compileHttpRoutePolicy;
