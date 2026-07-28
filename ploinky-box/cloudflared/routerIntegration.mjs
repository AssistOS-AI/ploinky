import { serializeCloudflarePublicationStatus } from './status.mjs';

const UNSTARTED_STATUS = serializeCloudflarePublicationStatus({
    mode: 'local-only',
    management: null,
    state: 'unstarted',
    connectorState: 'absent',
});

function constructionErrorStatus(error) {
    return serializeCloudflarePublicationStatus({
        mode: 'local-only',
        management: null,
        state: 'error',
        connectorState: 'absent',
        error: {
            code: error?.code || 'CLOUDFLARE_RUNTIME_START_FAILED',
            operation: 'runtime-start',
            retryable: error?.retryable === true,
        },
    });
}

export function createCloudflaredRouterIntegration({
    audit = () => {},
    runtimeFactory,
} = {}) {
    if (typeof audit !== 'function') throw new TypeError('cloudflared Router integration requires audit()');
    if (typeof runtimeFactory !== 'function') {
        throw new TypeError('cloudflared Router integration requires runtimeFactory()');
    }
    let publicListenerReady = false;
    let privateListenerReady = false;
    let startAttempted = false;
    let runtime = null;
    let lastStatus = UNSTARTED_STATUS;
    let stopPromise = null;
    let stopped = false;

    function safeAudit(event, value) {
        try { audit(event, Object.freeze({ ...value })); } catch (_) {}
    }

    function maybeStart() {
        if (stopped || startAttempted || !publicListenerReady || !privateListenerReady) return;
        startAttempted = true;
        try {
            const created = runtimeFactory({ audit });
            if (!created || typeof created.getStatus !== 'function' || typeof created.stop !== 'function') {
                throw new TypeError('cloudflared runtime factory returned an invalid lifecycle');
            }
            runtime = created;
            try { lastStatus = serializeCloudflarePublicationStatus(runtime.getStatus()); } catch (_) {}
            safeAudit('cloudflare_publication_runtime_start', {});
        } catch (error) {
            lastStatus = constructionErrorStatus(error);
            safeAudit('cloudflare_publication_runtime_start_error', {
                code: lastStatus.error.code,
                operation: 'runtime-start',
                retryable: error?.retryable === true,
            });
        }
    }

    return Object.freeze({
        markPublicListenerReady() {
            publicListenerReady = true;
            maybeStart();
        },
        markPrivateListenerReady() {
            privateListenerReady = true;
            maybeStart();
        },
        getStatus() {
            if (runtime) {
                try {
                    lastStatus = serializeCloudflarePublicationStatus(runtime.getStatus());
                } catch (_) {}
            }
            return lastStatus;
        },
        stop() {
            if (stopPromise) return stopPromise;
            stopped = true;
            const activeRuntime = runtime;
            runtime = null;
            stopPromise = (async () => {
                if (activeRuntime) await activeRuntime.stop();
                lastStatus = serializeCloudflarePublicationStatus({
                    ...lastStatus,
                    state: 'stopped',
                    connectorState: 'stopped',
                });
            })();
            return stopPromise;
        },
    });
}
