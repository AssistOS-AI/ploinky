import crypto from 'node:crypto';
import net from 'node:net';

const NETWORK_SCHEMA_VERSION = '2';
const NETWORK_LABELS = Object.freeze({
    managed: 'io.assistos.ploinky.managed',
    resource: 'io.assistos.ploinky.resource',
    schema: 'io.assistos.ploinky.network-schema',
    workspace: 'io.assistos.ploinky.workspace',
    logical: 'io.assistos.ploinky.logical',
});

function immutableArray(values) {
    return Object.freeze([...values]);
}

function hash12(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

function booleanValue(value, fallback) {
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'boolean') return value;
    if (String(value).toLowerCase() === 'true') return true;
    if (String(value).toLowerCase() === 'false') return false;
    return value;
}

function parseJsonRecords(stdout, description) {
    const raw = String(stdout || '').trim();
    if (!raw) return [];
    try {
        const value = JSON.parse(raw);
        return Array.isArray(value) ? value : [value];
    } catch (_) {
        return raw.split(/\r?\n/).filter(Boolean).map((line, index) => {
            try {
                return JSON.parse(line);
            } catch (error) {
                throw new Error(`${description} JSON record ${index + 1} is invalid: ${error.message}`);
            }
        });
    }
}

function networkName(record) {
    return String(record?.Name || record?.name || record?.NetworkName || '').trim();
}

function labelsOf(record) {
    return record?.Labels || record?.labels || {};
}

export function managedNetworkWorkspaceHash(workspaceRoot = '/workspace') {
    const root = String(workspaceRoot || '').trim();
    if (!root.startsWith('/')) throw new Error('managed network workspace root must be absolute');
    return hash12(root);
}

export function parseManagedNetworkList(stdout, { workspaceHash } = {}) {
    const hash = String(workspaceHash || '').trim();
    if (!/^[0-9a-f]{12}$/.test(hash)) throw new Error('managed network workspace hash is invalid');
    const prefix = `ploinky-nw-${hash}-`;
    const names = parseJsonRecords(stdout, 'nested Podman network list')
        .map(networkName)
        .filter(name => name.startsWith(prefix));
    if (names.some(name => !/^ploinky-nw-[0-9a-f]{12}-[0-9a-f]{12}$/.test(name))) {
        throw new Error(`managed network list contains malformed name in workspace prefix '${prefix}'`);
    }
    if (new Set(names).size !== names.length) {
        throw new Error('managed network list contains duplicate names');
    }
    return immutableArray(names.sort());
}

export function parseManagedNetworkInspection(stdout, name) {
    const records = parseJsonRecords(stdout, `managed network '${name}' inspection`);
    if (records.length !== 1) {
        throw new Error(`managed network '${name}' inspection expected one record, found ${records.length}`);
    }
    return records[0];
}

export function buildManagedNetworkRecord({ inspection, listedName, workspaceHash } = {}) {
    const name = networkName(inspection);
    if (!name || name !== listedName) {
        throw new Error(`managed network '${listedName}' inspection returned name '${name || '<missing>'}'`);
    }
    const labels = labelsOf(inspection);
    const logicalName = String(labels[NETWORK_LABELS.logical] || '');
    if (!logicalName) throw new Error(`managed network '${name}' has no logical identity`);
    const expectedName = `ploinky-nw-${workspaceHash}-${hash12(logicalName)}`;
    if (name !== expectedName) {
        throw new Error(`managed network '${name}' does not match its exact workspace/logical identity`);
    }
    const expectedLabels = {
        [NETWORK_LABELS.managed]: '1',
        [NETWORK_LABELS.resource]: 'network',
        [NETWORK_LABELS.schema]: NETWORK_SCHEMA_VERSION,
        [NETWORK_LABELS.workspace]: workspaceHash,
        [NETWORK_LABELS.logical]: logicalName,
    };
    const actualKeys = Object.keys(labels).sort();
    const expectedKeys = Object.keys(expectedLabels).sort();
    if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)
        || !expectedKeys.every(key => String(labels[key] ?? '') === expectedLabels[key])) {
        throw new Error(`managed network '${name}' does not have exact contract-${NETWORK_SCHEMA_VERSION} ownership labels`);
    }
    if (String(inspection.Driver || inspection.driver || '') !== 'bridge') {
        throw new Error(`managed network '${name}' is not an exact bridge`);
    }
    const internal = booleanValue(inspection.Internal ?? inspection.internal, false);
    const ipv6 = booleanValue(
        inspection.IPv6Enabled ?? inspection.ipv6_enabled ?? inspection.EnableIPv6,
        false,
    );
    const dns = booleanValue(inspection.DNSEnabled ?? inspection.dns_enabled, true);
    if (internal !== false || ipv6 !== false || dns !== true) {
        throw new Error(`managed network '${name}' has unsupported isolation, IPv6, or DNS state`);
    }
    const options = inspection.Options || inspection.options || {};
    if (Object.keys(options).length !== 1 || String(options.isolate) !== 'true') {
        throw new Error(`managed network '${name}' is missing exact isolate=true bridge state`);
    }
    const ipamDriver = String(inspection.IPAM?.Driver || inspection.ipam_options?.driver || '');
    if (ipamDriver !== 'host-local') {
        throw new Error(`managed network '${name}' has unsupported IPAM driver '${ipamDriver}'`);
    }
    const ipamOptions = inspection.IPAM?.Options || inspection.ipam_options || {};
    if (Object.keys(ipamOptions).some(key => key !== 'driver')) {
        throw new Error(`managed network '${name}' has unsupported IPAM options`);
    }
    const subnets = inspection.Subnets || inspection.subnets || inspection.IPAM?.Config;
    if (!Array.isArray(subnets) || subnets.length !== 1) {
        throw new Error(`managed network '${name}' must have exactly one IPv4 subnet`);
    }
    const subnet = subnets[0] || {};
    const subnetKeys = Object.keys(subnet).map(key => key.toLowerCase()).sort();
    const cidr = String(subnet.Subnet || subnet.subnet || '');
    const gateway = String(subnet.Gateway || subnet.gateway || '');
    const [networkAddress, prefix = ''] = cidr.split('/');
    if (JSON.stringify(subnetKeys) !== JSON.stringify(['gateway', 'subnet'])
        || net.isIP(networkAddress) !== 4
        || !/^\d{1,2}$/.test(prefix)
        || Number(prefix) < 1
        || Number(prefix) > 32
        || net.isIP(gateway) !== 4) {
        throw new Error(`managed network '${name}' has unsupported subnet or gateway state`);
    }
    const id = String(inspection.Id || inspection.ID || inspection.id || '');
    if (!id) throw new Error(`managed network '${name}' inspection has no immutable ID`);
    return Object.freeze({
        name,
        id,
        workspaceHash,
        logicalName,
        subnet: cidr,
        gateway,
    });
}

export function sameManagedNetworkGeneration(left, right) {
    return JSON.stringify(left || []) === JSON.stringify(right || []);
}
