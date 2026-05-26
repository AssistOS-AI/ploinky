const MENU_MAX_VISIBLE = 8;

export function findTriggerAt(value, caretIndex, triggers) {
    const inputValue = typeof value === 'string' ? value : '';
    const safeCaret = Math.max(0, Math.min(inputValue.length, caretIndex));
    let best = null;
    for (const trigger of triggers || []) {
        const triggerChar = String(trigger || '');
        if (!triggerChar) continue;
        const idx = inputValue.lastIndexOf(triggerChar, Math.max(0, safeCaret - 1));
        if (idx === -1) continue;
        if (idx > 0) {
            const prev = inputValue.charAt(idx - 1);
            if (prev && !/\s/.test(prev) && prev !== '\n') continue;
        }
        const after = inputValue.slice(idx + 1, safeCaret);
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

export function createComposerAutocomplete({ cmdInput }, { providers = [], dlog, onSelectionApplied } = {}) {
    let providerList = Array.isArray(providers) ? providers.slice() : [];
    let menuEl = null;
    let active = false;
    let suggestionsCache = [];
    let selectedIndex = -1;

    function ensureMenuElement() {
        if (menuEl) return menuEl;
        menuEl = document.createElement('div');
        menuEl.className = 'wa-slash-menu';
        menuEl.setAttribute('role', 'listbox');
        menuEl.setAttribute('aria-label', 'Composer suggestions');
        menuEl.addEventListener('pointerdown', (e) => { e.preventDefault(); });
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

    function hideMenu() {
        if (menuEl) {
            menuEl.style.display = 'none';
        }
        active = false;
        selectedIndex = -1;
        suggestionsCache = [];
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
        cmdInput.focus();
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
        hideMenu();
    }

    function renderMenu() {
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
        active = true;

        const menu = ensureMenuElement();
        clearChildren(menu);

        const startIdx = selectedIndex >= MENU_MAX_VISIBLE
            ? selectedIndex - MENU_MAX_VISIBLE + 1
            : 0;
        const visible = suggestionsCache.slice(startIdx, startIdx + MENU_MAX_VISIBLE);

        let lastGroup = null;
        const showGroupHeaders = groups.length > 1 || triggerInfo.trigger === '@';

        visible.forEach((suggestion, i) => {
            const absoluteIdx = i + startIdx;
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
    }

    function scheduleFetchAndRender() {
        const triggerInfo = activeTrigger();
        if (!triggerInfo) {
            hideMenu();
            return;
        }
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
                    if (cmdInput && activeTrigger()) {
                        renderMenu();
                    }
                });
        }
    }

    function onInputChange() {
        const triggerInfo = activeTrigger();
        if (!triggerInfo) {
            hideMenu();
            return;
        }
        scheduleFetchAndRender();
    }

    function handleKeydown(event) {
        if (!active || !menuEl || menuEl.style.display === 'none') return false;
        const length = suggestionsCache.length;
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            selectedIndex = Math.min(selectedIndex + 1, length - 1);
            renderMenu();
            return true;
        }
        if (event.key === 'ArrowUp') {
            event.preventDefault();
            selectedIndex = Math.max(selectedIndex - 1, 0);
            renderMenu();
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
            hideMenu();
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
        hideMenu();
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
