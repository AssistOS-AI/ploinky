import dgram from 'node:dgram';
import net from 'node:net';

import { BOX_LABELS, BOX_MEDIA_PORT, BOX_ROUTER_CONTAINER_PORT } from './constants.mjs';
import { validateContainerPublications } from './contract/container.mjs';
import { PloinkyBoxError } from './errors.mjs';
import {
    ROUTER_BIND_LOOPBACK,
    ROUTER_BIND_WILDCARD,
    listHostIpv4Addresses,
    normalizeRouterBindAddress,
    normalizeRouterPublication,
} from './routerBinding.mjs';

function portError(message, code = 'PLOINKY_BOX_PORT_INVALID') {
    return new PloinkyBoxError(message, { code });
}

export function parseHostPort(value, { source = 'Box host port' } = {}) {
    const validNumber = typeof value === 'number'
        && Number.isSafeInteger(value)
        && value >= 1
        && value <= 65535;
    const validString = typeof value === 'string'
        && /^[0-9]+$/.test(value)
        && Number(value) >= 1
        && Number(value) <= 65535;
    if (!validNumber && !validString) {
        throw portError(`${source} must be an integer in the range 1..65535`);
    }
    return Number(value);
}

export function resolveEffectiveHostPort({
    explicitPort,
    explicitMediaPort,
    ownership,
    routerBinding = null,
}) {
    const container = ownership?.state === 'owned' ? ownership.handles?.container : null;
    let existingPublication = null;
    if (container) {
        const existingHostPort = parseHostPort(
            container.labels?.[BOX_LABELS.routerHostPort],
            { source: 'owned Box host-port label' },
        );
        const existingMediaHostPort = parseHostPort(
            container.labels?.[BOX_LABELS.mediaHostPort],
            { source: 'owned Box media host-port label' },
        );
        existingPublication = validateContainerPublications(
            container,
            existingHostPort,
            existingMediaHostPort,
        );
    }
    if (ownership?.state !== 'absent'
        && !(ownership?.state === 'owned' && (!ownership.handles?.container || container))) {
        throw portError(
            `Cannot select a port while Box ownership is ${ownership?.state || 'unknown'}`,
            'PLOINKY_BOX_PORT_OWNERSHIP_UNKNOWN',
        );
    }
    const hasExplicitHost = explicitPort !== undefined && explicitPort !== null && explicitPort !== '';
    const hasExplicitMedia = explicitMediaPort !== undefined
        && explicitMediaPort !== null
        && explicitMediaPort !== '';
    const requestedBindingPort = routerBinding?.hostPort;
    const hasBindingPort = requestedBindingPort !== undefined && requestedBindingPort !== null;
    const hostPort = hasExplicitHost
        ? parseHostPort(explicitPort)
        : hasBindingPort
            ? parseHostPort(requestedBindingPort, { source: 'Router binding host port' })
            : existingPublication?.hostPort ?? BOX_ROUTER_CONTAINER_PORT;
    const mediaHostPort = hasExplicitMedia
        ? parseHostPort(explicitMediaPort, { source: 'Box media host port' })
        : existingPublication?.mediaHostPort ?? BOX_MEDIA_PORT;
    // A requested binding selects the address and trusted hosts. Without one,
    // an existing Box keeps its own publication and a new Box stays loopback.
    const publication = normalizeRouterPublication(
        routerBinding
        ?? existingPublication
        ?? { address: ROUTER_BIND_LOOPBACK, hosts: null },
    );
    const source = hasExplicitHost || hasExplicitMedia
        ? 'explicit'
        : routerBinding ? 'binding' : existingPublication ? 'existing' : 'default';
    return Object.freeze({
        hostPort,
        mediaHostPort,
        address: publication.address,
        hosts: publication.hosts,
        source,
        existingPublication,
    });
}

export async function probeTcpAvailability(port, {
    host = ROUTER_BIND_LOOPBACK,
    createServer = () => net.createServer(),
    listAddresses = listHostIpv4Addresses,
} = {}) {
    const addresses = [...new Set([ROUTER_BIND_LOOPBACK, ...listAddresses()])];
    if (host === ROUTER_BIND_WILDCARD) {
        // BSD/macOS can allow a reuse-address wildcard listener alongside a
        // specific listener. Such a publication is still unsafe: traffic to
        // that address would reach the other service instead of this Box.
        for (const address of addresses.filter(value => value !== ROUTER_BIND_WILDCARD)) {
            if (!await probeTcpAvailability(port, { host: address, createServer, listAddresses: () => addresses })) return false;
        }
    } else if (!addresses.includes(host)) {
        throw portError(`Physical-host TCP address ${host} is not assigned to this host`, 'PLOINKY_BOX_BIND_ADDRESS_UNASSIGNED');
    }
    return new Promise((resolve, reject) => {
        const server = createServer();
        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            resolve(value);
        };
        server.once('error', (error) => {
            if (error.code === 'EADDRINUSE' || error.code === 'EACCES') {
                finish(false);
                return;
            }
            if (error.code === 'EADDRNOTAVAIL') {
                reject(portError(
                    `Physical-host TCP address ${host} is not assigned to this host`,
                    'PLOINKY_BOX_BIND_ADDRESS_UNASSIGNED',
                ));
                return;
            }
            reject(error);
        });
        server.listen({ host, port, exclusive: true }, () => {
            server.close(() => finish(true));
        });
    });
}

export function probeUdpAvailability(port = BOX_MEDIA_PORT, {
    createSocket = () => dgram.createSocket({ type: 'udp4', reuseAddr: false }),
} = {}) {
    return new Promise((resolve, reject) => {
        const socket = createSocket();
        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            resolve(value);
        };
        socket.once('error', (error) => {
            socket.close();
            if (error.code === 'EADDRINUSE' || error.code === 'EACCES') {
                finish(false);
                return;
            }
            reject(error);
        });
        socket.bind({ address: '0.0.0.0', port, exclusive: true }, () => {
            socket.close(() => finish(true));
        });
    });
}

// A running Box listener explains a failed probe only when it can occupy the
// requested socket: the same port on the same address or across the wildcard.
function listenersOverlap(existingAddress, requestedAddress) {
    return existingAddress === requestedAddress
        || existingAddress === ROUTER_BIND_WILDCARD
        || requestedAddress === ROUTER_BIND_WILDCARD;
}

export async function preflightPublications({
    hostPort,
    mediaHostPort = BOX_MEDIA_PORT,
    address = ROUTER_BIND_LOOPBACK,
    existingPublication = null,
    checkTcp = probeTcpAvailability,
    checkUdp = probeUdpAvailability,
    localAddresses = () => listHostIpv4Addresses(),
}) {
    const port = parseHostPort(hostPort);
    const mediaPort = parseHostPort(mediaHostPort, { source: 'Box media host port' });
    const bindAddress = normalizeRouterBindAddress(address);
    const [tcpAvailable, udpAvailable] = await Promise.all([
        checkTcp(port, { host: bindAddress }),
        checkUdp(mediaPort),
    ]);
    const existingRunning = existingPublication?.running === true;
    const existingAddress = existingPublication?.address ?? ROUTER_BIND_LOOPBACK;
    const tcpSelfReservation = existingRunning
        && existingPublication.hostPort === port
        && listenersOverlap(existingAddress, bindAddress);
    const udpSelfReservation = existingRunning
        && existingPublication.mediaHostPort === mediaPort;
    if (!tcpAvailable && !tcpSelfReservation) {
        throw portError(
            `Physical-host TCP ${bindAddress}:${port} is already in use`,
            'PLOINKY_BOX_TCP_CONFLICT',
        );
    }
    if (!udpAvailable && !udpSelfReservation) {
        throw portError(
            `Physical-host UDP 0.0.0.0:${mediaPort} is already in use`,
            'PLOINKY_BOX_UDP_CONFLICT',
        );
    }
    // Widening onto the wildcard fails its first probe because of the old Box,
    // but a different process may also listen on another interface. Probe each
    // other assigned address now; the release recheck covers everything else.
    if (!tcpAvailable && bindAddress === ROUTER_BIND_WILDCARD && existingAddress !== ROUTER_BIND_WILDCARD) {
        for (const candidate of localAddresses()) {
            if (candidate === existingAddress) continue;
            if (!await checkTcp(port, { host: candidate })) {
                throw portError(
                    `Physical-host TCP ${candidate}:${port} is already in use by another listener, `
                    + `so ${ROUTER_BIND_WILDCARD}:${port} cannot be published`,
                    'PLOINKY_BOX_TCP_CONFLICT',
                );
            }
        }
    }
    return Object.freeze({
        hostPort: port,
        mediaHostPort: mediaPort,
        address: bindAddress,
        tcp: `${bindAddress}:${port}:${BOX_ROUTER_CONTAINER_PORT}/tcp`,
        udp: `0.0.0.0:${mediaPort}:${BOX_MEDIA_PORT}/udp`,
        reusedSelfReservation: !tcpAvailable || !udpAvailable,
        // A self-reservation is only a hypothesis until the old listener is
        // gone; the lifecycle proves it before creating the candidate.
        recheckAfterRelease: Object.freeze({ tcp: !tcpAvailable, udp: !udpAvailable }),
    });
}

export async function recheckReleasedPublications(preflight, {
    checkTcp = probeTcpAvailability,
    checkUdp = probeUdpAvailability,
    timeoutMs = 10_000,
    intervalMs = 100,
    delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
    const recheck = preflight?.recheckAfterRelease;
    if (!recheck?.tcp && !recheck?.udp) return;
    const deadline = Date.now() + timeoutMs;
    // Rootless port forwarding exits with the old container; allow it a bounded
    // moment to close its sockets before treating the port as foreign-owned.
    while (true) {
        const tcpAvailable = !recheck.tcp || await checkTcp(preflight.hostPort, { host: preflight.address });
        const udpAvailable = !recheck.udp || await checkUdp(preflight.mediaHostPort);
        if (tcpAvailable && udpAvailable) return;
        if (Date.now() >= deadline) {
            if (!tcpAvailable) {
                throw portError(
                    `Physical-host TCP ${preflight.address}:${preflight.hostPort} is still in use after the `
                    + 'previous Box released it; another process owns a conflicting listener',
                    'PLOINKY_BOX_TCP_CONFLICT',
                );
            }
            throw portError(
                `Physical-host UDP 0.0.0.0:${preflight.mediaHostPort} is still in use after the previous Box released it`,
                'PLOINKY_BOX_UDP_CONFLICT',
            );
        }
        await delay(intervalMs);
    }
}
