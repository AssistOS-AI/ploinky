// Structured UI metadata for a task-owned detail link, not Markdown from a response.
const DETAILS_URL_RE = /^\/(?!\/)[A-Za-z0-9\-._~%!$&'()*+,;=:@/?]*$/;
const DETAILS_LABEL_MAX = 80;

function cleanLabel(value) {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, DETAILS_LABEL_MAX) : '';
}

export function normalizeTaskDetails(value) {
    if (!value || typeof value !== 'object') return null;
    const url = typeof value.url === 'string' ? value.url.trim() : '';
    if (!url || url.length > 2048 || !DETAILS_URL_RE.test(url)) return null;
    const label = cleanLabel(value.label);
    const logsLabel = cleanLabel(value.logsLabel);
    return { url, ...(label ? { label } : {}), ...(logsLabel ? { logsLabel } : {}) };
}
