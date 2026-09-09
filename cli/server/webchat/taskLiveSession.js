// Structured UI metadata, not Markdown supplied in an assistant response.
export function normalizeTaskLiveSession(value) {
    if (!value || !['desktop', 'browser'].includes(value.mode)
        || typeof value.url !== 'string' || value.url.length > 2048
        || !/^\/(?!\/)[A-Za-z0-9/_-]+$/.test(value.url)) return null;
    return { mode: value.mode, url: value.url };
}
