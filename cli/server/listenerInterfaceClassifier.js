import net from 'node:net';
import { execFile } from 'node:child_process';

import { NETWORK_SCHEMA_VERSION } from '../sandbox/networkContract.js';
import { NETWORK_LABELS, workspaceNetworkIdentity } from '../sandbox/networkLifecycle.js';

const REFRESH_INTERVAL_MS = 1_000;

function defaultRun(args, { signal } = {}) {
    return new Promise((resolve) => {
        execFile('podman', args, {
            encoding: 'utf8',
            timeout: 5_000,
            maxBuffer: 4 * 1024 * 1024,
            signal,
        }, (error, stdout, stderr) => {
            resolve({
                ok: !error,
                stdout: String(stdout || ''),
                stderr: String(stderr || error?.message || ''),
            });
        });
    });
}

function parseJsonRecords(source, description) {
    let parsed;
    try {
        parsed = JSON.parse(String(source || ''));
    } catch (error) {
        throw new Error(`${description} returned malformed JSON: ${error.message}`);
    }
    const records = Array.isArray(parsed) ? parsed : [parsed];
    if (records.some((record) => !record || typeof record !== 'object' || Array.isArray(record))) {
        throw new Error(`${description} returned an invalid record set`);
    }
    return records;
}

function labelsOf(record) {
    return record?.Labels || record?.labels || {};
}

function booleanValue(value, fallback) {
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'boolean') return value;
    if (String(value).toLowerCase() === 'true') return true;
    if (String(value).toLowerCase() === 'false') return false;
    return value;
}

function expectedLabels(workspaceHash, logicalName) {
    return {
        [NETWORK_LABELS.managed]: '1',
        [NETWORK_LABELS.resource]: 'network',
        [NETWORK_LABELS.schema]: NETWORK_SCHEMA_VERSION,
        [NETWORK_LABELS.workspace]: workspaceHash,
        [NETWORK_LABELS.logical]: logicalName,
    };
}

function assertExactObject(actual, expected, description) {
    const actualKeys = Object.keys(actual || {}).sort();
    const expectedKeys = Object.keys(expected).sort();
    if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)
        || !expectedKeys.every((key) => String(actual?.[key] ?? '') === expected[key])) {
        throw new Error(`${description} does not have the exact managed ownership labels`);
    }
}

export function validatedManagedGateway(record, { workspaceHash, expectedNamePrefix } = {}) {
    const name = String(record?.Name || record?.name || '');
    if (!name || !name.startsWith(String(expectedNamePrefix || ''))) {
        throw new Error(`network '${name || '<missing>'}' is outside the managed workspace namespace`);
    }
    const labels = labelsOf(record);
    const logicalName = String(labels?.[NETWORK_LABELS.logical] || '');
    if (!logicalName) throw new Error(`network '${name}' has no managed logical identity`);
    assertExactObject(labels, expectedLabels(workspaceHash, logicalName), `network '${name}'`);
    if (String(record.Driver || record.driver || '') !== 'bridge') {
        throw new Error(`network '${name}' is not an exact managed bridge`);
    }
    const internal = booleanValue(record.Internal ?? record.internal, false);
    const ipv6 = booleanValue(record.IPv6Enabled ?? record.ipv6_enabled ?? record.EnableIPv6, false);
    const dns = booleanValue(record.DNSEnabled ?? record.dns_enabled, true);
    if (internal !== false || ipv6 !== false || dns !== true) {
        throw new Error(`network '${name}' has unsupported isolation, IPv6, or DNS state`);
    }
    const options = record.Options || record.options || {};
    if (Object.keys(options).length !== 1 || String(options.isolate) !== 'true') {
        throw new Error(`network '${name}' is missing exact isolate=true bridge state`);
    }
    const ipamDriver = String(record.IPAM?.Driver || record.ipam_options?.driver || '');
    if (ipamDriver !== 'host-local') throw new Error(`network '${name}' has unsupported IPAM`);
    const ipamOptions = record.IPAM?.Options || record.ipam_options || {};
    if (Object.keys(ipamOptions).some((key) => key !== 'driver')) {
        throw new Error(`network '${name}' has unsupported IPAM options`);
    }
    const subnets = record.Subnets || record.subnets || record.IPAM?.Config;
    if (!Array.isArray(subnets) || subnets.length !== 1) {
        throw new Error(`network '${name}' must have exactly one IPv4 subnet`);
    }
    const subnet = subnets[0] || {};
    const subnetKeys = Object.keys(subnet).map((key) => key.toLowerCase()).sort();
    const cidr = String(subnet.Subnet || subnet.subnet || '');
    const gateway = String(subnet.Gateway || subnet.gateway || '');
    const [networkAddress, prefix = ''] = cidr.split('/');
    if (JSON.stringify(subnetKeys) !== JSON.stringify(['gateway', 'subnet'])
        || net.isIP(networkAddress) !== 4
        || !/^\d{1,2}$/.test(prefix)
        || Number(prefix) < 1
        || Number(prefix) > 32
        || net.isIP(gateway) !== 4) {
        throw new Error(`network '${name}' has unsupported subnet or gateway state`);
    }
    return gateway;
}

function normalizeAddress(value) {
    const address = String(value || '').trim().toLowerCase();
    if (address.startsWith('::ffff:') && net.isIP(address.slice(7)) === 4) return address.slice(7);
    return address;
}

function isLoopback(address) {
    if (address === '::1') return true;
    if (net.isIP(address) !== 4) return false;
    return address.split('.')[0] === '127';
}

export function createListenerInterfaceClassifier({
    workspaceRoot,
    run = defaultRun,
    now = () => Date.now(),
    refreshIntervalMs = REFRESH_INTERVAL_MS,
    platform = process.platform,
    managedGatewayDiscovery = true,
    schedule = (callback, delay) => setTimeout(callback, delay),
    cancelSchedule = (timer) => clearTimeout(timer),
} = {}) {
    if (typeof platform !== 'string' || !platform.trim()) {
        throw new TypeError('listener interface classifier platform must be a non-empty string');
    }
    if (!Number.isFinite(refreshIntervalMs) || refreshIntervalMs < 1) {
        throw new TypeError('listener interface classifier refresh interval must be positive');
    }
    if (typeof managedGatewayDiscovery !== 'boolean') {
        throw new TypeError('listener interface classifier managed gateway discovery must be boolean');
    }
    if (typeof schedule !== 'function' || typeof cancelSchedule !== 'function') {
        throw new TypeError('listener interface classifier scheduler must be callable');
    }
    // Native Linux binds the private Router to exact managed bridge gateways.
    // A Box instead owns one unpublished wildcard listener whose accepted
    // sockets carry explicit private provenance, so inspecting every nested
    // Podman network there adds no admission evidence and can starve agent
    // traffic on the single rootless runtime control plane.
    const bindsRuntimeBridgeGatewaysLocally = platform === 'linux' && managedGatewayDiscovery;
    const identity = workspaceNetworkIdentity(workspaceRoot);
    const namePrefix = `ploinky-nw-${identity.hash}-`;
    let state = Object.freeze({
        gateways: new Set(),
        lastError: null,
        refreshedAt: Number.NEGATIVE_INFINITY,
        expiresAt: Number.NEGATIVE_INFINITY,
        durationMs: 0,
    });
    let inFlight = null;
    let activeController = null;
    let timer = null;
    let started = false;
    let closing = false;
    let closePromise = null;

    async function collectGateways(signal) {
        const listed = await Promise.resolve(run(
            ['network', 'ls', '--format', 'json'],
            { signal },
        ));
        if (!listed?.ok) throw new Error(`cannot list managed networks: ${listed?.stderr || 'podman failed'}`);
        let summaries;
        try {
            summaries = JSON.parse(String(listed.stdout || '[]'));
        } catch (error) {
            throw new Error(`managed network list returned malformed JSON: ${error.message}`);
        }
        if (!Array.isArray(summaries)) summaries = [summaries];
        const names = summaries
            .map((record) => String(record?.Name || record?.name || record?.NetworkName || ''))
            .filter((name) => name.startsWith(namePrefix))
            .sort();
        if (names.length === 0) return new Set();

        const inspected = await Promise.resolve(run(
            ['network', 'inspect', ...names],
            { signal },
        ));
        if (!inspected?.ok) {
            throw new Error(`cannot inspect managed networks: ${inspected?.stderr || 'podman failed'}`);
        }
        const records = parseJsonRecords(inspected.stdout, 'managed network inspection');
        const recordsByName = new Map();
        for (const record of records) {
            const name = String(record?.Name || record?.name || '');
            if (!name || recordsByName.has(name)) {
                throw new Error('managed network inspection returned missing or duplicate names');
            }
            recordsByName.set(name, record);
        }
        if (recordsByName.size !== names.length
            || names.some((name) => !recordsByName.has(name))) {
            throw new Error('managed network inspection did not match the requested network set');
        }

        const next = new Set();
        for (const name of names) {
            const record = recordsByName.get(name);
            next.add(validatedManagedGateway(record, {
                workspaceHash: identity.hash,
                expectedNamePrefix: namePrefix,
            }));
        }
        return next;
    }

    function effectiveGateways(observedAt = now()) {
        if (state.lastError || observedAt >= state.expiresAt) return null;
        return state.gateways;
    }

    function nextRefreshDelay() {
        if (state.lastError) return refreshIntervalMs;
        const maximumLead = Math.max(0, refreshIntervalMs - 1);
        const adaptiveLead = Math.min(
            maximumLead,
            Math.max(1, Math.ceil(state.durationMs * 2)),
        );
        return Math.max(1, refreshIntervalMs - adaptiveLead);
    }

    function clearRefreshTimer() {
        if (timer === null) return;
        cancelSchedule(timer);
        timer = null;
    }

    function scheduleRefresh() {
        clearRefreshTimer();
        if (!started || closing || !bindsRuntimeBridgeGatewaysLocally) return;
        timer = schedule(() => {
            timer = null;
            void refresh({ force: true });
        }, nextRefreshDelay());
        timer?.unref?.();
    }

    function refresh({ force = false } = {}) {
        if (closing) return Promise.resolve();
        if (inFlight) return inFlight;
        const observedAt = now();
        if (!force && observedAt < state.expiresAt && !state.lastError) {
            return Promise.resolve();
        }
        clearRefreshTimer();
        const controller = new AbortController();
        activeController = controller;
        inFlight = (async () => {
            const startedAt = now();
            try {
                const next = bindsRuntimeBridgeGatewaysLocally
                    ? await collectGateways(controller.signal)
                    : await Promise.resolve(new Set());
                if (closing || controller.signal.aborted) return;
                const completedAt = now();
                state = Object.freeze({
                    gateways: next,
                    lastError: null,
                    refreshedAt: completedAt,
                    expiresAt: bindsRuntimeBridgeGatewaysLocally
                        ? completedAt + refreshIntervalMs
                        : Number.POSITIVE_INFINITY,
                    durationMs: Math.max(0, completedAt - startedAt),
                });
            } catch (error) {
                if (closing || controller.signal.aborted) return;
                const completedAt = now();
                state = Object.freeze({
                    gateways: new Set(),
                    lastError: error,
                    refreshedAt: completedAt,
                    expiresAt: Number.NEGATIVE_INFINITY,
                    durationMs: Math.max(0, completedAt - startedAt),
                });
            } finally {
                activeController = null;
                inFlight = null;
                scheduleRefresh();
            }
        })();
        return inFlight;
    }

    function classify(localAddress) {
        const address = normalizeAddress(localAddress);
        if (isLoopback(address)) return 'loopback';
        if (effectiveGateways()?.has(address)) return 'managed';
        return 'unmanaged';
    }

    async function start() {
        if (closing) throw new Error('listener interface classifier is closing');
        if (started) {
            if (inFlight) await inFlight;
            return snapshot();
        }
        started = true;
        await refresh({ force: true });
        if (closing) throw new Error('listener interface classifier closed during startup');
        return snapshot();
    }

    function close() {
        if (closePromise) return closePromise;
        closing = true;
        started = false;
        clearRefreshTimer();
        activeController?.abort();
        closePromise = (async () => {
            await inFlight?.catch(() => {});
        })();
        return closePromise;
    }

    function snapshot() {
        const observedAt = now();
        const gateways = effectiveGateways(observedAt);
        return Object.freeze({
            gateways: Object.freeze([...(gateways || [])].sort()),
            lastError: state.lastError ? String(state.lastError.message || state.lastError) : '',
            refreshedAt: state.refreshedAt,
            expiresAt: state.expiresAt,
            expired: observedAt >= state.expiresAt,
            refreshing: Boolean(inFlight),
        });
    }

    return {
        classify,
        refresh,
        start,
        close,
        snapshot,
    };
}

export default createListenerInterfaceClassifier;
