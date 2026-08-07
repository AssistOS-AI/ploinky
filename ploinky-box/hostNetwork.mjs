import dgram from 'node:dgram';
import os from 'node:os';

export const HOST_REACHABLE_IPV4_ENV = 'PLOINKY_HOST_REACHABLE_IPV4';

function parseLiteralIpv4(value) {
    if (typeof value !== 'string' || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return null;
    const sourceOctets = value.split('.');
    const octets = sourceOctets.map(Number);
    if (octets.some((octet, index) => (
        octet > 255 || String(octet) !== sourceOctets[index]
    ))) return null;
    return octets.reduce((result, octet) => (result * 256) + octet, 0) >>> 0;
}

const NON_HOST_IPV4_CIDRS = [
    ['0.0.0.0', 8],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.31.196.0', 24],
    ['192.52.193.0', 24],
    ['192.88.99.0', 24],
    ['192.175.48.0', 24],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
].map(([base, prefix]) => [parseLiteralIpv4(base), prefix]);

function isIpv4InCidrs(address, cidrs) {
    return cidrs.some(([base, prefix]) => {
        const mask = (0xffffffff << (32 - prefix)) >>> 0;
        return ((address & mask) >>> 0) === ((base & mask) >>> 0);
    });
}

export function isUsableHostIpv4(value) {
    const address = parseLiteralIpv4(value);
    return address !== null && !isIpv4InCidrs(address, NON_HOST_IPV4_CIDRS);
}

function isVirtualInterface(name) {
    return /^(?:lo|utun|tun|tap|awdl|llw|wg|tailscale|zt)/i.test(name);
}

function isContainerInterface(name) {
    return /^(?:bridge|docker|podman|veth|vmnet|virbr|br-)/i.test(name);
}

function isPhysicalInterface(name, platform) {
    if (platform === 'darwin') return /^en\d+$/i.test(name);
    return /^(?:enp|ens|eno|eth|wlan|wl)/i.test(name);
}

export function selectHostReachableIpv4({
    interfaces = os.networkInterfaces(),
    routeAddress = '',
    platform = process.platform,
} = {}) {
    const candidates = [];
    for (const [name, entries] of Object.entries(interfaces || {})) {
        if (isContainerInterface(name)) continue;
        for (const entry of entries || []) {
            if (!entry || (entry.family !== 'IPv4' && entry.family !== 4) || entry.internal) continue;
            const address = String(entry.address || '').trim();
            if (!isUsableHostIpv4(address)) continue;
            candidates.push({
                address,
                name,
                physical: isPhysicalInterface(name, platform),
                virtual: isVirtualInterface(name),
            });
        }
    }
    if (!candidates.length) return '';

    const selectedRoute = String(routeAddress || '').trim();
    candidates.sort((left, right) => {
        const rank = (candidate) => {
            if (candidate.address === selectedRoute && !candidate.virtual) return 0;
            if (candidate.physical && !candidate.virtual) return 1;
            if (!candidate.virtual) return 2;
            if (candidate.address === selectedRoute) return 3;
            return 4;
        };
        return rank(left) - rank(right)
            || left.name.localeCompare(right.name)
            || left.address.localeCompare(right.address);
    });
    return candidates[0].address;
}

export function probeDefaultRouteIpv4({ timeoutMs = 250 } = {}) {
    return new Promise((resolve) => {
        const socket = dgram.createSocket('udp4');
        let settled = false;
        const finish = (value = '') => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { socket.close(); } catch (_) {}
            resolve(isUsableHostIpv4(value) ? value : '');
        };
        const timer = setTimeout(() => finish(), timeoutMs);
        socket.once('error', () => finish());
        socket.connect(53, '1.1.1.1', () => {
            try {
                finish(String(socket.address()?.address || ''));
            } catch (_) {
                finish();
            }
        });
    });
}

export async function detectHostReachableIpv4({
    interfaces = os.networkInterfaces(),
    platform = process.platform,
    routeProbe = probeDefaultRouteIpv4,
} = {}) {
    let routeAddress = '';
    try {
        routeAddress = await routeProbe();
    } catch (_) {}
    return selectHostReachableIpv4({ interfaces, routeAddress, platform });
}
