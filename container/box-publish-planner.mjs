import {
    formatPortRange,
    intervalsOverlap,
    manifestClaimsEqual,
    parseExplicitPublishSpec,
    parseManifestOpenPortSpec,
} from './publish-spec.mjs';

export const DEFAULT_BOX_ROUTER_PORT = 8080;

/**
 * Validate and turn authoritative, already-resolved graph nodes into outer-box
 * publication claims. This module deliberately does not discover manifests or
 * repositories: the in-box planner service owns that workspace-aware work.
 */
export function planBoxPublishes({
    nodes = [],
    explicitPublishes = [],
    routerPort = DEFAULT_BOX_ROUTER_PORT,
} = {}) {
    if (!Array.isArray(nodes)) {
        throw new Error('box publish planner requires an array of authoritative nodes');
    }
    if (!Array.isArray(explicitPublishes)) {
        throw new Error('box publish planner requires explicitPublishes to be an array');
    }

    const claims = collectManifestClaims(nodes);
    assertRouterSocketAvailable(claims, routerPort);

    const explicit = explicitPublishes.map((raw, index) => {
        try {
            return parseExplicitPublishSpec(raw);
        } catch (error) {
            throw new Error(`invalid explicit publish at index ${index}: ${error?.message || error}`);
        }
    });
    const generatedPublishes = claims.flatMap((claim) => {
        const covering = explicit
            .filter((entry) => entry.protocol === claim.protocol)
            .map((entry) => entry.containerTarget);
        return subtractIntervals(claim.boxSide, covering)
            .map((interval) => formatGeneratedPublish(claim, interval));
    });

    return {
        claims,
        explicitPublishes: explicitPublishes.map((value) => String(value)),
        generatedPublishes,
        publishes: [...explicitPublishes.map((value) => String(value)), ...generatedPublishes],
    };
}

export function collectManifestClaims(nodes = []) {
    const claims = [];
    for (const node of nodes) {
        const openPorts = normalizeOpenPorts(node?.openPorts, node?.agentRef || node?.id || '<unknown>');
        for (const raw of openPorts) {
            const parsed = parseManifestOpenPortSpec(raw);
            const claim = {
                ...parsed,
                ownerRef: String(node?.agentRef || node?.ref || '').trim(),
                profile: String(node?.profile || 'default').trim().toLowerCase() || 'default',
                alias: String(node?.alias || '').trim(),
                nodeKey: String(node?.instanceKey || node?.id || node?.agentRef || '').trim(),
                path: Array.isArray(node?.selectionPath)
                    ? node.selectionPath.map((entry) => String(entry))
                    : [],
            };
            let duplicate = false;
            for (const existing of claims) {
                if (existing.protocol !== claim.protocol || !intervalsOverlap(existing.boxSide, claim.boxSide)) {
                    continue;
                }
                if (existing.nodeKey === claim.nodeKey && manifestClaimsEqual(existing, claim)) {
                    duplicate = true;
                    break;
                }
                throw new Error(formatClaimConflict(existing, claim));
            }
            if (!duplicate) claims.push(claim);
        }
    }
    return claims;
}

export function subtractIntervals(source, exclusions = []) {
    let remaining = [{ start: source.start, end: source.end }];
    const normalized = mergeIntervals(
        exclusions
            .filter((entry) => entry && Number.isInteger(entry.start) && Number.isInteger(entry.end))
            .filter((entry) => intervalsOverlap(source, entry))
            .map((entry) => ({
                start: Math.max(source.start, entry.start),
                end: Math.min(source.end, entry.end),
            })),
    );
    for (const exclusion of normalized) {
        const next = [];
        for (const interval of remaining) {
            if (!intervalsOverlap(interval, exclusion)) {
                next.push(interval);
                continue;
            }
            if (interval.start < exclusion.start) {
                next.push({ start: interval.start, end: exclusion.start - 1 });
            }
            if (exclusion.end < interval.end) {
                next.push({ start: exclusion.end + 1, end: interval.end });
            }
        }
        remaining = next;
    }
    return remaining.map((interval) => ({
        ...interval,
        length: interval.end - interval.start + 1,
    }));
}

export function mergeIntervals(intervals = []) {
    const sorted = intervals
        .map((entry) => ({ start: entry.start, end: entry.end }))
        .sort((left, right) => left.start - right.start || left.end - right.end);
    const merged = [];
    for (const interval of sorted) {
        const previous = merged.at(-1);
        if (!previous || interval.start > previous.end + 1) {
            merged.push({ ...interval });
        } else {
            previous.end = Math.max(previous.end, interval.end);
        }
    }
    return merged.map((interval) => ({
        ...interval,
        length: interval.end - interval.start + 1,
    }));
}

export function publishTarget(spec) {
    return parseManifestOpenPortSpec(spec).target;
}

export function parseOpenPortPublishSpec(spec) {
    return parseManifestOpenPortSpec(spec);
}

function normalizeOpenPorts(value, ref) {
    if (value === undefined || value === null) return [];
    const values = Array.isArray(value) ? value : [value];
    return values.map((entry) => {
        if (typeof entry !== 'string' || !entry.trim()) {
            throw new Error(`agent ${ref} has malformed openPorts entry`);
        }
        return entry.trim();
    });
}

function assertRouterSocketAvailable(claims, routerPort) {
    const port = Number(routerPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`invalid reserved router port '${routerPort}'`);
    }
    const conflict = claims.find((claim) => (
        claim.protocol === 'tcp'
        && claim.boxSide.start <= port
        && claim.boxSide.end >= port
    ));
    if (conflict) {
        throw new Error(
            `openPorts claim conflicts with reserved outer router socket ${port}/tcp: ${describeClaim(conflict)}`,
        );
    }
}

function formatGeneratedPublish(claim, interval) {
    const range = formatPortRange(interval);
    const suffix = claim.protocol === 'tcp' ? '' : `/${claim.protocol}`;
    return `${claim.hostIp}:${range}:${range}${suffix}`;
}

function formatClaimConflict(existing, claim) {
    const overlapStart = Math.max(existing.boxSide.start, claim.boxSide.start);
    const overlapEnd = Math.min(existing.boxSide.end, claim.boxSide.end);
    const overlap = formatPortRange({ start: overlapStart, end: overlapEnd });
    return `overlapping openPorts box-side socket ${overlap}/${claim.protocol}: ${describeClaim(existing)} conflicts with ${describeClaim(claim)}`;
}

function describeClaim(claim) {
    const identity = claim.alias ? `alias ${claim.alias}` : 'canonical instance';
    const path = claim.path?.length ? `, path ${claim.path.join(' -> ')}` : '';
    return `${claim.ownerRef} (profile ${claim.profile}, ${identity}${path}, ${claim.bindClass} bind ${claim.hostIp || '(engine default)'}) declares '${claim.raw}' (box ${formatPortRange(claim.boxSide)} -> private ${formatPortRange(claim.privateContainer)})`;
}
