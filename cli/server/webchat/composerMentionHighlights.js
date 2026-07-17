function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function normalizeToken(token) {
    const value = String(token || '').trim();
    if (!value.startsWith('@') || value.length <= 1 || /\s/.test(value)) return '';
    return value;
}

function isStartBoundary(value, index) {
    if (index <= 0) return true;
    return /\s/.test(value.charAt(index - 1));
}

function isEndBoundary(value, index) {
    if (index >= value.length) return true;
    return /\s/.test(value.charAt(index));
}

function isDetectedEndBoundary(value, index) {
    if (isEndBoundary(value, index)) return true;
    return /[),;:!?]/.test(value.charAt(index));
}

export function extractMentionTokenAt(value, cursor) {
    const text = typeof value === 'string' ? value : '';
    if (!text) return '';
    let pos = Number.isFinite(cursor) ? Math.max(0, Math.min(text.length, cursor)) : text.length;
    while (pos > 0 && /\s/.test(text.charAt(pos - 1))) {
        pos -= 1;
    }
    let start = pos;
    while (start > 0 && !/\s/.test(text.charAt(start - 1))) {
        start -= 1;
    }
    let end = pos;
    while (end < text.length && !/\s/.test(text.charAt(end))) {
        end += 1;
    }
    return normalizeToken(text.slice(start, end));
}

export function findMentionRanges(value, tokens = []) {
    const text = typeof value === 'string' ? value : '';
    if (!text) return [];

    const ranges = [];
    for (const token of normalizeTokens(tokens)) {
        let start = text.indexOf(token);
        while (start !== -1) {
            const end = start + token.length;
            if (isStartBoundary(text, start) && isDetectedEndBoundary(text, end)) {
                ranges.push({ start, end, token });
            }
            start = text.indexOf(token, start + token.length);
        }
    }
    return ranges.sort((a, b) => a.start - b.start || b.end - a.end);
}

function normalizeTokens(tokens) {
    const unique = new Set();
    for (const raw of tokens || []) {
        const token = normalizeToken(raw);
        if (token) unique.add(token);
    }
    return Array.from(unique).sort((a, b) => b.length - a.length);
}

export function renderMentionHighlightHtml(value, tokens) {
    const text = typeof value === 'string' ? value : '';
    const selected = normalizeTokens(tokens);
    if (!text) return '';

    let html = '';
    let index = 0;
    while (index < text.length) {
        const match = selected.find((token) => (
            text.startsWith(token, index)
            && isStartBoundary(text, index)
            && isEndBoundary(text, index + token.length)
        ));
        if (match) {
            html += `<strong class="wa-composer-mention">${escapeHtml(match)}</strong>`;
            index += match.length;
            continue;
        }
        html += escapeHtml(text.charAt(index));
        index += 1;
    }
    return html;
}

export function createComposerMentionHighlighter({ cmdInput } = {}) {
    const selectedTokens = new Set();
    const wrapper = cmdInput?.closest?.('.wa-composer-input-wrapper') || null;
    let overlay = null;

    function ensureOverlay() {
        if (!cmdInput || !wrapper) return null;
        if (overlay) return overlay;
        overlay = document.createElement('div');
        overlay.className = 'wa-composer-input-highlights';
        overlay.setAttribute('aria-hidden', 'true');
        wrapper.insertBefore(overlay, cmdInput);
        return overlay;
    }

    function deactivateOverlay() {
        wrapper?.classList?.remove('wa-mention-highlights-active');
        if (!overlay) return;
        overlay.hidden = true;
        overlay.innerHTML = '';
    }

    function pruneByText(text) {
        const value = typeof text === 'string' ? text : '';
        for (const token of Array.from(selectedTokens)) {
            if (!value.includes(token)) {
                selectedTokens.delete(token);
            }
        }
    }

    function syncScroll() {
        if (!overlay || !cmdInput) return;
        overlay.scrollTop = cmdInput.scrollTop || 0;
        overlay.scrollLeft = cmdInput.scrollLeft || 0;
    }

    function render() {
        if (!cmdInput) return;
        const value = cmdInput.value || '';
        pruneByText(value);
        if (selectedTokens.size === 0) {
            deactivateOverlay();
            return;
        }
        const target = ensureOverlay();
        if (!target) return;
        target.innerHTML = renderMentionHighlightHtml(value, selectedTokens);
        target.hidden = false;
        wrapper.classList.add('wa-mention-highlights-active');
        syncScroll();
    }

    function addToken(token) {
        const normalized = normalizeToken(token);
        if (!normalized) return;
        selectedTokens.add(normalized);
        render();
    }

    function recordSelection(value, cursor, { final = true } = {}) {
        if (!final) {
            pruneByText(value);
            render();
            return;
        }
        addToken(extractMentionTokenAt(value, cursor));
    }

    function clear() {
        selectedTokens.clear();
        deactivateOverlay();
    }

    if (cmdInput) {
        cmdInput.addEventListener('input', render);
        cmdInput.addEventListener('scroll', syncScroll);
        render();
    }

    return {
        addToken,
        clear,
        pruneByText: (text) => {
            pruneByText(text);
            render();
        },
        recordSelection,
        render,
        get tokens() { return Array.from(selectedTokens); },
    };
}
