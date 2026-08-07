import dgram from 'node:dgram';
import net from 'node:net';

import { BOX_LABELS, BOX_MEDIA_PORT, BOX_ROUTER_CONTAINER_PORT } from './constants.mjs';
import { validateContainerPublications } from './contract/container.mjs';
import { PloinkyBoxError } from './errors.mjs';

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

export function resolveEffectiveHostPort({ explicitPort, explicitMediaPort, ownership }) {
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
    const hostPort = hasExplicitHost
        ? parseHostPort(explicitPort)
        : existingPublication?.hostPort ?? BOX_ROUTER_CONTAINER_PORT;
    const mediaHostPort = hasExplicitMedia
        ? parseHostPort(explicitMediaPort, { source: 'Box media host port' })
        : existingPublication?.mediaHostPort ?? BOX_MEDIA_PORT;
    const source = hasExplicitHost || hasExplicitMedia
        ? 'explicit'
        : existingPublication ? 'existing' : 'default';
    return Object.freeze({ hostPort, mediaHostPort, source, existingPublication });
}

export function probeTcpAvailability(port, {
    createServer = () => net.createServer(),
} = {}) {
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
            reject(error);
        });
        server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
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

export async function preflightPublications({
    hostPort,
    mediaHostPort = BOX_MEDIA_PORT,
    existingPublication = null,
    checkTcp = probeTcpAvailability,
    checkUdp = probeUdpAvailability,
}) {
    const port = parseHostPort(hostPort);
    const mediaPort = parseHostPort(mediaHostPort, { source: 'Box media host port' });
    const [tcpAvailable, udpAvailable] = await Promise.all([
        checkTcp(port),
        checkUdp(mediaPort),
    ]);
    const tcpSelfReservation = existingPublication?.running === true
        && existingPublication.hostPort === port;
    const udpSelfReservation = existingPublication?.running === true
        && existingPublication.mediaHostPort === mediaPort;
    if (!tcpAvailable && !tcpSelfReservation) {
        throw portError(
            `Physical-host TCP 127.0.0.1:${port} is already in use`,
            'PLOINKY_BOX_TCP_CONFLICT',
        );
    }
    if (!udpAvailable && !udpSelfReservation) {
        throw portError(
            `Physical-host UDP 0.0.0.0:${mediaPort} is already in use`,
            'PLOINKY_BOX_UDP_CONFLICT',
        );
    }
    return Object.freeze({
        hostPort: port,
        mediaHostPort: mediaPort,
        tcp: `127.0.0.1:${port}:${BOX_ROUTER_CONTAINER_PORT}/tcp`,
        udp: `0.0.0.0:${mediaPort}:${BOX_MEDIA_PORT}/udp`,
        reusedSelfReservation: !tcpAvailable || !udpAvailable,
    });
}
