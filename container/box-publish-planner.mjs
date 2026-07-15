import {
    formatPortRange,
    intervalsOverlap,
    manifestClaimsEqual,
    parseExplicitPublishSpec,
    parseManifestOpenPortSpec,
} from './publish-spec.mjs';
import crypto from 'node:crypto';
import { parseRouterPort } from '../cli/services/routerPort.js';

export function implicitAgentServerBoxPort(instanceKey) {
    const key = String(instanceKey || '').trim();
    if (!key) throw new Error('implicit AgentServer mapping requires an effective instance key');
    const value = crypto.createHash('sha256').update(key).digest().readUInt32BE(0);
    return 20000 + (value % 40000);
}

/**
 * Validate and turn authoritative, already-resolved graph nodes into outer-box
 * publication claims. This module deliberately does not discover manifests or
 * repositories: the in-box planner service owns that workspace-aware work.
 */
export function planBoxPublishes({
    nodes = [],
    explicitPublishes = [],
    routerPort,
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
        const networkMode = String(node?.networkMode || node?.network?.mode || 'default').trim();
        if (!['default', 'bridge', 'host', 'none'].includes(networkMode)) {
            throw new Error(`agent ${node?.agentRef || node?.id || '<unknown>'} has unsupported network mode '${networkMode}'`);
        }
        const openPorts = normalizeOpenPorts(node?.openPorts, node?.agentRef || node?.id || '<unknown>');
        const parsedOpenPorts = openPorts.map((raw) => parseManifestOpenPortSpec(raw));
        if (networkMode === 'none' && parsedOpenPorts.length) {
            throw new Error(`agent ${node?.agentRef || node?.id || '<unknown>'} uses network mode 'none' and cannot declare openPorts`);
        }
        const declarations = [...parsedOpenPorts];
        const private7000Mapped = parsedOpenPorts.some((parsed) => (
            parsed.protocol === 'tcp'
            && parsed.privateContainer.start <= 7000
            && parsed.privateContainer.end >= 7000
        ));
        if (node?.implicitAgentServer === true && ['default', 'bridge'].includes(networkMode) && !private7000Mapped) {
            const port = Number(node.implicitAgentServerPort || implicitAgentServerBoxPort(
                node?.instanceKey || node?.id || node?.agentRef,
            ));
            declarations.push(parseManifestOpenPortSpec(`127.0.0.1:${port}:7000`));
        }
        for (const parsed of declarations) {
            const physicalHost = { ...parsed.boxSide };
            const boxSide = networkMode === 'host'
                ? { ...parsed.privateContainer }
                : { ...parsed.boxSide };
            const claim = {
                ...parsed,
                networkMode,
                physicalHost,
                boxSide,
                target: `${formatPortRange(boxSide)}/${parsed.protocol}`,
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
                if (existing.protocol !== claim.protocol) continue;
                const boxOverlap = intervalsOverlap(existing.boxSide, claim.boxSide);
                const physicalOverlap = intervalsOverlap(existing.physicalHost, claim.physicalHost);
                if (!boxOverlap && !physicalOverlap) continue;
                if (existing.nodeKey === claim.nodeKey
                    && manifestClaimsEqual(existing, claim)
                    && existing.networkMode === claim.networkMode
                    && existing.physicalHost.start === claim.physicalHost.start
                    && existing.physicalHost.end === claim.physicalHost.end) {
                    duplicate = true;
                    break;
                }
                throw new Error(formatClaimConflict(existing, claim, boxOverlap ? 'box-namespace' : 'physical-host'));
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
    const port = parseRouterPort(routerPort, { source: 'reserved outer router port' });
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
    const targetRange = formatPortRange(interval);
    const offset = interval.start - claim.boxSide.start;
    const physical = {
        start: claim.physicalHost.start + offset,
        end: claim.physicalHost.start + offset + (interval.end - interval.start),
    };
    const physicalRange = formatPortRange(physical);
    const suffix = claim.protocol === 'tcp' ? '' : `/${claim.protocol}`;
    return `${claim.hostIp}:${physicalRange}:${targetRange}${suffix}`;
}

function formatClaimConflict(existing, claim, scope = 'box-namespace') {
    const left = scope === 'physical-host' ? existing.physicalHost : existing.boxSide;
    const right = scope === 'physical-host' ? claim.physicalHost : claim.boxSide;
    const overlapStart = Math.max(left.start, right.start);
    const overlapEnd = Math.min(left.end, right.end);
    const overlap = formatPortRange({ start: overlapStart, end: overlapEnd });
    return `overlapping openPorts ${scope} socket ${overlap}/${claim.protocol}: ${describeClaim(existing)} conflicts with ${describeClaim(claim)}`;
}

function describeClaim(claim) {
    const identity = claim.alias ? `alias ${claim.alias}` : 'canonical instance';
    const path = claim.path?.length ? `, path ${claim.path.join(' -> ')}` : '';
    return `${claim.ownerRef} (profile ${claim.profile}, ${identity}${path}, network ${claim.networkMode}, ${claim.bindClass} bind ${claim.hostIp || '(engine default)'}) declares '${claim.raw}' (physical ${formatPortRange(claim.physicalHost)} -> box ${formatPortRange(claim.boxSide)} -> private ${formatPortRange(claim.privateContainer)})`;
}
