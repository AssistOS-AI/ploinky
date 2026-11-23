import { buildInvocationContextForProviderCall } from '../../mcp-proxy/index.js';
import { resolveRouteTargetRecord } from '../../mcp-proxy/invocationMinter.js';
import { loadActiveRoutingState } from '../../routingState.js';

export function normalizeWebchatPresentation(raw) {
    return { visible: raw?.visible !== false };
}

export function parseInputEnvelope(rawBody) {
    const fallbackText = typeof rawBody === 'string' ? rawBody : '';
    try {
        const parsed = JSON.parse(fallbackText);
        if (parsed && parsed.__webchatMessage && typeof parsed === 'object') {
            return {
                text: typeof parsed.text === 'string' ? parsed.text : '',
                attachments: Array.isArray(parsed.attachments) ? parsed.attachments : [],
                references: sanitizeWebchatReferencesForEnvelope(parsed.references),
                presentation: normalizeWebchatPresentation(parsed.presentation),
            };
        }
    } catch (_) {
        // Fall back to plain text input.
    }
    return {
        text: fallbackText,
        attachments: [],
        references: [],
        presentation: { visible: true },
    };
}

export function sanitizeWebchatAttachmentsForEnvelope(attachments = []) {
    return Array.isArray(attachments)
        ? attachments
            .filter((entry) => entry && typeof entry === 'object')
            .map((entry) => ({
                id: typeof entry.id === 'string' ? entry.id : null,
                filename: typeof entry.filename === 'string' ? entry.filename : null,
                mime: typeof entry.mime === 'string' ? entry.mime : null,
                size: Number.isFinite(entry.size) ? entry.size : null,
                downloadUrl: typeof entry.downloadUrl === 'string' ? entry.downloadUrl : null,
                localPath: typeof entry.localPath === 'string' ? entry.localPath : null
            }))
        : [];
}

const REFERENCE_SECRET_RE = /(^|\/)\.secrets$|\.secrets$/i;

export function sanitizeWebchatReferencesForEnvelope(references = []) {
    if (!Array.isArray(references)) return [];
    const out = [];
    for (const entry of references) {
        if (!entry || typeof entry !== 'object') continue;
        const kind = typeof entry.kind === 'string' ? entry.kind.trim() : '';
        const refPath = typeof entry.path === 'string' ? entry.path.trim() : '';
        if (!kind || !refPath) continue;
        if (refPath.includes('\0')) continue;
        if (kind === 'workspace-path') {
            const normalized = refPath.replace(/\\+/g, '/');
            if (normalized.startsWith('/')) continue;
            if (normalized.includes('..')) continue;
            if (REFERENCE_SECRET_RE.test(normalized)) continue;
            out.push({
                kind,
                path: normalized,
                type: typeof entry.type === 'string' && entry.type ? entry.type : null,
                label: typeof entry.label === 'string' && entry.label ? entry.label : null
            });
        }
    }
    return out;
}

// The signed `__webchat_message__` arguments. A principal-scoped runtime adds
// `runtimeScope: "principal"`, taken only from the manifest-derived config, so
// an agent that requires it rejects tokens from a router without per-user
// runtimes.
export function buildWebchatInvocationArgs({ effectiveConfig, tabId, pageInstanceId, envelope }) {
    const args = {
        surface: 'webchat',
        tabId: String(tabId || ''),
        pageInstanceId: String(pageInstanceId || ''),
        text: typeof envelope?.text === 'string' ? envelope.text : '',
        attachments: sanitizeWebchatAttachmentsForEnvelope(envelope?.attachments),
        references: sanitizeWebchatReferencesForEnvelope(envelope?.references),
        presentation: normalizeWebchatPresentation(envelope?.presentation),
    };
    if (effectiveConfig?.runtimeScope === 'principal') args.runtimeScope = 'principal';
    return args;
}

export function resolveWebchatInvocationTarget(req, effectiveConfig) {
    const binding = req?.edgeAuthContext?.webchatBinding;
    if (!binding) return undefined;
    const { target, targetRoute, generation } = binding;
    const { snapshot } = loadActiveRoutingState();
    if (target !== effectiveConfig.agentName || targetRoute?.routeKey !== target
        || generation !== snapshot.generation) {
        throw new Error('WebChat target binding changed');
    }
    const targetRecord = resolveRouteTargetRecord({ routeKey: target, route: targetRoute, generation, snapshot });
    return { snapshot, targetRecord, container: targetRoute.container };
}

function buildWebchatInvocationToken({ req, effectiveConfig, tabId, pageInstanceId, envelope, target }) {
    const agentName = String(effectiveConfig?.agentName || '').trim();
    if (!agentName) return '';
    const invocation = buildInvocationContextForProviderCall({
        req,
        agentName,
        snapshot: target?.snapshot,
        targetRecord: target?.targetRecord,
        toolName: '__webchat_message__',
        toolArgs: buildWebchatInvocationArgs({ effectiveConfig, tabId, pageInstanceId, envelope })
    });
    return invocation?.token || '';
}

function firstHeaderValue(value) {
    const raw = Array.isArray(value) ? value[0] : value;
    return String(raw || '').split(',')[0].trim();
}

export function resolveRequestPublicOrigin(req) {
    const headers = req?.headers || {};
    const proto = firstHeaderValue(headers['x-forwarded-proto'])
        || (req?.socket?.encrypted ? 'https' : 'http');
    const host = firstHeaderValue(headers['x-forwarded-host']) || firstHeaderValue(headers.host);
    const normalizedProto = String(proto || '').toLowerCase().replace(/:$/, '');
    if (!/^(http|https)$/.test(normalizedProto) || !host) return '';
    if (/[\r\n/?#\\]/.test(host)) return '';
    try {
        const parsed = new URL(`${normalizedProto}://${host}`);
        return parsed.hostname ? parsed.origin : '';
    } catch (_) {
        return '';
    }
}

export function serializeWebchatEnvelopeForAgent({
    req, effectiveConfig, tabId, pageInstanceId = '', envelope, fallbackText = '',
    target = resolveWebchatInvocationTarget(req, effectiveConfig),
}) {
    const sanitizedReferences = sanitizeWebchatReferencesForEnvelope(envelope?.references);
    const publicBaseUrl = resolveRequestPublicOrigin(req);
    const payload = {
        __webchatMessage: 1,
        version: 1,
        text: (envelope && typeof envelope.text === 'string') ? envelope.text : String(fallbackText || ''),
        attachments: sanitizeWebchatAttachmentsForEnvelope(envelope?.attachments),
        presentation: normalizeWebchatPresentation(envelope?.presentation),
        sourceTabId: String(tabId || '').slice(0, 128),
        sourcePageInstanceId: String(pageInstanceId || '').slice(0, 128),
    };
    if (publicBaseUrl) payload.origin = { publicBaseUrl };
    if (sanitizedReferences.length) payload.references = sanitizedReferences;
    const token = buildWebchatInvocationToken({ req, effectiveConfig, tabId, pageInstanceId, envelope: payload, target });
    if (token) payload.invocation = { token };
    return JSON.stringify(payload);
}

function isTruthyQueryValue(value) {
    return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

export function shouldForwardWebchatEnvelope(parsedUrl, effectiveConfig = null) {
    return isTruthyQueryValue(parsedUrl.searchParams.get('forward-envelope'))
        || isTruthyQueryValue(parsedUrl.searchParams.get('forwardEnvelope'))
        || effectiveConfig?.forwardEnvelope === true;
}
