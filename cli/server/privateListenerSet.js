import net from 'node:net';

const DEFAULT_REFRESH_INTERVAL_MS = 1_000;
const LOOPBACK_ADDRESS = '127.0.0.1';
const WILDCARD_ADDRESS = '0.0.0.0';

function errorMessage(error) {
    return String(error?.message || error || 'unknown error');
}

function normalizeSocketAddress(value) {
    const address = String(value || '').trim().toLowerCase();
    if (address.startsWith('::ffff:') && net.isIP(address.slice(7)) === 4) return address.slice(7);
    return address;
}

function assertDependencies({ httpServer, interfaceClassifier, port, refreshIntervalMs }) {
    if (!httpServer || typeof httpServer.emit !== 'function') {
        throw new TypeError('private listener set requires an HTTP server');
    }
    if (!interfaceClassifier
        || typeof interfaceClassifier.refresh !== 'function'
        || typeof interfaceClassifier.snapshot !== 'function'
        || typeof interfaceClassifier.classify !== 'function') {
        throw new TypeError('private listener set requires an interface classifier');
    }
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
        throw new TypeError('private listener port must be an integer from 1 through 65535');
    }
    if (!Number.isFinite(refreshIntervalMs) || refreshIntervalMs < 1) {
        throw new TypeError('private listener refresh interval must be positive');
    }
}

/**
 * Reconcile the private Router onto an exact address set outside a Box, or the
 * Box namespace wildcard when rootless nested Podman requires host-gateway
 * reachability. One transport listener feeds each accepted socket into the
 * shared HTTP server so HTTP and WebSocket handling remain identical across
 * loopback and managed bridge gateways.
 */
export function createPrivateListenerSet({
    httpServer,
    interfaceClassifier,
    port = 8081,
    refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS,
    createServer = (options) => net.createServer(options),
    audit = () => {},
    wildcardHost = false,
} = {}) {
    assertDependencies({ httpServer, interfaceClassifier, port, refreshIntervalMs });
    if (typeof createServer !== 'function') throw new TypeError('private listener server factory must be a function');
    if (typeof audit !== 'function') throw new TypeError('private listener audit sink must be a function');

    const listeners = new Map();
    if (typeof wildcardHost !== 'boolean') throw new TypeError('private listener wildcardHost must be boolean');
    let desired = new Map([[wildcardHost ? WILDCARD_ADDRESS : LOOPBACK_ADDRESS, wildcardHost ? 'box-wildcard' : 'loopback']]);
    let timer = null;
    let started = false;
    let closing = false;
    let syncTail = Promise.resolve();
    let lastError = '';
    let reconciledAt = 0;

    function emitAudit(event, value) {
        try { audit(event, value); } catch (_) {}
    }

    function publicSnapshot() {
        const classifierSnapshot = interfaceClassifier.snapshot();
        return Object.freeze({
            port,
            addresses: Object.freeze([...listeners.entries()]
                .filter(([, record]) => record.ready)
                .map(([address]) => address)
                .sort()),
            desiredAddresses: Object.freeze([...desired.keys()].sort()),
            gateways: Object.freeze([...(classifierSnapshot?.gateways || [])].sort()),
            lastError,
            classifierError: String(classifierSnapshot?.lastError || ''),
            reconciledAt,
        });
    }

    function destroyRecordSockets(record) {
        for (const socket of record.sockets) {
            try { socket.destroy(); } catch (_) {}
        }
        record.sockets.clear();
    }

    function closeRecord(record, reason) {
        if (!record) return Promise.resolve();
        record.current = false;
        if (listeners.get(record.address) === record) listeners.delete(record.address);
        destroyRecordSockets(record);
        emitAudit('private_listener_unbound', { address: record.address, port, reason });
        if (!record.server.listening) return Promise.resolve();
        return new Promise((resolve) => {
            try {
                record.server.close(() => resolve());
            } catch (_) {
                resolve();
            }
        });
    }

    function admitSocket(record, socket) {
        const address = normalizeSocketAddress(socket.localAddress);
        if (wildcardHost) {
            const exactRecord = listeners.get(WILDCARD_ADDRESS) === record && record.current && record.ready;
            if (!exactRecord || net.isIP(address) === 0) {
                emitAudit('private_listener_connection_rejected', {
                    address,
                    expectedAddress: WILDCARD_ADDRESS,
                    observedClass: 'invalid',
                    expectedClass: 'box-wildcard',
                });
                socket.destroy();
                return;
            }
            record.sockets.add(socket);
            socket.once('close', () => record.sockets.delete(socket));
            httpServer.emit('connection', socket);
            socket.resume();
            return;
        }
        let observedClass = 'unmanaged';
        try { observedClass = interfaceClassifier.classify(address); } catch (_) {}
        const exactRecord = listeners.get(record.address) === record && record.current && record.ready;
        const exactDesiredClass = desired.get(address);
        if (!exactRecord
            || address !== record.address
            || exactDesiredClass !== record.expectedClass
            || observedClass !== record.expectedClass) {
            emitAudit('private_listener_connection_rejected', {
                address,
                expectedAddress: record.address,
                observedClass,
                expectedClass: record.expectedClass,
            });
            socket.destroy();
            return;
        }

        record.sockets.add(socket);
        socket.once('close', () => record.sockets.delete(socket));
        // pauseOnConnect prevents request bytes from racing the HTTP parser.
        // The shared HTTP server owns all parsing, upgrade, and policy logic.
        httpServer.emit('connection', socket);
        socket.resume();
    }

    async function bindAddress(address, expectedClass) {
        const transport = createServer({ pauseOnConnect: true });
        const record = {
            address,
            expectedClass,
            server: transport,
            sockets: new Set(),
            current: true,
            ready: false,
        };
        listeners.set(address, record);
        transport.on('connection', (socket) => admitSocket(record, socket));

        try {
            await new Promise((resolve, reject) => {
                const onInitialError = (error) => reject(error);
                transport.once('error', onInitialError);
                transport.listen({ host: address, port, exclusive: true }, () => {
                    transport.off('error', onInitialError);
                    resolve();
                });
            });
        } catch (error) {
            record.current = false;
            if (listeners.get(address) === record) listeners.delete(address);
            try { transport.close(); } catch (_) {}
            throw error;
        }

        record.ready = true;
        transport.on('error', (error) => {
            lastError = `private listener ${address}:${port} failed: ${errorMessage(error)}`;
            emitAudit('private_listener_error', {
                address,
                port,
                code: error?.code || 'PRIVATE_LISTENER_ERROR',
                error: errorMessage(error),
            });
            void closeRecord(record, 'transport-error');
        });
        emitAudit('private_listener_bound', { address, port, interfaceClass: expectedClass });
    }

    async function reconcile({ strict = false } = {}) {
        if (closing) return publicSnapshot();
        let classifierSnapshot = interfaceClassifier.snapshot();
        const nextDesired = new Map();
        if (wildcardHost) {
            nextDesired.set(WILDCARD_ADDRESS, 'box-wildcard');
        } else {
            await interfaceClassifier.refresh({ force: true });
            classifierSnapshot = interfaceClassifier.snapshot();
            nextDesired.set(LOOPBACK_ADDRESS, 'loopback');
            for (const gateway of classifierSnapshot?.gateways || []) {
                const address = normalizeSocketAddress(gateway);
                if (net.isIP(address) !== 4 || address === LOOPBACK_ADDRESS) continue;
                nextDesired.set(address, 'managed');
            }
        }
        desired = nextDesired;

        const removals = [];
        for (const [address, record] of listeners) {
            if (desired.get(address) !== record.expectedClass) {
                removals.push(closeRecord(record, classifierSnapshot?.lastError
                    ? 'classifier-fail-closed'
                    : 'address-no-longer-managed'));
            }
        }
        await Promise.all(removals);

        const bindErrors = [];
        const missing = [...desired.entries()]
            .filter(([address]) => !listeners.has(address))
            .sort(([left], [right]) => {
                if (left === LOOPBACK_ADDRESS) return -1;
                if (right === LOOPBACK_ADDRESS) return 1;
                return left.localeCompare(right);
            });
        for (const [address, expectedClass] of missing) {
            try {
                await bindAddress(address, expectedClass);
            } catch (error) {
                const message = `cannot bind private Router to ${address}:${port}: ${errorMessage(error)}`;
                bindErrors.push(new Error(message, { cause: error }));
                emitAudit('private_listener_bind_failed', {
                    address,
                    port,
                    code: error?.code || 'PRIVATE_LISTENER_BIND_FAILED',
                    error: errorMessage(error),
                });
            }
        }

        reconciledAt = Date.now();
        lastError = bindErrors[0]?.message || String(classifierSnapshot?.lastError || '');
        const snapshot = publicSnapshot();
        if (strict && bindErrors.length) {
            const error = new AggregateError(bindErrors, 'private Router exact listener set is incomplete');
            error.code = 'PRIVATE_LISTENER_SET_INCOMPLETE';
            error.snapshot = snapshot;
            throw error;
        }
        return snapshot;
    }

    function enqueueReconcile(options) {
        const operation = syncTail.then(
            () => reconcile(options),
            () => reconcile(options),
        );
        syncTail = operation.catch(() => {});
        return operation;
    }

    async function start() {
        if (started) return publicSnapshot();
        if (closing) throw new Error('private listener set is closing');
        try {
            const snapshot = await enqueueReconcile({ strict: true });
            started = true;
            timer = setInterval(() => {
                void enqueueReconcile({ strict: false }).catch((error) => {
                    lastError = errorMessage(error);
                    emitAudit('private_listener_reconcile_failed', { error: lastError });
                });
            }, refreshIntervalMs);
            timer.unref?.();
            return snapshot;
        } catch (error) {
            await close();
            throw error;
        }
    }

    async function close() {
        if (closing) return;
        closing = true;
        started = false;
        if (timer) clearInterval(timer);
        timer = null;
        await syncTail.catch(() => {});
        const records = [...listeners.values()];
        await Promise.all(records.map((record) => closeRecord(record, 'shutdown')));
    }

    return Object.freeze({
        start,
        sync: () => enqueueReconcile({ strict: false }),
        close,
        snapshot: publicSnapshot,
    });
}

export default createPrivateListenerSet;
