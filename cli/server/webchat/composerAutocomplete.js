const MENU_RENDER_BATCH = 24;
const MENU_LOAD_THRESHOLD_PX = 64;

export function findTriggerAt(value, caretIndex, triggers) {
    const inputValue = typeof value === 'string' ? value : '';
    const safeCaret = Math.max(0, Math.min(inputValue.length, caretIndex));
    let best = null;
    for (const trigger of triggers || []) {
        const triggerChar = String(trigger || '');
        if (!triggerChar) continue;
        const idx = triggerChar === '/'
            ? (inputValue.startsWith('/') && safeCaret > 0 ? 0 : -1)
            : inputValue.lastIndexOf(triggerChar, Math.max(0, safeCaret - 1));
        if (idx === -1) continue;
        if (idx > 0) {
            const prev = inputValue.charAt(idx - 1);
            if (prev && !/\s/.test(prev) && prev !== '\n') continue;
        }
        const after = inputValue.slice(idx + 1, safeCaret);
        if (triggerChar === '@' && /\s/.test(after)) continue;
        if (/[\n\r]/.test(after)) continue;
        if (!best || idx > best.triggerIndex) {
            best = { trigger: triggerChar, triggerIndex: idx, token: after };
        }
    }
    return best;
}

function clearChildren(node) {
    while (node && node.firstChild) {
        node.removeChild(node.firstChild);
    }
}

export function keepAutocompleteItemVisible(menu, item) {
    if (!menu || !item) return;
    const viewportHeight = Number(menu.clientHeight) || 0;
    const itemHeight = Number(item.offsetHeight) || 0;
    if (viewportHeight <= 0 || itemHeight <= 0) return;

    const viewportTop = Number(menu.scrollTop) || 0;
    const viewportBottom = viewportTop + viewportHeight;
    const itemTop = Number(item.offsetTop) || 0;
    const itemBottom = itemTop + itemHeight;

    if (itemTop < viewportTop) {
        menu.scrollTop = itemTop;
    } else if (itemBottom > viewportBottom) {
        menu.scrollTop = Math.max(0, itemBottom - viewportHeight);
    }
}

export function nextAutocompleteRenderCount(currentCount, totalCount, batchSize = MENU_RENDER_BATCH) {
    const total = Math.max(0, Number(totalCount) || 0);
    const current = Math.max(0, Number(currentCount) || 0);
    const batch = Math.max(1, Number(batchSize) || MENU_RENDER_BATCH);
    return Math.min(total, Math.max(current, 0) + batch);
}

export function createComposerAutocomplete({ cmdInput }, { providers = [], dlog, onSelectionApplied } = {}) {
    let providerList = Array.isArray(providers) ? providers.slice() : [];
    let menuEl = null;
    let active = false;
    let suggestionsCache = [];
    let selectedIndex = -1;
    let renderedSuggestionCount = MENU_RENDER_BATCH;
    let renderingMenu = false;
    let requestGeneration = 0;

    function ensureMenuElement() {
        if (menuEl) return menuEl;
        menuEl = document.createElement('div');
        menuEl.className = 'wa-slash-menu';
        menuEl.setAttribute('role', 'listbox');
        menuEl.setAttribute('aria-label', 'Composer suggestions');
        menuEl.addEventListener('pointerdown', (e) => { e.preventDefault(); });
        menuEl.addEventListener('scroll', () => {
            if (!active || renderingMenu || renderedSuggestionCount >= suggestionsCache.length) return;
            const remaining = menuEl.scrollHeight - menuEl.clientHeight - menuEl.scrollTop;
            if (remaining > MENU_LOAD_THRESHOLD_PX) return;
            const scrollTop = menuEl.scrollTop;
            renderedSuggestionCount = nextAutocompleteRenderCount(
                renderedSuggestionCount,
                suggestionsCache.length
            );
            renderMenu({
                preserveScrollTop: scrollTop,
                ensureSelectedVisible: false,
            });
        });
        document.body.appendChild(menuEl);
        return menuEl;
    }

    function positionMenu() {
        if (!menuEl || !cmdInput) return;
        const rect = cmdInput.getBoundingClientRect();
        const composerRect = cmdInput.closest('.wa-composer')?.getBoundingClientRect();
        if (!composerRect) return;
        menuEl.style.left = `${rect.left - composerRect.left}px`;
        menuEl.style.bottom = `${composerRect.bottom - rect.top + 4}px`;
        menuEl.style.width = `${Math.max(320, rect.width)}px`;
    }

    function hideMenu({ invalidatePending = false } = {}) {
        if (invalidatePending) requestGeneration += 1;
        if (menuEl) {
            menuEl.style.display = 'none';
        }
        active = false;
        selectedIndex = -1;
        suggestionsCache = [];
        renderedSuggestionCount = MENU_RENDER_BATCH;
    }

    function activeTrigger() {
        const triggers = providerList.map((p) => p.trigger).filter(Boolean);
        if (!triggers.length || !cmdInput) return null;
        const value = cmdInput.value || '';
        const caret = typeof cmdInput.selectionStart === 'number' ? cmdInput.selectionStart : value.length;
        return findTriggerAt(value, caret, triggers);
    }

    function collectSuggestions(triggerInfo) {
        const matched = providerList.filter((p) => p.trigger === triggerInfo.trigger);
        const value = cmdInput.value || '';
        const caret = typeof cmdInput.selectionStart === 'number' ? cmdInput.selectionStart : value.length;
        const groups = [];
        for (const provider of matched) {
            let suggestions = [];
            try {
                suggestions = provider.getSuggestions
                    ? provider.getSuggestions(value, caret, triggerInfo)
                    : [];
            } catch (err) {
                dlog?.('ComposerAutocomplete: provider getSuggestions failed', err?.message || err);
                suggestions = [];
            }
            if (!Array.isArray(suggestions) || suggestions.length === 0) continue;
            const groupLabel = provider.groupLabel || provider.trigger;
            groups.push({
                groupLabel,
                provider,
                suggestions: suggestions.map((entry) => ({
                    ...entry,
                    provider,
                    group: entry.group || groupLabel
                }))
            });
        }
        const flat = [];
        for (const group of groups) {
            for (const suggestion of group.suggestions) {
                flat.push(suggestion);
            }
        }
        return { flat, groups };
    }

    function applySelection(suggestion) {
        if (!suggestion || !cmdInput) return;
        const value = cmdInput.value || '';
        const triggerInfo = activeTrigger();
        let next = null;
        if (typeof suggestion.applySelection === 'function') {
            next = suggestion.applySelection(value, triggerInfo);
        } else if (suggestion.provider && typeof suggestion.provider.applySelection === 'function') {
            next = suggestion.provider.applySelection(value, suggestion, triggerInfo);
        }
        if (!next) return;
        cmdInput.value = next.value;
        cmdInput.focus();
        try {
            cmdInput.setSelectionRange(next.cursor, next.cursor);
        } catch (_) { /* selection support is best-effort */ }
        if (typeof onSelectionApplied === 'function') {
            try {
                onSelectionApplied({ suggestion, previousValue: value, next, triggerInfo });
            } catch (err) {
                dlog?.('ComposerAutocomplete: onSelectionApplied handler failed', err?.message || err);
            }
        }
        cmdInput.dispatchEvent(new Event('input', { bubbles: true }));
        try {
            cmdInput.setSelectionRange(next.cursor, next.cursor);
        } catch (_) { /* input listeners must not leave the caret at a stale position */ }
        if (typeof suggestion.onSelected === 'function') {
            try {
                suggestion.onSelected();
            } catch (err) {
                dlog?.('ComposerAutocomplete: onSelected handler failed', err?.message || err);
            }
        }
        if (suggestion.keepMenuOpen) {
            active = true;
            renderMenu();
            return;
        }
        hideMenu({ invalidatePending: true });
    }

    function renderMenu({ preserveScrollTop = null, ensureSelectedVisible = true } = {}) {
        if (!cmdInput) {
            hideMenu();
            return;
        }
        const triggerInfo = activeTrigger();
        if (!triggerInfo) {
            hideMenu();
            return;
        }
        const { flat, groups } = collectSuggestions(triggerInfo);
        if (!flat.length) {
            hideMenu();
            return;
        }
        suggestionsCache = flat;
        if (selectedIndex < 0 || selectedIndex >= suggestionsCache.length) {
            selectedIndex = 0;
        }
        while (selectedIndex >= renderedSuggestionCount) {
            renderedSuggestionCount = nextAutocompleteRenderCount(
                renderedSuggestionCount,
                suggestionsCache.length
            );
        }
        renderedSuggestionCount = Math.min(
            Math.max(MENU_RENDER_BATCH, renderedSuggestionCount),
            suggestionsCache.length
        );
        active = true;

        const menu = ensureMenuElement();
        renderingMenu = true;
        clearChildren(menu);
        const visible = suggestionsCache.slice(0, renderedSuggestionCount);

        let lastGroup = null;
        let activeItem = null;
        const showGroupHeaders = groups.length > 1 || triggerInfo.trigger === '@';

        visible.forEach((suggestion, i) => {
            const absoluteIdx = i;
            if (showGroupHeaders && suggestion.group && suggestion.group !== lastGroup) {
                const header = document.createElement('div');
                header.className = 'wa-slash-menu-group';
                header.textContent = suggestion.group || '';
                menu.appendChild(header);
                lastGroup = suggestion.group;
            }

            const item = document.createElement('div');
            item.className = 'wa-slash-menu-item' + (absoluteIdx === selectedIndex ? ' wa-slash-menu-item-active' : '');
            item.setAttribute('role', 'option');
            item.setAttribute('aria-selected', absoluteIdx === selectedIndex ? 'true' : 'false');
            item.setAttribute('data-suggestion-index', String(absoluteIdx));
            if (absoluteIdx === selectedIndex) {
                activeItem = item;
            }

            const label = document.createElement('span');
            label.className = 'wa-slash-menu-label';
            label.textContent = suggestion.label;

            const desc = document.createElement('span');
            desc.className = 'wa-slash-menu-desc';
            desc.textContent = suggestion.description || '';

            item.appendChild(label);
            item.appendChild(desc);

            item.addEventListener('pointerdown', (event) => {
                event.preventDefault();
                event.stopPropagation();
                selectedIndex = absoluteIdx;
                applySelection(suggestionsCache[absoluteIdx]);
            });

            menu.appendChild(item);
        });

        positionMenu();
        menu.style.display = 'block';
        if (preserveScrollTop !== null) {
            menu.scrollTop = preserveScrollTop;
        }
        if (ensureSelectedVisible) {
            keepAutocompleteItemVisible(menu, activeItem);
        }
        renderingMenu = false;
    }

    function moveSelection(nextIndex) {
        const boundedIndex = Math.max(0, Math.min(nextIndex, suggestionsCache.length - 1));
        if (boundedIndex === selectedIndex) return;

        if (boundedIndex >= renderedSuggestionCount) {
            const scrollTop = menuEl?.scrollTop ?? 0;
            selectedIndex = boundedIndex;
            renderedSuggestionCount = nextAutocompleteRenderCount(
                renderedSuggestionCount,
                suggestionsCache.length
            );
            renderMenu({ preserveScrollTop: scrollTop, ensureSelectedVisible: true });
            return;
        }

        const previousItem = menuEl?.querySelector?.(`[data-suggestion-index="${selectedIndex}"]`);
        previousItem?.classList?.remove('wa-slash-menu-item-active');
        previousItem?.setAttribute?.('aria-selected', 'false');

        selectedIndex = boundedIndex;
        const nextItem = menuEl?.querySelector?.(`[data-suggestion-index="${selectedIndex}"]`);
        if (!nextItem) {
            renderMenu({ preserveScrollTop: menuEl?.scrollTop ?? 0, ensureSelectedVisible: true });
            return;
        }
        nextItem.classList.add('wa-slash-menu-item-active');
        nextItem.setAttribute('aria-selected', 'true');
        keepAutocompleteItemVisible(menuEl, nextItem);
    }

    function scheduleFetchAndRender() {
        const triggerInfo = activeTrigger();
        if (!triggerInfo) {
            hideMenu({ invalidatePending: true });
            return;
        }
        const generation = ++requestGeneration;
        const matched = providerList.filter((p) => p.trigger === triggerInfo.trigger);
        renderMenu();
        for (const provider of matched) {
            if (typeof provider.requestSuggestions !== 'function') continue;
            Promise.resolve()
                .then(() => provider.requestSuggestions(cmdInput.value || '', triggerInfo))
                .catch((err) => {
                    dlog?.('ComposerAutocomplete: provider requestSuggestions failed', err?.message || err);
                })
                .finally(() => {
                    if (generation === requestGeneration && cmdInput && activeTrigger()) {
                        renderMenu({
                            preserveScrollTop: menuEl?.scrollTop ?? 0,
                            ensureSelectedVisible: false,
                        });
                    }
                });
        }
    }

    function onInputChange() {
        const triggerInfo = activeTrigger();
        if (!triggerInfo) {
            hideMenu({ invalidatePending: true });
            return;
        }
        selectedIndex = -1;
        renderedSuggestionCount = MENU_RENDER_BATCH;
        scheduleFetchAndRender();
    }

    function handleKeydown(event) {
        if (!active || !menuEl || menuEl.style.display === 'none') return false;
        const length = suggestionsCache.length;
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            moveSelection(Math.min(selectedIndex + 1, length - 1));
            return true;
        }
        if (event.key === 'ArrowUp') {
            event.preventDefault();
            moveSelection(Math.max(selectedIndex - 1, 0));
            return true;
        }
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)) {
            return false;
        }
        if ((event.key === 'Enter' || event.key === 'Tab') && selectedIndex >= 0) {
            event.preventDefault();
            applySelection(suggestionsCache[selectedIndex]);
            return true;
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            hideMenu({ invalidatePending: true });
            return true;
        }
        return false;
    }

    async function refresh() {
        const refreshes = providerList.map((provider) => {
            if (typeof provider.refresh !== 'function') return Promise.resolve();
            return Promise.resolve(provider.refresh()).catch((err) => {
                dlog?.('ComposerAutocomplete: provider refresh failed', err?.message || err);
            });
        });
        await Promise.all(refreshes);
    }

    function destroy() {
        hideMenu({ invalidatePending: true });
        if (menuEl) {
            menuEl.remove();
            menuEl = null;
        }
        providerList = [];
    }

    return {
        onInputChange,
        handleKeydown,
        refresh,
        destroy,
        get isActive() { return active; }
    };
}
