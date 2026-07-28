const FILE_EXTENSIONS = Object.freeze([
    'c', 'cc', 'cpp', 'cs', 'css', 'csv', 'go', 'h', 'hpp', 'htm', 'html',
    'java', 'jpeg', 'jpg', 'js', 'json', 'jsx', 'log', 'md', 'mdx', 'mjs',
    'pdf', 'php', 'png', 'py', 'rb', 'rs', 'scss', 'sh', 'sql', 'svg', 'toml',
    'ts', 'tsx', 'txt', 'webp', 'xml', 'yaml', 'yml',
]);
const EXTENSION_PATTERN = FILE_EXTENSIONS.join('|');
const BARE_FILE_RE = new RegExp(
    `(?:^|[\\s([{<])((?:@|\\./|/workspace/)?(?:[\\p{L}\\p{N}_+.-]+/)*[\\p{L}\\p{N}_+.-]+\\.(?:${EXTENSION_PATTERN})(?::\\d+(?::\\d+)?)?)(?=$|[\\s)\\]}>.,'\";!?])`,
    'giu',
);
const QUOTED_FILE_RE = new RegExp(
    `([\"'])((?:@|\\./|/workspace/)?[^\"'\\n]{1,240}\\.(?:${EXTENSION_PATTERN})(?::\\d+(?::\\d+)?)?)\\1`,
    'giu',
);
const SPECIAL_FILE_RE = /(?:^|[\s([{<])((?:@|\.\/|\/workspace\/)?(?:[\p{L}\p{N}_+.-]+\/)*(?:README|LICENSE|Dockerfile|Makefile))(?=$|[\s)\]}>.,'";!?])/giu;
const LINE_SUFFIX_RE = /:(\d+)(?::(\d+))?$/;

const MARKDOWN_EXTENSIONS = new Set(['md', 'mdx']);
const IMAGE_EXTENSIONS = new Set(['gif', 'jpeg', 'jpg', 'png', 'svg', 'webp']);
const HTML_EXTENSIONS = new Set(['htm', 'html']);
const TEXT_EXTENSIONS = new Set([
    'c', 'cc', 'cpp', 'cs', 'css', 'csv', 'go', 'h', 'hpp', 'java', 'js',
    'json', 'jsx', 'log', 'mjs', 'php', 'py', 'rb', 'rs', 'scss', 'sh',
    'sql', 'toml', 'ts', 'tsx', 'txt', 'xml', 'yaml', 'yml',
]);

function stripWorkspaceAlias(value) {
    if (value.startsWith('/workspace/')) return value.slice('/workspace/'.length);
    if (value.startsWith('./')) return value.slice(2);
    if (value.startsWith('@')) return value.slice(1);
    return value;
}

export function normalizeWorkspaceFileCandidate(rawCandidate) {
    const display = String(rawCandidate || '').trim();
    if (!display || display.includes('\0')) return null;

    const locationMatch = LINE_SUFFIX_RE.exec(display);
    const withoutLocation = locationMatch
        ? display.slice(0, locationMatch.index)
        : display;
    const slashNormalized = withoutLocation.replace(/\\+/g, '/');
    if (slashNormalized.startsWith('/') && !slashNormalized.startsWith('/workspace/')) return null;
    const normalized = stripWorkspaceAlias(slashNormalized)
        .replace(/^\/+/, '')
        .replace(/\/{2,}/g, '/');
    if (!normalized || normalized.startsWith('/')) return null;
    const segments = normalized.split('/');
    if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;

    return {
        display,
        path: normalized,
        line: locationMatch ? Number.parseInt(locationMatch[1], 10) : null,
        column: locationMatch?.[2] ? Number.parseInt(locationMatch[2], 10) : null,
    };
}

function pushMatches(text, regex, groupIndex, matches) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(text)) !== null) {
        const value = match[groupIndex];
        const offset = match[0].indexOf(value);
        const start = match.index + Math.max(0, offset);
        const normalized = normalizeWorkspaceFileCandidate(value);
        if (!normalized) continue;
        matches.push({
            ...normalized,
            raw: value,
            start,
            end: start + value.length,
        });
    }
}

export function findWorkspaceFileCandidates(text, { allowWholeTextWithSpaces = false } = {}) {
    const input = String(text || '');
    if (!input) return [];
    const matches = [];

    pushMatches(input, QUOTED_FILE_RE, 2, matches);
    pushMatches(input, BARE_FILE_RE, 1, matches);
    pushMatches(input, SPECIAL_FILE_RE, 1, matches);

    if (allowWholeTextWithSpaces) {
        const trimmed = input.trim();
        const fullPathRe = new RegExp(`\\.(?:${EXTENSION_PATTERN})(?::\\d+(?::\\d+)?)?$`, 'iu');
        if (trimmed.length <= 240 && fullPathRe.test(trimmed)) {
            const normalized = normalizeWorkspaceFileCandidate(trimmed);
            if (normalized) {
                const start = input.indexOf(trimmed);
                matches.push({
                    ...normalized,
                    raw: trimmed,
                    start,
                    end: start + trimmed.length,
                });
            }
        }
    }

    matches.sort((left, right) => left.start - right.start || right.end - left.end);
    const deduplicated = [];
    let occupiedUntil = -1;
    for (const match of matches) {
        if (match.start < occupiedUntil) continue;
        deduplicated.push(match);
        occupiedUntil = match.end;
    }
    return deduplicated;
}

function normalizeRelativeBase(value) {
    return String(value || '')
        .replace(/\\+/g, '/')
        .replace(/^\/+|\/+$/g, '');
}

export function buildWorkspaceFileUrl(filePath, workspaceBase = '') {
    const normalized = normalizeWorkspaceFileCandidate(filePath);
    if (!normalized) return null;
    const base = normalizeRelativeBase(workspaceBase);
    const relativePath = base
        && normalized.path !== base
        && !normalized.path.startsWith(`${base}/`)
        ? `${base}/${normalized.path}`
        : normalized.path;
    const encoded = relativePath
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
    return `/workspace-files/${encoded}`;
}

export function workspaceFilePreviewKind(filePath) {
    const normalized = normalizeWorkspaceFileCandidate(filePath);
    if (!normalized) return 'unknown';
    const name = normalized.path.split('/').pop() || '';
    const dotIndex = name.lastIndexOf('.');
    const extension = dotIndex >= 0 ? name.slice(dotIndex + 1).toLowerCase() : '';
    if (MARKDOWN_EXTENSIONS.has(extension)) return 'markdown';
    if (IMAGE_EXTENSIONS.has(extension)) return 'image';
    if (HTML_EXTENSIONS.has(extension)) return 'html';
    if (extension === 'pdf') return 'pdf';
    if (TEXT_EXTENSIONS.has(extension) || /^(README|LICENSE|Dockerfile|Makefile)$/i.test(name)) return 'text';
    return 'unknown';
}

function isInsideSkippedElement(node) {
    let element = node?.parentElement || null;
    while (element) {
        const tagName = String(element.tagName || '').toUpperCase();
        if (tagName === 'A' || tagName === 'PRE' || tagName === 'SCRIPT'
            || tagName === 'STYLE' || tagName === 'TEXTAREA') {
            return true;
        }
        element = element.parentElement;
    }
    return false;
}

function isInlineCodeNode(node) {
    const parent = node?.parentElement;
    return String(parent?.tagName || '').toUpperCase() === 'CODE'
        && String(parent?.parentElement?.tagName || '').toUpperCase() !== 'PRE';
}

function isKnownWorkspaceFile(fileIndex, filePath, workspaceBase) {
    if (!fileIndex || typeof fileIndex.has !== 'function') return false;
    const normalized = normalizeWorkspaceFileCandidate(filePath);
    if (!normalized) return false;
    if (fileIndex.has(normalized.path)) return true;
    const base = normalizeRelativeBase(workspaceBase);
    if (base && normalized.path.startsWith(`${base}/`)) {
        return fileIndex.has(normalized.path.slice(base.length + 1));
    }
    return false;
}

function createFileAnchor(documentRef, match, workspaceBase, fileIndex) {
    if (!isKnownWorkspaceFile(fileIndex, match.path, workspaceBase)) return null;
    const href = buildWorkspaceFileUrl(match.path, workspaceBase);
    if (!href) return null;
    const anchor = documentRef.createElement('a');
    anchor.href = href;
    anchor.className = 'wa-workspace-file-link';
    anchor.dataset.wcLink = 'true';
    anchor.dataset.wcFile = 'true';
    anchor.dataset.wcAutoFile = 'true';
    anchor.dataset.wcFilePath = match.path;
    if (match.line !== null) anchor.dataset.wcFileLine = String(match.line);
    if (match.column !== null) anchor.dataset.wcFileColumn = String(match.column);
    anchor.title = `Preview ${match.path}`;
    anchor.textContent = match.raw;
    return anchor;
}

function restoreExistingAnchor(anchor) {
    if (anchor.dataset?.wcFileEnhanced !== 'true') return;
    const originalHref = anchor.dataset.wcOriginalHref;
    if (originalHref) anchor.href = originalHref;
    delete anchor.dataset.wcFile;
    delete anchor.dataset.wcFilePath;
    delete anchor.dataset.wcFileEnhanced;
    delete anchor.dataset.wcOriginalHref;
    anchor.classList?.remove?.('wa-workspace-file-link');
}

function reconcileAutoAnchors(container, { workspaceBase, fileIndex }) {
    const anchors = container.querySelectorAll?.('a[data-wc-auto-file="true"]') || [];
    for (const anchor of anchors) {
        if (anchor.dataset?.wcAutoFile !== 'true') continue;
        const filePath = anchor.dataset?.wcFilePath || '';
        if (isKnownWorkspaceFile(fileIndex, filePath, workspaceBase)) continue;
        const text = container.ownerDocument.createTextNode(anchor.textContent || '');
        anchor.parentNode?.replaceChild?.(text, anchor);
    }
}

function enhanceExistingAnchors(container, { workspaceBase, webchatBasePath, fileIndex }) {
    const anchors = container.querySelectorAll?.('a[data-wc-link="true"]') || [];
    for (const anchor of anchors) {
        if (anchor.dataset?.wcAutoFile === 'true') continue;
        let url;
        try {
            url = new URL(anchor.href, window.location.origin);
        } catch (_) {
            continue;
        }
        let candidate = '';
        let alreadyWorkspaceRelative = false;
        try {
            if (url.origin === window.location.origin && url.pathname.startsWith('/workspace-files/')) {
                candidate = decodeURIComponent(url.pathname.slice('/workspace-files/'.length));
                alreadyWorkspaceRelative = true;
            } else {
                const base = `${String(webchatBasePath || '/webchat').replace(/\/+$/, '')}/`;
                if (url.origin === window.location.origin && url.pathname.startsWith(base)) {
                    candidate = decodeURIComponent(url.pathname.slice(base.length));
                }
            }
        } catch (_) {
            continue;
        }
        if (workspaceFilePreviewKind(candidate) === 'unknown') continue;
        if (!isKnownWorkspaceFile(fileIndex, candidate, workspaceBase)) {
            restoreExistingAnchor(anchor);
            continue;
        }
        const href = buildWorkspaceFileUrl(candidate, alreadyWorkspaceRelative ? '' : workspaceBase);
        if (!href) continue;
        if (anchor.dataset.wcFileEnhanced !== 'true') {
            anchor.dataset.wcOriginalHref = anchor.getAttribute?.('href') || anchor.href;
        }
        anchor.href = href;
        anchor.dataset.wcFile = 'true';
        anchor.dataset.wcFileEnhanced = 'true';
        anchor.dataset.wcFilePath = normalizeWorkspaceFileCandidate(candidate)?.path || candidate;
        anchor.classList?.add?.('wa-workspace-file-link');
    }
}

export function enhanceWorkspaceFileLinks(container, {
    workspaceBase = '',
    webchatBasePath = '/webchat',
    fileIndex = null,
} = {}) {
    if (!container || !container.ownerDocument) return 0;
    reconcileAutoAnchors(container, { workspaceBase, fileIndex });
    enhanceExistingAnchors(container, { workspaceBase, webchatBasePath, fileIndex });

    const documentRef = container.ownerDocument;
    const walker = documentRef.createTreeWalker(container, 4);
    const textNodes = [];
    let current;
    while ((current = walker.nextNode())) textNodes.push(current);

    let linked = 0;
    for (const textNode of textNodes) {
        if (!textNode.parentNode || isInsideSkippedElement(textNode)) continue;
        const text = textNode.nodeValue || '';
        const matches = findWorkspaceFileCandidates(text, {
            allowWholeTextWithSpaces: isInlineCodeNode(textNode),
        });
        if (!matches.length) continue;

        const fragment = documentRef.createDocumentFragment();
        let cursor = 0;
        for (const match of matches) {
            if (match.start > cursor) {
                fragment.appendChild(documentRef.createTextNode(text.slice(cursor, match.start)));
            }
            const anchor = createFileAnchor(documentRef, match, workspaceBase, fileIndex);
            if (anchor) {
                fragment.appendChild(anchor);
                linked += 1;
            } else {
                fragment.appendChild(documentRef.createTextNode(match.raw));
            }
            cursor = match.end;
        }
        if (cursor < text.length) {
            fragment.appendChild(documentRef.createTextNode(text.slice(cursor)));
        }
        textNode.parentNode.replaceChild(fragment, textNode);
    }
    return linked;
}

export const __testables = { isKnownWorkspaceFile };
