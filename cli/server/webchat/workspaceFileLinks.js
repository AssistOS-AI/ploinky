const FILE_EXTENSIONS = Object.freeze([
    'c', 'cc', 'cpp', 'cs', 'css', 'csv', 'go', 'h', 'hpp', 'htm', 'html',
    'java', 'jpeg', 'jpg', 'js', 'json', 'jsx', 'log', 'md', 'mdx', 'mjs',
    'pdf', 'php', 'png', 'py', 'rb', 'rs', 'scss', 'sh', 'sql', 'svg', 'toml',
    'ts', 'tsx', 'txt', 'webp', 'xml', 'yaml', 'yml',
]);
const EXTENSION_PATTERN = FILE_EXTENSIONS.join('|');
// An absolute candidate is linked only when it lies strictly beneath the
// trusted workspace root that the page received; see normalization below.
const BARE_FILE_RE = new RegExp(
    `(?:^|[\\s([{<])((?:@|\\./|/)?(?:[\\p{L}\\p{N}_+.-]+/)*[\\p{L}\\p{N}_+.-]+\\.(?:${EXTENSION_PATTERN})(?::\\d+(?::\\d+)?)?)(?=$|[\\s)\\]}>.,'\";!?])`,
    'giu',
);
const QUOTED_FILE_RE = new RegExp(
    `([\"'])((?:@|\\./)?[^\"'\\n]{1,240}\\.(?:${EXTENSION_PATTERN})(?::\\d+(?::\\d+)?)?)\\1`,
    'giu',
);
// Reserve an entire absolute reference even when its root is not ours. Its
// whitespace-separated suffix must never become an unrelated relative link.
const ABSOLUTE_FILE_RE = new RegExp(
    `(?:^|[\\s([{<"'])(/[^\\r\\n"'<>,;!?]{0,4096}?(?:\\.(?:${EXTENSION_PATTERN})|/README|/LICENSE|/Dockerfile|/Makefile)(?::\\d+(?::\\d+)?)?)(?=$|[\\s)\\]}>.,'";!?])`,
    'giu',
);
const SPECIAL_FILE_RE = /(?:^|[\s([{<])((?:@|\.\/|\/)?(?:[\p{L}\p{N}_+.-]+\/)*(?:README|LICENSE|Dockerfile|Makefile))(?=$|[\s)\]}>.,'";!?])/giu;
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
    if (value.startsWith('./')) return value.slice(2);
    if (value.startsWith('@')) return value.slice(1);
    return value;
}

// The trusted workspace root is the selected host path, which is also its
// path inside the Box. Only a clean absolute root can admit absolute text.
function normalizeWorkspaceRoot(value) {
    const root = String(value || '');
    if (!root.startsWith('/') || root === '/' || root.endsWith('/') || root.includes('\0')
        || root.split('/').slice(1).some((segment) => !segment || segment === '.' || segment === '..')) {
        return '';
    }
    return root;
}

export function normalizeWorkspaceFileCandidate(rawCandidate, { workspaceRoot = '' } = {}) {
    const display = String(rawCandidate || '').trim();
    if (!display || display.includes('\0')) return null;

    const locationMatch = LINE_SUFFIX_RE.exec(display);
    const withoutLocation = locationMatch
        ? display.slice(0, locationMatch.index)
        : display;
    let candidate = withoutLocation;
    let rootRelative = false;
    if (candidate.startsWith('/')) {
        // Absolute text names a workspace file only strictly beneath the root.
        const root = normalizeWorkspaceRoot(workspaceRoot);
        if (!root || !candidate.startsWith(`${root}/`)) return null;
        candidate = candidate.slice(root.length + 1);
        rootRelative = true;
    } else {
        candidate = stripWorkspaceAlias(candidate.replace(/\\+/g, '/'));
    }
    const normalized = candidate.replace(/\/{2,}/g, '/');
    if (!normalized || normalized.startsWith('/')) return null;
    const segments = normalized.split('/');
    if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;

    return {
        display,
        path: normalized,
        rootRelative,
        line: locationMatch ? Number.parseInt(locationMatch[1], 10) : null,
        column: locationMatch?.[2] ? Number.parseInt(locationMatch[2], 10) : null,
    };
}

function pushMatches(text, regex, groupIndex, matches, options) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(text)) !== null) {
        const value = match[groupIndex];
        const offset = match[0].indexOf(value);
        const start = match.index + Math.max(0, offset);
        const normalized = normalizeWorkspaceFileCandidate(value, options);
        if (!normalized) continue;
        matches.push({
            ...normalized,
            raw: value,
            start,
            end: start + value.length,
        });
    }
}

export function findWorkspaceFileCandidates(text, { allowWholeTextWithSpaces = false, workspaceRoot = '' } = {}) {
    const input = String(text || '');
    if (!input) return [];
    const matches = [];
    const options = { workspaceRoot };
    const absoluteRanges = [...input.matchAll(ABSOLUTE_FILE_RE)].map((match) => {
        const start = match.index + match[0].indexOf(match[1]);
        return { start, end: start + match[1].length };
    });

    const root = normalizeWorkspaceRoot(workspaceRoot);
    if (root) {
        // Match the trusted prefix literally: host directories may contain
        // spaces, quotes, backslashes, or punctuation outside the bare grammar.
        const escapedRoot = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const rootedFileRe = new RegExp(
            `(?:^|[\\s([{<"'])(${escapedRoot}/(?:[\\p{L}\\p{N}_@+.-]+/)*(?:[\\p{L}\\p{N}_@+.-]+\\.(?:${EXTENSION_PATTERN})|README|LICENSE|Dockerfile|Makefile)(?::\\d+(?::\\d+)?)?)(?=$|[\\s)\\]}>.,'";!?])`,
            'giu',
        );
        pushMatches(input, rootedFileRe, 1, matches, options);
    }
    pushMatches(input, QUOTED_FILE_RE, 2, matches, options);
    pushMatches(input, BARE_FILE_RE, 1, matches, options);
    pushMatches(input, SPECIAL_FILE_RE, 1, matches, options);

    if (allowWholeTextWithSpaces) {
        const trimmed = input.trim();
        const fullPathRe = new RegExp(`\\.(?:${EXTENSION_PATTERN})(?::\\d+(?::\\d+)?)?$`, 'iu');
        if (trimmed.length <= 240 && fullPathRe.test(trimmed)) {
            const normalized = normalizeWorkspaceFileCandidate(trimmed, options);
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
        if (absoluteRanges.some((range) => match.start > range.start && match.end <= range.end)) continue;
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

function workspaceFileHref(normalized, workspaceBase) {
    const base = normalizeRelativeBase(workspaceBase);
    // A path proven beneath the workspace root is already root-relative.
    const relativePath = base
        && !normalized.rootRelative
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

export function buildWorkspaceFileUrl(filePath, workspaceBase = '', { workspaceRoot = '' } = {}) {
    const normalized = normalizeWorkspaceFileCandidate(filePath, { workspaceRoot });
    return normalized ? workspaceFileHref(normalized, workspaceBase) : null;
}

export function workspaceFilePreviewKind(filePath, { workspaceRoot = '' } = {}) {
    const normalized = normalizeWorkspaceFileCandidate(filePath, { workspaceRoot });
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

function isKnownNormalizedFile(fileIndex, normalized, workspaceBase) {
    if (!fileIndex || typeof fileIndex.has !== 'function' || !normalized) return false;
    const base = normalizeRelativeBase(workspaceBase);
    // The index is relative to the current base, so a root-relative path is
    // known only when it lies beneath that base.
    if (normalized.rootRelative && base) {
        return normalized.path.startsWith(`${base}/`)
            && fileIndex.has(normalized.path.slice(base.length + 1));
    }
    if (fileIndex.has(normalized.path)) return true;
    if (base && normalized.path.startsWith(`${base}/`)) {
        return fileIndex.has(normalized.path.slice(base.length + 1));
    }
    return false;
}

function isKnownWorkspaceFile(fileIndex, filePath, workspaceBase, workspaceRoot = '') {
    return isKnownNormalizedFile(
        fileIndex,
        normalizeWorkspaceFileCandidate(filePath, { workspaceRoot }),
        workspaceBase,
    );
}

function autoAnchorFile(anchor) {
    const path = anchor.dataset?.wcFilePath || '';
    return path ? { path, rootRelative: anchor.dataset?.wcFileRootRelative === 'true' } : null;
}

function createFileAnchor(documentRef, match, workspaceBase, fileIndex) {
    if (!isKnownNormalizedFile(fileIndex, match, workspaceBase)) return null;
    const href = workspaceFileHref(match, workspaceBase);
    const anchor = documentRef.createElement('a');
    anchor.href = href;
    anchor.className = 'wa-workspace-file-link';
    anchor.dataset.wcLink = 'true';
    anchor.dataset.wcFile = 'true';
    anchor.dataset.wcAutoFile = 'true';
    anchor.dataset.wcFilePath = match.path;
    if (match.rootRelative) anchor.dataset.wcFileRootRelative = 'true';
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
        if (isKnownNormalizedFile(fileIndex, autoAnchorFile(anchor), workspaceBase)) continue;
        const text = container.ownerDocument.createTextNode(anchor.textContent || '');
        anchor.parentNode?.replaceChild?.(text, anchor);
    }
}

function enhanceExistingAnchors(container, { workspaceBase, workspaceRoot, webchatBasePath, fileIndex }) {
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
                } else if (url.origin === window.location.origin) {
                    // Markdown turns an absolute filesystem reference into a
                    // same-origin URL. Admit it through the same trusted root.
                    candidate = decodeURIComponent(url.pathname);
                }
            }
        } catch (_) {
            continue;
        }
        if (workspaceFilePreviewKind(candidate, { workspaceRoot }) === 'unknown') continue;
        if (!isKnownWorkspaceFile(fileIndex, candidate, workspaceBase, workspaceRoot)) {
            restoreExistingAnchor(anchor);
            continue;
        }
        const href = buildWorkspaceFileUrl(candidate, alreadyWorkspaceRelative ? '' : workspaceBase, { workspaceRoot });
        if (!href) continue;
        if (anchor.dataset.wcFileEnhanced !== 'true') {
            anchor.dataset.wcOriginalHref = anchor.getAttribute?.('href') || anchor.href;
        }
        anchor.href = href;
        anchor.dataset.wcFile = 'true';
        anchor.dataset.wcFileEnhanced = 'true';
        anchor.dataset.wcFilePath = normalizeWorkspaceFileCandidate(candidate, { workspaceRoot })?.path || candidate;
        anchor.classList?.add?.('wa-workspace-file-link');
    }
}

export function enhanceWorkspaceFileLinks(container, {
    workspaceBase = '',
    workspaceRoot = '',
    webchatBasePath = '/webchat',
    fileIndex = null,
} = {}) {
    if (!container || !container.ownerDocument) return 0;
    reconcileAutoAnchors(container, { workspaceBase, fileIndex });
    enhanceExistingAnchors(container, { workspaceBase, workspaceRoot, webchatBasePath, fileIndex });

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
            workspaceRoot,
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
