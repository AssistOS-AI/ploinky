export const DEFAULT_PROXY_LIMITS = Object.freeze({
    requestHeaderBytes: 64 * 1024,
    responseHeaderBytes: 64 * 1024,
    bufferedBodyBytes: 8 * 1024 * 1024,
    streamedBodyBytes: 64 * 1024 * 1024,
    connectTimeoutMs: 5_000,
    headerTimeoutMs: 455_000,
    idleTimeoutMs: 60_000,
    longLivedTimeoutMs: 30 * 60_000,
    webSocketHandshakeTimeoutMs: 15_000,
    webSocketFrameBytes: 1024 * 1024,
    webSocketMessageBytes: 8 * 1024 * 1024,
    concurrentStreamsPerAgent: 64,
    concurrentStreamsTotal: 256,
});

function positiveSafeInteger(value, key) {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`proxyLimits: ${key} must be a positive safe integer`);
    }
    return value;
}

export function compileProxyLimits(overrides = {}) {
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
        throw new Error('proxyLimits: overrides must be an object');
    }
    for (const key of Object.keys(overrides)) {
        if (!(key in DEFAULT_PROXY_LIMITS)) throw new Error(`proxyLimits: unknown limit '${key}'`);
    }
    const limits = {};
    for (const [key, fallback] of Object.entries(DEFAULT_PROXY_LIMITS)) {
        limits[key] = positiveSafeInteger(overrides[key] ?? fallback, key);
    }
    if (limits.bufferedBodyBytes > limits.streamedBodyBytes) {
        throw new Error('proxyLimits: bufferedBodyBytes cannot exceed streamedBodyBytes');
    }
    if (limits.webSocketFrameBytes > limits.webSocketMessageBytes) {
        throw new Error('proxyLimits: webSocketFrameBytes cannot exceed webSocketMessageBytes');
    }
    if (limits.concurrentStreamsPerAgent > limits.concurrentStreamsTotal) {
        throw new Error('proxyLimits: per-agent concurrency cannot exceed total concurrency');
    }
    if (limits.connectTimeoutMs > limits.headerTimeoutMs) {
        throw new Error('proxyLimits: connect timeout cannot exceed header timeout');
    }
    if (limits.connectTimeoutMs > limits.webSocketHandshakeTimeoutMs) {
        throw new Error('proxyLimits: connect timeout cannot exceed WebSocket handshake timeout');
    }
    return Object.freeze(limits);
}

export default compileProxyLimits;
