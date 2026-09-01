export const TRANSIENT_RELAY_SOCKET_ERRORS = new Set([
    'EADDRINUSE',
    'EAGAIN',
    'EBUSY',
    'ENOTSUP',
]);

export async function readRelaySocketIdentityWithRetry(readIdentity, {
    attempts,
    wait,
} = {}) {
    if (typeof readIdentity !== 'function') {
        throw new Error('runtime relay socket identity reader is required');
    }
    if (!Number.isInteger(attempts) || attempts < 1) {
        throw new Error('runtime relay socket identity attempts are invalid');
    }
    if (typeof wait !== 'function') {
        throw new Error('runtime relay socket identity retry wait is required');
    }

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            return readIdentity();
        } catch (error) {
            if (!TRANSIENT_RELAY_SOCKET_ERRORS.has(error?.code)) throw error;
            if (attempt === attempts) {
                const unavailable = new Error(
                    'runtime relay socket identity remained unavailable after bounded shared-filesystem retries',
                    { cause: error },
                );
                unavailable.code = 'PLOINKY_RELAY_SOCKET_IDENTITY_UNAVAILABLE';
                throw unavailable;
            }
            await wait();
        }
    }
    throw new Error('runtime relay socket identity retry state is unreachable');
}
