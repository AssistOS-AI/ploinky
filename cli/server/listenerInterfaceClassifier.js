import net from 'node:net';
import { spawnSync } from 'node:child_process';

import { NETWORK_SCHEMA_VERSION } from '../sandbox/networkContract.js';
import { NETWORK_LABELS, workspaceNetworkIdentity } from '../sandbox/networkLifecycle.js';

const REFRESH_INTERVAL_MS = 1_000;

function defaultRun(args) {
    const result = spawnSync('podman', args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5_000,
    });
    return {
        ok: result.status === 0 && !result.error,
        stdout: String(result.stdout || ''),
        stderr: String(result.stderr || result.error?.message || ''),
    };
}

function parseJsonRecord(source, description) {
    let parsed;
    try {
        parsed = JSON.parse(String(source || ''));
    } catch (error) {
        throw new Error(`${description} returned malformed JSON: ${error.message}`);
    }
    const record = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
        throw new Error(`${description} returned no record`);
    }
    return record;
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
} = {}) {
    if (typeof platform !== 'string' || !platform.trim()) {
        throw new TypeError('listener interface classifier platform must be a non-empty string');
    }
    const bindsRuntimeBridgeGatewaysLocally = platform === 'linux';
    const identity = workspaceNetworkIdentity(workspaceRoot);
    const namePrefix = `ploinky-nw-${identity.hash}-`;
    let gateways = new Set();
    let refreshedAt = Number.NEGATIVE_INFINITY;
    let lastError = null;

    function refresh({ force = false } = {}) {
        const observedAt = now();
        if (!force && observedAt - refreshedAt < refreshIntervalMs) return;
        refreshedAt = observedAt;
        if (!bindsRuntimeBridgeGatewaysLocally) {
            // Podman bridge gateways live inside a runtime VM on macOS and
            // Windows. They can neither be bound nor accepted by this host
            // process, so querying the runtime here cannot change the exact
            // listener set. Avoid blocking the Router event loop on Podman
            // every time the private-listener reconciler runs.
            gateways = new Set();
            lastError = null;
            return;
        }
        const next = new Set();
        try {
            const listed = run(['network', 'ls', '--format', 'json']);
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
            for (const name of names) {
                const inspected = run(['network', 'inspect', name]);
                if (!inspected?.ok) throw new Error(`cannot inspect managed network '${name}': ${inspected?.stderr || 'podman failed'}`);
                const record = parseJsonRecord(inspected.stdout, `network '${name}' inspection`);
                next.add(validatedManagedGateway(record, {
                    workspaceHash: identity.hash,
                    expectedNamePrefix: namePrefix,
                }));
            }
            gateways = next;
            lastError = null;
        } catch (error) {
            // Transport classification is fail closed. A stale gateway set is
            // never retained after Podman or ownership validation fails.
            gateways = new Set();
            lastError = error;
        }
    }

    function classify(localAddress) {
        refresh();
        const address = normalizeAddress(localAddress);
        if (isLoopback(address)) return 'loopback';
        if (gateways.has(address)) return 'managed';
        return 'unmanaged';
    }

    return {
        classify,
        refresh,
        snapshot() {
            return Object.freeze({
                gateways: Object.freeze([...gateways].sort()),
                lastError: lastError ? String(lastError.message || lastError) : '',
                refreshedAt,
            });
        },
    };
}

export default createListenerInterfaceClassifier;
