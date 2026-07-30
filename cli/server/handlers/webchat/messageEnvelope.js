import { buildInvocationContextForProviderCall } from '../../mcp-proxy/index.js';

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

function buildWebchatInvocationToken({ req, effectiveConfig, tabId, envelope }) {
    const agentName = String(effectiveConfig?.agentName || '').trim();
    if (!agentName) return '';
    try {
        const invocation = buildInvocationContextForProviderCall({
            req,
            agentName,
            toolName: '__webchat_message__',
            toolArgs: {
                surface: 'webchat',
                tabId: String(tabId || ''),
                text: typeof envelope?.text === 'string' ? envelope.text : '',
                attachments: sanitizeWebchatAttachmentsForEnvelope(envelope?.attachments),
                references: sanitizeWebchatReferencesForEnvelope(envelope?.references),
                presentation: normalizeWebchatPresentation(envelope?.presentation),
            }
        });
        return invocation?.token || '';
    } catch (_) {
        return '';
    }
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

export function serializeWebchatEnvelopeForAgent({ req, effectiveConfig, tabId, envelope, fallbackText = '' }) {
    const sanitizedReferences = sanitizeWebchatReferencesForEnvelope(envelope?.references);
    const publicBaseUrl = resolveRequestPublicOrigin(req);
    const payload = {
        __webchatMessage: 1,
        version: 1,
        text: (envelope && typeof envelope.text === 'string') ? envelope.text : String(fallbackText || ''),
        attachments: sanitizeWebchatAttachmentsForEnvelope(envelope?.attachments),
        presentation: normalizeWebchatPresentation(envelope?.presentation),
        sourceTabId: String(tabId || '').slice(0, 128),
    };
    if (publicBaseUrl) payload.origin = { publicBaseUrl };
    if (sanitizedReferences.length) payload.references = sanitizedReferences;
    const token = buildWebchatInvocationToken({ req, effectiveConfig, tabId, envelope: payload });
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
