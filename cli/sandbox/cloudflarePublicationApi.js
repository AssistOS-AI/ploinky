import {
    CloudflarePublicationError,
    redactCloudflareText,
    toPublicationError,
} from './cloudflarePublicationPlan.js';

export const DEFAULT_CLOUDFLARE_API_BASE_URL = 'https://api.cloudflare.com/client/v4';

function encode(value) {
    return encodeURIComponent(String(value));
}

function extractCloudflareError(payload, status) {
    const errors = Array.isArray(payload?.errors) ? payload.errors : [];
    const first = errors.find((entry) => entry && (entry.message || entry.code));
    if (first) return `${first.code ? `${first.code}: ` : ''}${first.message || 'Cloudflare API rejected the operation'}`;
    return `Cloudflare API returned HTTP ${status}`;
}

function createTimedSignal(externalSignal, timeoutMs) {
    const controller = new AbortController();
    const abort = () => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted) abort();
    else externalSignal?.addEventListener?.('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('Cloudflare API request timed out')), timeoutMs);
    timer.unref?.();
    return {
        signal: controller.signal,
        release() {
            clearTimeout(timer);
            externalSignal?.removeEventListener?.('abort', abort);
        },
    };
}

function normalizeIngress(result) {
    const ingress = result?.config?.ingress ?? result?.ingress;
    return Array.isArray(ingress) ? ingress : [];
}

function normalizeRecords(result) {
    return Array.isArray(result) ? result : [];
}

export class CloudflarePublicationApiClient {
    constructor({
        fetchImpl = globalThis.fetch,
        baseUrl = DEFAULT_CLOUDFLARE_API_BASE_URL,
        timeoutMs = 15000,
    } = {}) {
        if (typeof fetchImpl !== 'function') {
            throw new TypeError('CloudflarePublicationApiClient requires fetch');
        }
        this.fetchImpl = fetchImpl;
        this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
        this.timeoutMs = Math.max(1000, Number(timeoutMs) || 15000);
    }

    async request(apiToken, method, pathname, {
        body,
        operation = 'cloudflare-api',
        signal,
    } = {}) {
        const token = String(apiToken || '').trim();
        if (!token) {
            throw new CloudflarePublicationError('Cloudflare API secret is missing', {
                code: 'CLOUDFLARE_API_TOKEN_MISSING',
                operation,
            });
        }
        const timed = createTimedSignal(signal, this.timeoutMs);
        try {
            const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
                method,
                headers: {
                    Authorization: `Bearer ${token}`,
                    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
                },
                body: body === undefined ? undefined : JSON.stringify(body),
                redirect: 'error',
                signal: timed.signal,
            });
            const text = await response.text();
            let payload = null;
            if (text) {
                try { payload = JSON.parse(text); } catch (_) {}
            }
            if (!response.ok || payload?.success === false) {
                throw new CloudflarePublicationError(
                    redactCloudflareText(extractCloudflareError(payload, response.status), [token]),
                    {
                        code: 'CLOUDFLARE_API_OPERATION_FAILED',
                        operation,
                        retryable: [408, 409, 425, 429].includes(response.status) || response.status >= 500,
                    },
                );
            }
            return payload?.result ?? payload;
        } catch (error) {
            if (error instanceof CloudflarePublicationError) throw error;
            const abortedByCaller = signal?.aborted === true;
            throw toPublicationError(error, {
                code: abortedByCaller ? 'CLOUDFLARE_RECONCILIATION_ABORTED' : 'CLOUDFLARE_API_UNREACHABLE',
                operation,
                retryable: !abortedByCaller,
                secrets: [token],
            });
        } finally {
            timed.release();
        }
    }

    async validateScope({ apiToken, accountId, zoneId, tunnelId, signal } = {}) {
        const tokenStatus = await this.request(apiToken, 'GET', '/user/tokens/verify', {
            operation: 'verify-api-token',
            signal,
        });
        if (String(tokenStatus?.status || '').toLowerCase() !== 'active') {
            throw new CloudflarePublicationError('Cloudflare API token is not active', {
                code: 'CLOUDFLARE_API_TOKEN_INACTIVE',
                operation: 'verify-api-token',
            });
        }
        const tunnel = await this.readTunnel({ apiToken, accountId, tunnelId, signal });
        if (String(tunnel?.id || '') !== String(tunnelId)
            || (tunnel?.account_tag && String(tunnel.account_tag) !== String(accountId))
            || tunnel?.deleted_at) {
            throw new CloudflarePublicationError('Selected Cloudflare tunnel does not exist in the configured account', {
                code: 'CLOUDFLARE_TUNNEL_SCOPE_INVALID',
                operation: 'read-existing-tunnel',
            });
        }
        const zone = await this.readZone({ apiToken, zoneId, signal });
        const zoneAccountId = String(zone?.account?.id || zone?.account_id || '');
        if (String(zone?.id || '') !== String(zoneId)
            || (zoneAccountId && zoneAccountId !== String(accountId))) {
            throw new CloudflarePublicationError('Selected Cloudflare zone is outside the configured account', {
                code: 'CLOUDFLARE_ZONE_SCOPE_INVALID',
                operation: 'read-zone',
            });
        }
        return { tokenStatus: 'active', tunnel, zone };
    }

    readTunnel({ apiToken, accountId, tunnelId, signal } = {}) {
        return this.request(
            apiToken,
            'GET',
            `/accounts/${encode(accountId)}/cfd_tunnel/${encode(tunnelId)}`,
            { operation: 'read-existing-tunnel', signal },
        );
    }

    readTunnelIngress({ apiToken, accountId, tunnelId, signal } = {}) {
        return this.request(
            apiToken,
            'GET',
            `/accounts/${encode(accountId)}/cfd_tunnel/${encode(tunnelId)}/configurations`,
            { operation: 'read-tunnel-ingress', signal },
        ).then(normalizeIngress);
    }

    async putTunnelIngress({ apiToken, accountId, tunnelId, ingress, signal } = {}) {
        const result = await this.request(
            apiToken,
            'PUT',
            `/accounts/${encode(accountId)}/cfd_tunnel/${encode(tunnelId)}/configurations`,
            { body: { config: { ingress } }, operation: 'update-tunnel-ingress', signal },
        );
        return normalizeIngress(result).length ? normalizeIngress(result) : ingress;
    }

    readZone({ apiToken, zoneId, signal } = {}) {
        return this.request(apiToken, 'GET', `/zones/${encode(zoneId)}`, {
            operation: 'read-zone',
            signal,
        });
    }

    async listDnsRecords({ apiToken, zoneId, hostname, signal } = {}) {
        const query = new URLSearchParams({
            name: String(hostname),
            per_page: '100',
        });
        const result = await this.request(
            apiToken,
            'GET',
            `/zones/${encode(zoneId)}/dns_records?${query.toString()}`,
            { operation: 'list-dns-records', signal },
        );
        return normalizeRecords(result);
    }

    createDnsRecord({ apiToken, zoneId, record, signal } = {}) {
        return this.request(apiToken, 'POST', `/zones/${encode(zoneId)}/dns_records`, {
            body: record,
            operation: 'create-dns-record',
            signal,
        });
    }

    updateDnsRecord({ apiToken, zoneId, recordId, record, signal } = {}) {
        return this.request(
            apiToken,
            'PUT',
            `/zones/${encode(zoneId)}/dns_records/${encode(recordId)}`,
            { body: record, operation: 'update-dns-record', signal },
        );
    }

    deleteDnsRecord({ apiToken, zoneId, recordId, signal } = {}) {
        return this.request(
            apiToken,
            'DELETE',
            `/zones/${encode(zoneId)}/dns_records/${encode(recordId)}`,
            { operation: 'delete-dns-record', signal },
        );
    }

    async listTunnelConnections({ apiToken, accountId, tunnelId, signal } = {}) {
        const result = await this.request(
            apiToken,
            'GET',
            `/accounts/${encode(accountId)}/cfd_tunnel/${encode(tunnelId)}/connections`,
            { operation: 'read-tunnel-connections', signal },
        );
        return Array.isArray(result) ? result : [];
    }
}

export function createCloudflarePublicationApi(options = {}) {
    return new CloudflarePublicationApiClient(options);
}
