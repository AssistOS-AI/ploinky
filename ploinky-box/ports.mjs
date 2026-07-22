import dgram from 'node:dgram';
import net from 'node:net';

import { BOX_MEDIA_PORT, BOX_ROUTER_CONTAINER_PORT } from './constants.mjs';
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

export function resolveEffectiveHostPort({ explicitPort, ownership }) {
    if (explicitPort !== undefined && explicitPort !== null && explicitPort !== '') {
        let existingPublication = null;
        if (ownership?.state === 'owned' && ownership.handles?.container) {
            const existingLabelPort = parseHostPort(
                ownership.handles?.container?.labels?.[
                    'io.assistos.ploinky-box.router-host-port'
                ],
                { source: 'owned Box host-port label' },
            );
            existingPublication = validateContainerPublications(
                ownership.handles.container,
                existingLabelPort,
            );
        }
        return Object.freeze({
            hostPort: parseHostPort(explicitPort),
            source: 'explicit',
            existingPublication,
        });
    }
    if (ownership?.state === 'owned' && ownership.handles?.container) {
        const labelPort = ownership.handles?.container?.labels?.[
            'io.assistos.ploinky-box.router-host-port'
        ];
        const hostPort = parseHostPort(labelPort, { source: 'owned Box host-port label' });
        return Object.freeze({
            hostPort,
            source: 'existing',
            existingPublication: validateContainerPublications(
                ownership.handles.container,
                hostPort,
            ),
        });
    }
    if (ownership?.state !== 'absent'
        && !(ownership?.state === 'owned' && !ownership.handles?.container)) {
        throw portError(
            `Cannot select a port while Box ownership is ${ownership?.state || 'unknown'}`,
            'PLOINKY_BOX_PORT_OWNERSHIP_UNKNOWN',
        );
    }
    return Object.freeze({ hostPort: BOX_ROUTER_CONTAINER_PORT, source: 'default', existingPublication: null });
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
    existingPublication = null,
    checkTcp = probeTcpAvailability,
    checkUdp = probeUdpAvailability,
}) {
    const port = parseHostPort(hostPort);
    const [tcpAvailable, udpAvailable] = await Promise.all([
        checkTcp(port),
        checkUdp(BOX_MEDIA_PORT),
    ]);
    const selfReservation = existingPublication?.running === true;
    if (!tcpAvailable && !(selfReservation && existingPublication.hostPort === port)) {
        throw portError(
            `Physical-host TCP 127.0.0.1:${port} is already in use`,
            'PLOINKY_BOX_TCP_CONFLICT',
        );
    }
    if (!udpAvailable && !selfReservation) {
        throw portError(
            `Physical-host UDP 0.0.0.0:${BOX_MEDIA_PORT} is already in use`,
            'PLOINKY_BOX_UDP_CONFLICT',
        );
    }
    return Object.freeze({
        hostPort: port,
        tcp: `127.0.0.1:${port}:${BOX_ROUTER_CONTAINER_PORT}/tcp`,
        udp: `0.0.0.0:${BOX_MEDIA_PORT}:${BOX_MEDIA_PORT}/udp`,
        reusedSelfReservation: !tcpAvailable || !udpAvailable,
    });
}
