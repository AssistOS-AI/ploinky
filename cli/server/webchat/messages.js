import { formatBytes, getFileIcon } from './fileHelpers.js';
import { findMentionRanges } from './composerMentionHighlights.js';
import { attachInlineTaskPanel } from './taskPresentation.js';

const ENABLE_SELECT_PAGINATION_ACTIONS = false;
const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 4;

function findOrderedInsertionPoint(children, messageIndex, typingIndicator, historyGate) {
    const items = Array.from(children || []);
    let insertionPoint = items.includes(typingIndicator) ? typingIndicator : null;
    if (!Number.isInteger(messageIndex)) return insertionPoint;
    for (const child of items) {
        if (child === typingIndicator || child === historyGate) continue;
        const candidateIndex = Number(child?.dataset?.messageIndex);
        if (Number.isInteger(candidateIndex) && candidateIndex > messageIndex) {
            return child;
        }
    }
    return insertionPoint;
}

export const __testables = { findOrderedInsertionPoint };

function formatTime(timestamp = null) {
    const parsed = timestamp ? new Date(timestamp) : new Date();
    const date = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
}

export function createMessages({
    chatList,
    typingIndicator,
    historyGate
}, {
    markdown,
    initialViewMoreLineLimit,
    sidePanel,
    taskController,
    onQuickCommand,
    onTypingStateChange
}) {
    const lastServerMsg = { bubble: null, fullText: '' };
    let userInputSent = false;
    let viewMoreLineLimit = Math.max(1, initialViewMoreLineLimit || 1);
    let quickCommandHandler = typeof onQuickCommand === 'function' ? onQuickCommand : null;
    let typingStateHandler = typeof onTypingStateChange === 'function' ? onTypingStateChange : null;
    let autoScrollLocked = true;
    let programmaticScroll = false;
    let pendingProgressItems = [];
    const taskItems = new Map();
    const taskPanelCleanups = new Map();
    const tableScrollHintBindings = new WeakMap();

    function isScrolledToBottom() {
        if (!chatList) {
            return true;
        }
        const distanceFromBottom = chatList.scrollHeight - chatList.scrollTop - chatList.clientHeight;
        return distanceFromBottom <= AUTO_SCROLL_BOTTOM_THRESHOLD_PX;
    }

    function updateAutoScrollLockFromPosition() {
        autoScrollLocked = isScrolledToBottom();
    }

    function scrollToBottomIfLocked() {
        if (!chatList || !autoScrollLocked) {
            return;
        }
        try {
            programmaticScroll = true;
            chatList.scrollTop = chatList.scrollHeight;
        } catch (_) {
            // Ignore scroll failures
        } finally {
            window.requestAnimationFrame(() => {
                programmaticScroll = false;
                updateAutoScrollLockFromPosition();
            });
        }
    }

    if (chatList) {
        updateAutoScrollLockFromPosition();
        chatList.addEventListener('scroll', () => {
            if (!programmaticScroll) {
                updateAutoScrollLockFromPosition();
            }
        }, { passive: true });
    }

    function appendMessageEl(node, messageIndex = null) {
        if (!node || !chatList) {
            return;
        }
        if (Number.isInteger(messageIndex)) {
            node.dataset.messageIndex = String(messageIndex);
        }
        try {
            const insertionPoint = findOrderedInsertionPoint(
                Array.from(chatList.children).filter((child) => child !== node),
                messageIndex,
                typingIndicator,
                historyGate,
            );
            if (insertionPoint) {
                chatList.insertBefore(node, insertionPoint);
            } else {
                chatList.appendChild(node);
            }
        } catch (_) {
            try {
                chatList.appendChild(node);
            } catch (__) {
                // Ignore append errors
            }
        }
    }

    let typingActive = false;

    function normalizeProgressItem(raw) {
        if (typeof raw === 'string') {
            const reason = raw.trim();
            return reason ? { reason, tool: '', stepIndex: null } : null;
        }
        if (!raw || typeof raw !== 'object') {
            return null;
        }
        const reason = String(raw.reason || '').trim();
        if (!reason) {
            return null;
        }
        return {
            reason,
            tool: typeof raw.tool === 'string' ? raw.tool.trim() : '',
            stepIndex: Number.isFinite(raw.stepIndex) ? raw.stepIndex : null
        };
    }

    function renderTypingProgress() {
        if (!typingIndicator) {
            return;
        }
        const label = typingIndicator.querySelector('.wa-typing-label');
        const list = typingIndicator.querySelector('.wa-typing-progress');
        if (label) {
            label.textContent = 'Thinking';
        }
        if (!list) {
            return;
        }
        list.replaceChildren();
        pendingProgressItems.slice(-5).forEach((item) => {
            const line = document.createElement('div');
            line.className = 'wa-typing-progress-line';
            line.textContent = item.reason;
            list.appendChild(line);
        });
    }

    function showTypingIndicator() {
        if (!typingIndicator) {
            return;
        }
        typingActive = true;
        renderTypingProgress();
        typingIndicator.classList.add('show');
        typingIndicator.setAttribute('aria-hidden', 'false');
        if (typingStateHandler) {
            typingStateHandler(true);
        }
        scrollToBottomIfLocked();
    }

    function hideTypingIndicator(force = false) {
        if (!typingIndicator) {
            return;
        }
        if (!typingActive && !force) {
            return;
        }
        typingActive = false;
        typingIndicator.classList.remove('show');
        typingIndicator.setAttribute('aria-hidden', 'true');
        if (typingStateHandler) {
            typingStateHandler(false);
        }
    }

    function addProgressEvent(raw) {
        const item = normalizeProgressItem(raw);
        if (!item) {
            return false;
        }
        pendingProgressItems.push(item);
        showTypingIndicator();
        return true;
    }

    function resetProgressEvents() {
        pendingProgressItems = [];
        renderTypingProgress();
    }

    function renderMarkdown(text) {
        if (!text) {
            return '';
        }
        if (markdown && typeof markdown.render === 'function') {
            try {
                return markdown.render(text);
            } catch (error) {
                console.error('[webchat] Markdown render error:', error);
                return text;
            }
        }
        return text;
    }

    function enhanceMarkdownTables(container) {
        if (!(container instanceof Element)) {
            return;
        }

        const normalizeHeader = (value) => String(value || '')
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .trim();

        const ensureTableScrollButtons = (tableWrap, tableShell) => {
            if (!(tableWrap instanceof HTMLElement) || !(tableShell instanceof HTMLElement)) {
                return;
            }
            let leftButton = tableShell.querySelector('.wa-md-scroll-btn--left');
            let rightButton = tableShell.querySelector('.wa-md-scroll-btn--right');
            if (leftButton instanceof HTMLButtonElement && rightButton instanceof HTMLButtonElement) {
                return;
            }

            const makeScrollButton = (direction, label) => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = `wa-md-scroll-btn wa-md-scroll-btn--${direction}`;
                button.setAttribute('aria-label', label);
                button.innerHTML = direction === 'left' ? '‹' : '›';
                button.addEventListener('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    const delta = Math.max(180, Math.round(tableWrap.clientWidth * 0.7));
                    tableWrap.scrollBy({
                        left: direction === 'left' ? -delta : delta,
                        behavior: 'smooth',
                    });
                });
                return button;
            };

            if (!(leftButton instanceof HTMLButtonElement)) {
                leftButton = makeScrollButton('left', 'Scroll table left');
                tableShell.appendChild(leftButton);
            }
            if (!(rightButton instanceof HTMLButtonElement)) {
                rightButton = makeScrollButton('right', 'Scroll table right');
                tableShell.appendChild(rightButton);
            }
        };

        const refreshTableScrollHint = (tableWrap, tableShell) => {
            if (!(tableWrap instanceof HTMLElement) || !(tableShell instanceof HTMLElement)) {
                return;
            }
            const maxScrollLeft = Math.max(0, tableWrap.scrollWidth - tableWrap.clientWidth);
            const isScrollable = maxScrollLeft > 6;
            tableShell.classList.toggle('wa-md-table-scrollable', isScrollable);

            if (!isScrollable) {
                tableShell.classList.remove('wa-md-table-can-scroll-left', 'wa-md-table-can-scroll-right');
                tableShell.querySelectorAll('.wa-md-scroll-btn').forEach((button) => button.remove());
                return;
            }

            ensureTableScrollButtons(tableWrap, tableShell);

            const canScrollLeft = tableWrap.scrollLeft > 6;
            const canScrollRight = tableWrap.scrollLeft < maxScrollLeft - 6;
            tableShell.classList.toggle('wa-md-table-can-scroll-left', canScrollLeft);
            tableShell.classList.toggle('wa-md-table-can-scroll-right', canScrollRight);
        };

        const bindTableScrollHint = (table, tableWrap, tableShell) => {
            if (!(tableWrap instanceof HTMLElement) || !(tableShell instanceof HTMLElement)) {
                return;
            }
            let binding = tableScrollHintBindings.get(tableWrap);
            if (!binding) {
                const update = () => refreshTableScrollHint(tableWrap, tableShell);
                binding = { update, resizeObserver: null, usesWindowResize: false };
                tableScrollHintBindings.set(tableWrap, binding);

                tableWrap.addEventListener('scroll', update, { passive: true });

                if (typeof ResizeObserver === 'function') {
                    const resizeObserver = new ResizeObserver(update);
                    resizeObserver.observe(tableWrap);
                    binding.resizeObserver = resizeObserver;
                } else {
                    window.addEventListener('resize', update);
                    binding.usesWindowResize = true;
                }
            }

            if (binding.resizeObserver && table instanceof Element) {
                binding.resizeObserver.observe(table);
            }

            binding.update();
            if (typeof window.requestAnimationFrame === 'function') {
                window.requestAnimationFrame(binding.update);
            }
        };

        const tables = container.querySelectorAll('.wa-md-table-wrap table.wa-md-table');
        tables.forEach((table) => {
            table.classList.add('wa-md-table--adaptive');
            const tableWrap = table.closest('.wa-md-table-wrap');
            if (!(tableWrap instanceof HTMLElement)) {
                return;
            }

            let tableShell = tableWrap.parentElement;
            if (!(tableShell instanceof HTMLElement) || !tableShell.classList.contains('wa-md-table-shell')) {
                tableShell = document.createElement('div');
                tableShell.className = 'wa-md-table-shell';
                tableWrap.parentNode?.insertBefore(tableShell, tableWrap);
                tableShell.appendChild(tableWrap);
            }
            bindTableScrollHint(table, tableWrap, tableShell);

            const headerLabels = Array.from(table.querySelectorAll('thead th'))
                .map((cell) => (cell.textContent || '').replace(/\s+/g, ' ').trim());
            const normalizedHeaders = headerLabels.map(normalizeHeader);

            const priorityIndices = [];
            const used = new Set();
            const addPriority = (predicate) => {
                for (let index = 0; index < normalizedHeaders.length; index += 1) {
                    if (used.has(index)) {
                        continue;
                    }
                    if (!predicate(normalizedHeaders[index])) {
                        continue;
                    }
                    used.add(index);
                    priorityIndices.push(index);
                    return;
                }
            };

            addPriority((header) => /\bid\b/.test(header));
            addPriority((header) => /\bname\b/.test(header) || /\bdescription\b/.test(header));
            addPriority((header) => /\bqty\b/.test(header) || /\bquantity\b/.test(header) || /\brequired\b/.test(header));
            addPriority((header) => /\bunit\b/.test(header));

            const minimumKeyColumns = Math.min(3, headerLabels.length);
            for (let index = 0; priorityIndices.length < minimumKeyColumns && index < headerLabels.length; index += 1) {
                if (used.has(index)) {
                    continue;
                }
                used.add(index);
                priorityIndices.push(index);
            }

            if (!priorityIndices.length) {
                for (let index = 0; index < Math.min(4, headerLabels.length); index += 1) {
                    priorityIndices.push(index);
                }
            }

            const priorityIndexSet = new Set(priorityIndices);
            const rows = table.querySelectorAll('tbody tr');
            rows.forEach((row) => {
                row.classList.remove('wa-md-row-has-extra', 'wa-md-row-expanded');
                const previousToggleCell = row.querySelector('.wa-md-row-toggle-cell');
                if (previousToggleCell) {
                    previousToggleCell.remove();
                }
                const previousToggle = row.querySelector('.wa-md-row-toggle');
                if (previousToggle) {
                    previousToggle.remove();
                }

                const cells = Array.from(row.querySelectorAll('th, td'));
                const extraCells = [];

                cells.forEach((cell, index) => {
                    const label = headerLabels[index] || 'Column ' + (index + 1);
                    cell.setAttribute('data-label', label);
                    cell.classList.remove('wa-md-mobile-key', 'wa-md-mobile-extra');

                    const isKeyCell = priorityIndexSet.has(index) || headerLabels.length <= 4;
                    const priorityOrder = priorityIndices.indexOf(index);
                    const mobileOrder = isKeyCell
                        ? (priorityOrder >= 0 ? priorityOrder + 1 : 20 + index)
                        : 100 + index;
                    cell.style.setProperty('--wa-mobile-order', String(mobileOrder));

                    if (isKeyCell) {
                        cell.classList.add('wa-md-mobile-key');
                    } else {
                        cell.classList.add('wa-md-mobile-extra');
                        extraCells.push(cell);
                    }
                });

                if (!extraCells.length) {
                    return;
                }

                row.classList.add('wa-md-row-has-extra');
                const toggleCell = document.createElement('td');
                toggleCell.className = 'wa-md-row-toggle-cell';
                toggleCell.colSpan = String(Math.max(1, cells.length));
                toggleCell.setAttribute('data-label', '');
                toggleCell.style.setProperty('--wa-mobile-order', '10000');

                const toggleButton = document.createElement('button');
                toggleButton.type = 'button';
                toggleButton.className = 'wa-md-row-toggle';

                const syncToggleLabel = () => {
                    const expanded = row.classList.contains('wa-md-row-expanded');
                    toggleButton.textContent = expanded ? 'Hide details' : 'Show details';
                    toggleButton.setAttribute('aria-expanded', expanded ? 'true' : 'false');
                };

                toggleButton.addEventListener('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    row.classList.toggle('wa-md-row-expanded');
                    syncToggleLabel();
                });

                syncToggleLabel();
                toggleCell.appendChild(toggleButton);
                row.appendChild(toggleCell);
            });
        });
    }

    function shouldSkipMentionHighlight(textNode) {
        const parent = textNode?.parentElement || null;
        if (!parent || typeof parent.closest !== 'function') {
            return true;
        }
        return Boolean(parent.closest('a, code, pre, .wa-message-mention'));
    }

    function highlightMentions(container) {
        if (
            !(container instanceof Element)
            || typeof document === 'undefined'
            || typeof document.createTreeWalker !== 'function'
        ) {
            return;
        }
        const nodeFilter = typeof NodeFilter !== 'undefined'
            ? NodeFilter
            : { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 };
        const walker = document.createTreeWalker(container, nodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                if (shouldSkipMentionHighlight(node)) {
                    return nodeFilter.FILTER_REJECT;
                }
                return findMentionRanges(node.nodeValue || '').length
                    ? nodeFilter.FILTER_ACCEPT
                    : nodeFilter.FILTER_REJECT;
            },
        });
        const nodes = [];
        while (walker.nextNode()) {
            nodes.push(walker.currentNode);
        }
        for (const node of nodes) {
            const value = node.nodeValue || '';
            const ranges = findMentionRanges(value);
            if (!ranges.length) continue;
            const fragment = document.createDocumentFragment();
            let cursor = 0;
            for (const range of ranges) {
                if (range.start > cursor) {
                    fragment.appendChild(document.createTextNode(value.slice(cursor, range.start)));
                }
                const mentionNode = document.createElement('strong');
                mentionNode.className = 'wa-message-mention';
                mentionNode.textContent = range.token;
                fragment.appendChild(mentionNode);
                cursor = range.end;
            }
            if (cursor < value.length) {
                fragment.appendChild(document.createTextNode(value.slice(cursor)));
            }
            node.parentNode?.replaceChild(fragment, node);
        }
    }

    function updatePanelIfActive(bubble, text) {
        if (sidePanel.isActive(bubble)) {
            sidePanel.updateIfActive(bubble, text);
        }
    }

    function parseSelectPaginationState(text) {
        const safeText = typeof text === 'string' ? text : '';
        const match = safeText.match(/Showing\s+(\d+)\s*-\s*(\d+)\s+of\s+(\d+)\s+(.+?)\(s\)\./i);
        if (!match) {
            return null;
        }

        const start = Number.parseInt(match[1], 10);
        const end = Number.parseInt(match[2], 10);
        const total = Number.parseInt(match[3], 10);
        const entity = (match[4] || '').trim().toLowerCase();
        if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(total) || total <= 0) {
            return null;
        }
        return {
            start,
            end,
            total,
            entity,
            hasMore: end < total,
        };
    }

    function parseConfirmationPromptState(text) {
        const safeText = typeof text === 'string' ? text : '';
        const normalized = safeText.replace(/\s+/g, ' ').trim();
        if (!normalized) {
            return null;
        }

        const confirmPattern = /(?:^|\b)(?:reply|please reply|type)\s+(?:\*\*|["'`])?yes(?:\*\*|["'`])?\s+to\s+[^.\n]{1,120}?\s+or\s+(?:\*\*|["'`])?no(?:\*\*|["'`])?\s+to\s+[^.\n]{1,120}/i;
        if (!confirmPattern.test(normalized)) {
            return null;
        }

        return {
            yesCommand: 'yes',
            noCommand: 'no',
        };
    }

    function parseAbortPromptState(text) {
        const safeText = typeof text === 'string' ? text : '';
        const normalized = safeText.replace(/\s+/g, ' ').trim();
        if (!normalized) {
            return null;
        }

        const abortPattern = /(?:^|\b)(?:type|reply with|reply)\s+(?:\*\*|["'`])?cancel(?:\*\*|["'`])?\s+to\s+(?:abort|cancel)\b/i;
        if (!abortPattern.test(normalized)) {
            return null;
        }

        return {
            cancelCommand: 'cancel',
        };
    }

    function parseShortcutCommands(text) {
        const safeText = typeof text === 'string' ? text : '';
        if (!safeText.trim()) {
            return [];
        }

        const found = [];
        const seen = new Set();
        const allowedSingleWordCommands = new Set([
            'yes',
            'no',
            'cancel',
            'confirm',
            'accept',
            'reject',
            'proceed',
            'retry',
            'help',
            'exit'
        ]);
        const addCandidate = (value) => {
            const command = String(value || '').trim().replace(/\s+/g, ' ');
            if (!command || command.length > 80 || command.includes('\n')) {
                return;
            }
            const key = command.toLowerCase();
            // Avoid noisy shortcuts from help menus (e.g. "area", "job").
            // Keep all multi-word commands and a strict allowlist for single-word commands.
            if (!command.includes(' ') && !allowedSingleWordCommands.has(key)) {
                return;
            }
            if (seen.has(key)) {
                return;
            }
            seen.add(key);
            found.push(command);
        };

        // Examples:
        // - You can say "yes" to import
        // - Type `cancel` to abort
        // - Reply with 'accept' to apply
        const quotedByCueRe = /(?:you\s+can|you\s+may|please|just)?\s*(?:say|type|reply(?:\s+with)?)\s+(?:"([^"\n]{1,80})"|'([^'\n]{1,80})'|`([^`\n]{1,80})`|\*\*([^*\n]{1,80})\*\*)/gi;
        let match = null;
        while ((match = quotedByCueRe.exec(safeText)) !== null) {
            addCandidate(match[1] || match[2] || match[3] || match[4]);
        }

        // Example:
        // - To execute the wipe, confirm by saying "yes" or "confirm".
        const cueLineRe = /(?:\bconfirm\s+by\s+(?:say|saying|type|typing|reply(?:\s+with)?)\b|\b(?:you\s+can|you\s+may|please|just)\b.*\b(?:say|saying|type|typing|reply(?:\s+with)?)\b|\b(?:say|saying|reply(?:\s+with)?|type|typing)\s+(?:"|'|`|\*\*|[a-z0-9_-]))/i;
        const quotedAnyRe = /"([^"\n]{1,80})"|'([^'\n]{1,80})'|`([^`\n]{1,80})`|\*\*([^*\n]{1,80})\*\*/g;
        const lines = safeText.split(/\r?\n/);
        for (const line of lines) {
            if (!cueLineRe.test(line)) {
                continue;
            }
            let quoted = null;
            while ((quoted = quotedAnyRe.exec(line)) !== null) {
                addCandidate(quoted[1] || quoted[2] || quoted[3] || quoted[4]);
            }
            quotedAnyRe.lastIndex = 0;
        }

        // Examples:
        // - type cancel to abort
        // - reply yes to proceed
        const simpleByCueRe = /(?:^|\b)(?:type|reply(?:\s+with)?|say)\s+([a-z0-9_-]{2,24})\s+to\b/gi;
        while ((match = simpleByCueRe.exec(safeText)) !== null) {
            addCandidate(match[1]);
        }

        // Example:
        // - confirm by saying yes or confirm
        const byCueChoiceRe = /\bby\s+(?:say|saying|type|typing|reply(?:\s+with)?)\s+([a-z0-9_-]{2,24})(?:\s+or\s+([a-z0-9_-]{2,24}))?/gi;
        while ((match = byCueChoiceRe.exec(safeText)) !== null) {
            addCandidate(match[1]);
            if (match[2]) {
                addCandidate(match[2]);
            }
        }

        return found.slice(0, 4);
    }

    function toShortcutLabel(command) {
        const value = String(command || '').trim();
        if (!value) {
            return '';
        }
        if (/^(yes|no|cancel|accept)$/i.test(value)) {
            return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
        }
        if (value.length <= 22) {
            return value;
        }
        return `${value.slice(0, 19)}...`;
    }

    function updatePaginationActions(bubble, fullText) {
        if (!bubble) {
            return;
        }
        const existing = bubble.querySelector('.wa-pagination-actions');
        if (!ENABLE_SELECT_PAGINATION_ACTIONS) {
            if (existing) {
                existing.remove();
            }
            return;
        }
        const pagination = parseSelectPaginationState(fullText);

        if (!pagination || !pagination.hasMore || typeof quickCommandHandler !== 'function') {
            if (existing) {
                existing.remove();
            }
            return;
        }

        const holder = existing || document.createElement('div');
        holder.className = 'wa-pagination-actions';
        holder.innerHTML = '';

        const createActionButton = ({ label, command, className }) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = className;
            btn.textContent = label;
            btn.addEventListener('click', () => {
                if (btn.disabled) {
                    return;
                }
                btn.disabled = true;
                btn.setAttribute('aria-busy', 'true');
                try {
                    const accepted = quickCommandHandler(command);
                    if (accepted !== false) {
                        holder.remove();
                    } else {
                        btn.disabled = false;
                        btn.removeAttribute('aria-busy');
                    }
                } catch (_) {
                    btn.disabled = false;
                    btn.removeAttribute('aria-busy');
                }
            });
            return btn;
        };

        const nextCommand = pagination.entity ? `next ${pagination.entity}` : 'next';
        const showAllCommand = pagination.entity ? `show all ${pagination.entity}` : 'show all';

        holder.appendChild(createActionButton({
            label: `Show more (${pagination.end}/${pagination.total})`,
            command: nextCommand,
            className: 'wa-pagination-more-btn',
        }));
        holder.appendChild(createActionButton({
            label: 'Show all',
            command: showAllCommand,
            className: 'wa-pagination-all-btn',
        }));
        const timeNode = bubble.querySelector('.wa-message-time');
        if (!existing) {
            if (timeNode) {
                bubble.insertBefore(holder, timeNode);
            } else {
                bubble.appendChild(holder);
            }
        }
    }

    function updateConfirmationActions(bubble, fullText) {
        if (!bubble) {
            return;
        }
        const existing = bubble.querySelector('.wa-confirm-actions');
        const messageNode = bubble.closest('.wa-message');
        const isIncoming = Boolean(messageNode?.classList?.contains('in'));
        const confirmation = parseConfirmationPromptState(fullText);

        if (!isIncoming || !confirmation || typeof quickCommandHandler !== 'function') {
            if (existing) {
                existing.remove();
            }
            return;
        }

        const holder = existing || document.createElement('div');
        holder.className = 'wa-confirm-actions';
        holder.innerHTML = '';

        const setButtonsEnabled = (enabled) => {
            const buttons = holder.querySelectorAll('button');
            buttons.forEach((button) => {
                button.disabled = !enabled;
                if (enabled) {
                    button.removeAttribute('aria-busy');
                }
            });
        };

        const createActionButton = ({ label, command, className }) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = className;
            button.textContent = label;
            button.addEventListener('click', () => {
                if (button.disabled) {
                    return;
                }
                setButtonsEnabled(false);
                button.setAttribute('aria-busy', 'true');
                try {
                    const accepted = quickCommandHandler(command);
                    if (accepted !== false) {
                        holder.remove();
                    } else {
                        setButtonsEnabled(true);
                    }
                } catch (_) {
                    setButtonsEnabled(true);
                }
            });
            return button;
        };

        holder.appendChild(createActionButton({
            label: 'Yes',
            command: confirmation.yesCommand,
            className: 'wa-confirm-yes-btn',
        }));
        holder.appendChild(createActionButton({
            label: 'No',
            command: confirmation.noCommand,
            className: 'wa-confirm-no-btn',
        }));

        if (!existing) {
            const timeNode = bubble.querySelector('.wa-message-time');
            if (timeNode) {
                bubble.insertBefore(holder, timeNode);
            } else {
                bubble.appendChild(holder);
            }
        }
    }

    function updateAbortActions(bubble, fullText) {
        if (!bubble) {
            return;
        }
        const existing = bubble.querySelector('.wa-abort-actions');
        const messageNode = bubble.closest('.wa-message');
        const isIncoming = Boolean(messageNode?.classList?.contains('in'));
        const abortState = parseAbortPromptState(fullText);

        if (!isIncoming || !abortState || typeof quickCommandHandler !== 'function') {
            if (existing) {
                existing.remove();
            }
            return;
        }

        const holder = existing || document.createElement('div');
        holder.className = 'wa-abort-actions';
        holder.innerHTML = '';

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'wa-abort-cancel-btn';
        button.textContent = 'Cancel';
        button.addEventListener('click', () => {
            if (button.disabled) {
                return;
            }
            button.disabled = true;
            button.setAttribute('aria-busy', 'true');
            try {
                const accepted = quickCommandHandler(abortState.cancelCommand);
                if (accepted !== false) {
                    holder.remove();
                } else {
                    button.disabled = false;
                    button.removeAttribute('aria-busy');
                }
            } catch (_) {
                button.disabled = false;
                button.removeAttribute('aria-busy');
            }
        });
        holder.appendChild(button);

        if (!existing) {
            const timeNode = bubble.querySelector('.wa-message-time');
            if (timeNode) {
                bubble.insertBefore(holder, timeNode);
            } else {
                bubble.appendChild(holder);
            }
        }
    }

    function updateShortcutActions(bubble, fullText) {
        if (!bubble) {
            return;
        }
        const existing = bubble.querySelector('.wa-shortcut-actions');
        const messageNode = bubble.closest('.wa-message');
        const isIncoming = Boolean(messageNode?.classList?.contains('in'));
        const hasConfirmationActions = Boolean(parseConfirmationPromptState(fullText));
        const hasAbortActions = Boolean(parseAbortPromptState(fullText));
        const shortcuts = parseShortcutCommands(fullText);

        if (!isIncoming || typeof quickCommandHandler !== 'function' || hasConfirmationActions || hasAbortActions || !shortcuts.length) {
            if (existing) {
                existing.remove();
            }
            return;
        }

        const holder = existing || document.createElement('div');
        holder.className = 'wa-shortcut-actions';
        holder.innerHTML = '';

        const setButtonsEnabled = (enabled) => {
            const buttons = holder.querySelectorAll('button');
            buttons.forEach((button) => {
                button.disabled = !enabled;
                if (enabled) {
                    button.removeAttribute('aria-busy');
                }
            });
        };

        const createShortcutButton = (command) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'wa-shortcut-btn';
            button.textContent = toShortcutLabel(command);
            button.title = command;
            button.addEventListener('click', () => {
                if (button.disabled) {
                    return;
                }
                setButtonsEnabled(false);
                button.setAttribute('aria-busy', 'true');
                try {
                    const accepted = quickCommandHandler(command);
                    if (accepted !== false) {
                        holder.remove();
                    } else {
                        setButtonsEnabled(true);
                    }
                } catch (_) {
                    setButtonsEnabled(true);
                }
            });
            return button;
        };

        shortcuts.forEach((command) => {
            holder.appendChild(createShortcutButton(command));
        });

        if (!existing) {
            const timeNode = bubble.querySelector('.wa-message-time');
            if (timeNode) {
                bubble.insertBefore(holder, timeNode);
            } else {
                bubble.appendChild(holder);
            }
        }
    }

    function updateBubbleContent(bubble, fullText) {
        const safeText = typeof fullText === 'string' ? fullText : '';
        bubble.dataset.fullText = safeText;

        const lines = safeText.split('\n');
        const limit = Math.max(1, viewMoreLineLimit);
        const shouldCollapse = lines.length > limit;
        const displayText = shouldCollapse ? lines.slice(0, limit).join('\n') : safeText;

        const textContainer = bubble.querySelector('.wa-message-text');
        const moreNode = bubble.querySelector('.wa-message-more');
        if (textContainer) {
            textContainer.innerHTML = renderMarkdown(displayText);
            if (bubble.closest('.wa-message.out')) {
                highlightMentions(textContainer);
            }
            enhanceMarkdownTables(textContainer);
            sidePanel.bindLinkDelegation(textContainer);
        }

        if (shouldCollapse) {
            if (!moreNode) {
                const viewMore = document.createElement('div');
                viewMore.className = 'wa-message-more';
                viewMore.textContent = 'View more';
                viewMore.onclick = () => sidePanel.openText(bubble, safeText);
                bubble.appendChild(viewMore);
            } else {
                moreNode.onclick = () => sidePanel.openText(bubble, safeText);
            }
            updatePanelIfActive(bubble, safeText);
        } else if (moreNode) {
            moreNode.remove();
            if (sidePanel.isActive(bubble)) {
                sidePanel.close();
            }
        } else if (sidePanel.isActive(bubble)) {
            sidePanel.close();
        }

        updatePaginationActions(bubble, safeText);
        updateConfirmationActions(bubble, safeText);
        updateAbortActions(bubble, safeText);
        updateShortcutActions(bubble, safeText);
    }

    function attachProgressPanel(bubble, progressItems) {
        if (!bubble || !Array.isArray(progressItems) || !progressItems.length) {
            return;
        }
        let panel = bubble.querySelector(':scope > .wa-progress-panel');
        if (!panel) {
            panel = document.createElement('div');
            panel.className = 'wa-progress-panel is-collapsed';
            const textContainer = bubble.querySelector('.wa-message-text');
            if (textContainer) {
                bubble.insertBefore(panel, textContainer);
            } else {
                bubble.prepend(panel);
            }
        }

        panel.replaceChildren();
        panel.classList.add('is-collapsed');

        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'wa-progress-toggle';
        toggle.setAttribute('aria-expanded', 'false');

        const arrow = document.createElement('span');
        arrow.className = 'wa-progress-arrow';
        arrow.textContent = '▸';

        const title = document.createElement('span');
        title.className = 'wa-progress-title';
        title.textContent = `${progressItems.length} step${progressItems.length === 1 ? '' : 's'}`;

        toggle.appendChild(arrow);
        toggle.appendChild(title);

        const list = document.createElement('div');
        list.className = 'wa-progress-list';

        progressItems.forEach((item) => {
            const line = document.createElement('div');
            line.className = 'wa-progress-line';
            line.textContent = item.reason;
            list.appendChild(line);
        });

        toggle.onclick = () => {
            const expanded = panel.classList.toggle('is-expanded');
            panel.classList.toggle('is-collapsed', !expanded);
            toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
            arrow.textContent = expanded ? '▾' : '▸';
        };

        panel.appendChild(toggle);
        panel.appendChild(list);
    }

    function attachTaskPanel(bubble, taskId) {
        if (!bubble || !taskId || !taskController) return;
        const existing = bubble.querySelector(':scope > .wa-inline-task');
        if (existing?.dataset.taskId === taskId) return;
        taskPanelCleanups.get(bubble)?.();
        existing?.remove();
        const dispose = attachInlineTaskPanel({ bubble, taskId, taskController });
        taskPanelCleanups.set(bubble, () => {
            dispose();
            taskPanelCleanups.delete(bubble);
        });
    }

    function associateTask(payload) {
        const taskId = payload?.task?.id;
        const messageIndex = Number.isInteger(payload?.messageIndex) ? payload.messageIndex : null;
        if (!taskId || !Number.isInteger(messageIndex)) return;
        addTaskItem(taskId, { messageIndex });
    }

    function addTaskItem(taskId, options = {}) {
        const normalizedTaskId = String(taskId || '').trim();
        if (!normalizedTaskId || taskItems.has(normalizedTaskId)) return false;
        const wrapper = document.createElement('div');
        wrapper.className = 'wa-message in wa-task-item';
        wrapper.dataset.taskId = normalizedTaskId;
        const bubble = document.createElement('div');
        bubble.className = 'wa-message-bubble';
        wrapper.appendChild(bubble);
        attachTaskPanel(bubble, normalizedTaskId);
        taskItems.set(normalizedTaskId, wrapper);
        appendMessageEl(wrapper, Number.isInteger(options.messageIndex) ? options.messageIndex : null);
        scrollToBottomIfLocked();
        return true;
    }

    function applyViewMoreSettingToAllBubbles() {
        if (!chatList) {
            return;
        }
        const bubbles = chatList.querySelectorAll('.wa-message-bubble');
        bubbles.forEach((bubble) => {
            const text = bubble.dataset?.fullText;
            if (typeof text === 'string') {
                updateBubbleContent(bubble, text);
            }
        });
    }

    function addClientMsg(text, options = {}) {
        const wrapper = document.createElement('div');
        wrapper.className = 'wa-message out';
        wrapper.innerHTML = `
            <div class="wa-message-bubble">
                <div class="wa-message-text"></div>
                <span class="wa-message-time">
                    ${formatTime(options.timestamp)}
                    <svg class="wa-seen-icon" width="10" height="9" viewBox="5.75 -1.55 9.75 9" fill="currentColor"><path d="M11.071.653a.5.5 0 0 0-.707.707l3.289 3.289a.5.5 0 0 0 .707 0L15.354 3.656a.5.5 0 0 0-.707-.707L14 3.596 11.071.653zm-4.207 0a.5.5 0 0 0-.707.707l3.289 3.289a.5.5 0 0 0 .707 0l.994-.993a.5.5 0 0 0-.707-.707L9.793 3.596 6.864.653z"/></svg>
                </span>
            </div>`;
        const textDiv = wrapper.querySelector('.wa-message-text');
        const bubble = wrapper.querySelector('.wa-message-bubble');
        if (textDiv) {
            textDiv.innerHTML = renderMarkdown(text);
            highlightMentions(textDiv);
            enhanceMarkdownTables(textDiv);
            sidePanel.bindLinkDelegation(textDiv);
        }
        if (bubble) {
            bubble.dataset.fullText = text;
        }
        appendMessageEl(wrapper, Number.isInteger(options.messageIndex) ? options.messageIndex : null);
        scrollToBottomIfLocked();
        lastServerMsg.bubble = null;
    }

    function addClientAttachment({
        fileName,
        size,
        mime,
        previewUrl,
        isImage,
        caption
    }) {
        const displayName = fileName || 'Attachment';
        const wrapper = document.createElement('div');
        wrapper.className = 'wa-message out wa-message-attachment';
        wrapper.dataset.attachmentName = displayName;
        if (mime) {
            wrapper.dataset.attachmentMime = mime;
        }
        if (typeof size === 'number' && Number.isFinite(size)) {
            wrapper.dataset.attachmentSize = String(size);
        }
        if (previewUrl) {
            wrapper.dataset.attachmentPreviewUrl = previewUrl;
        }
        if (caption) {
            wrapper.dataset.attachmentCaption = caption;
        }
        wrapper.dataset.attachmentStatus = 'uploading';

        const bubble = document.createElement('div');
        bubble.className = 'wa-message-bubble';
        bubble.dataset.fullText = caption || displayName || '';

        const content = document.createElement('div');
        content.className = 'wa-attachment-message';

        const thumb = document.createElement('div');
        thumb.className = 'wa-file-preview-thumbnail';
        let thumbImage = null;
        if (isImage && previewUrl) {
            thumbImage = document.createElement('img');
            thumbImage.src = previewUrl;
            thumbImage.alt = displayName;
            thumb.appendChild(thumbImage);
        } else {
            thumb.innerHTML = getFileIcon(displayName);
        }

        const info = document.createElement('div');
        info.className = 'wa-file-preview-info';

        let nameNode = document.createElement('span');
        nameNode.className = 'wa-file-preview-name';
        nameNode.textContent = displayName;

        const sizeNode = document.createElement('div');
        sizeNode.className = 'wa-file-preview-size';
        if (typeof size === 'number' && Number.isFinite(size)) {
            const parts = [formatBytes(size)];
            if (mime) {
                parts.push(mime);
            }
            sizeNode.textContent = parts.join(' · ');
        } else if (mime) {
            sizeNode.textContent = mime;
        } else {
            sizeNode.textContent = '';
        }

        const statusNode = document.createElement('div');
        statusNode.className = 'wa-file-preview-status';
        statusNode.textContent = 'Uploading…';

        info.appendChild(nameNode);
        info.appendChild(sizeNode);
        info.appendChild(statusNode);

        content.appendChild(thumb);
        content.appendChild(info);
        bubble.appendChild(content);

        if (caption) {
            const captionNode = document.createElement('div');
            captionNode.className = 'wa-attachment-caption';
            captionNode.innerHTML = renderMarkdown(caption);
            highlightMentions(captionNode);
            enhanceMarkdownTables(captionNode);
            sidePanel.bindLinkDelegation(captionNode);
            bubble.appendChild(captionNode);
        }

        const timeNode = document.createElement('span');
        timeNode.className = 'wa-message-time';
        timeNode.innerHTML = `
            ${formatTime()}
            <svg class="wa-seen-icon" width="10" height="9" viewBox="5.75 -1.55 9.75 9" fill="currentColor"><path d="M11.071.653a.5.5 0 0 0-.707.707l3.289 3.289a.5.5 0 0 0 .707 0L15.354 3.656a.5.5 0 0 0-.707-.707L14 3.596 11.071.653zm-4.207 0a.5.5 0 0 0-.707.707l3.289 3.289a.5.5 0 0 0 .707 0l.994-.993a.5.5 0 0 0-.707-.707L9.793 3.596 6.864.653z"/></svg>
        `;
        bubble.appendChild(timeNode);

        wrapper.appendChild(bubble);
        sidePanel.bindLinkDelegation(bubble);
        appendMessageEl(wrapper);
        scrollToBottomIfLocked();
        lastServerMsg.bubble = null;

        function ensureLinkNode(downloadUrl) {
            if (!downloadUrl) {
                return;
            }
            if (nameNode.tagName.toLowerCase() !== 'a') {
                const link = document.createElement('a');
                link.className = 'wa-file-preview-name';
                link.textContent = nameNode.textContent || displayName;
                nameNode.replaceWith(link);
                nameNode = link;
            }
            nameNode.href = downloadUrl;
            nameNode.target = '_blank';
            nameNode.rel = 'noopener noreferrer';
        }

        return {
            markUploaded({
                downloadUrl,
                size: uploadedSize,
                mime: uploadedMime,
                localPath,
                id
            }) {
                if (downloadUrl) {
                    wrapper.dataset.attachmentDownloadUrl = downloadUrl;
                }
                if (localPath) {
                    wrapper.dataset.attachmentLocalPath = localPath;
                }
                if (id) {
                    wrapper.dataset.attachmentId = id;
                }
                if (uploadedMime) {
                    wrapper.dataset.attachmentMime = uploadedMime;
                }
                wrapper.dataset.attachmentStatus = 'uploaded';
                if (typeof uploadedSize === 'number' && Number.isFinite(uploadedSize)) {
                    wrapper.dataset.attachmentSize = String(uploadedSize);
                    const parts = [formatBytes(uploadedSize)];
                    const mimeLabel = uploadedMime || mime;
                    if (mimeLabel) {
                        parts.push(mimeLabel);
                    }
                    sizeNode.textContent = parts.join(' · ');
                }
                ensureLinkNode(downloadUrl);
                statusNode.classList.remove('error');
                statusNode.textContent = '';
                if (downloadUrl) {
                    statusNode.textContent = 'Link: ';
                    const link = document.createElement('a');
                    link.className = 'wa-attachment-link';
                    link.href = downloadUrl;
                    link.target = '_blank';
                    link.rel = 'noopener noreferrer';
                    link.textContent = downloadUrl;
                    statusNode.appendChild(link);
                } else {
                    statusNode.textContent = 'Uploaded';
                }
            },
            replacePreview(nextUrl) {
                if (!nextUrl) {
                    return;
                }
                if (thumbImage) {
                    thumbImage.src = nextUrl;
                }
                wrapper.dataset.attachmentPreviewUrl = nextUrl;
            },
            markFailed(message) {
                wrapper.dataset.attachmentStatus = 'error';
                statusNode.classList.add('error');
                statusNode.textContent = message || 'Upload failed';
            }
        };
    }

    function addServerMsg(text, options = {}) {
        let normalized = typeof text === 'string' ? text : '';
        const explicitProgressItems = Array.isArray(options.progressItems)
            ? options.progressItems.map(normalizeProgressItem).filter(Boolean)
            : null;
        const progressItems = explicitProgressItems || pendingProgressItems;

        // Filter out raw envelope JSON to prevent it from appearing in chat
        const trimmedNormalized = normalized.trim();
        // Envelopes can start with various characters depending on how they're echoed
        if (trimmedNormalized.includes('"__webchatMessage"') &&
            trimmedNormalized.includes('"version"') &&
            trimmedNormalized.includes('"text"') &&
            trimmedNormalized.includes('"attachments"')) {
            // This looks like a raw envelope echo - skip it
            return false;
        }

        const messageIndex = Number.isInteger(options.messageIndex) ? options.messageIndex : null;
        if (!normalized.trim() && progressItems.length === 0) {
            lastServerMsg.bubble = null;
            lastServerMsg.fullText = '';
            userInputSent = false;
            return false;
        }

        const previousFullText = typeof lastServerMsg.fullText === 'string' ? lastServerMsg.fullText : '';
        const appendToExisting = !options.forceNew && !userInputSent && lastServerMsg.bubble;

        if (appendToExisting) {
            const combined = previousFullText ? `${previousFullText}\n${normalized}` : normalized;
            lastServerMsg.fullText = combined;
            updateBubbleContent(lastServerMsg.bubble, combined);
            if (progressItems.length) {
                attachProgressPanel(lastServerMsg.bubble, progressItems);
            }
            if (explicitProgressItems === null && pendingProgressItems.length) {
                resetProgressEvents();
            }
        } else {
            const wrapper = document.createElement('div');
            wrapper.className = 'wa-message in';
            const bubble = document.createElement('div');
            bubble.className = 'wa-message-bubble';
            bubble.innerHTML = '<div class="wa-message-text"></div><span class="wa-message-time"></span>';
            wrapper.appendChild(bubble);

            lastServerMsg.bubble = bubble;
            lastServerMsg.fullText = normalized;
            userInputSent = false;

            updateBubbleContent(bubble, normalized);
            if (progressItems.length) {
                attachProgressPanel(bubble, progressItems);
            }
            if (explicitProgressItems === null && pendingProgressItems.length) {
                resetProgressEvents();
            }
            const timeNode = bubble.querySelector('.wa-message-time');
            if (timeNode) {
                timeNode.textContent = formatTime(options.timestamp);
            }
            appendMessageEl(wrapper, messageIndex);
        }

        scrollToBottomIfLocked();
        return true;
    }

    function formatStoredMessageText(message) {
        const parts = [typeof message?.text === 'string' ? message.text : ''];
        if (Array.isArray(message?.attachments)) {
            for (const attachment of message.attachments) {
                const label = attachment?.filename || attachment?.relativePath || attachment?.localPath || 'Attachment';
                const url = attachment?.downloadUrl;
                parts.push(url ? `[${label}](${url})` : `[Attachment: ${label}]`);
            }
        }
        return parts.filter(Boolean).join('\n\n');
    }

    function clearMessages() {
        if (!chatList) return;
        const children = Array.from(chatList.children);
        for (const child of children) {
            if (child !== typingIndicator && child !== historyGate) {
                const bubble = child.querySelector?.('.wa-message-bubble');
                if (bubble) taskPanelCleanups.get(bubble)?.();
                child.remove();
            }
        }
        taskItems.clear();
        lastServerMsg.bubble = null;
        lastServerMsg.fullText = '';
        userInputSent = false;
        resetProgressEvents();
        hideTypingIndicator(true);
    }

    function renderHistory(historyMessages = []) {
        clearMessages();
        const messages = Array.isArray(historyMessages) ? historyMessages : [];
        for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
            const message = messages[messageIndex];
            if (message?.type === 'task') {
                addTaskItem(message.taskId, { messageIndex });
                continue;
            }
            const text = formatStoredMessageText(message);
            if (message?.role === 'user') {
                addClientMsg(text, { historical: true, timestamp: message.timestamp, messageIndex });
            } else if (message?.role === 'assistant') {
                addServerMsg(text, {
                    forceNew: true,
                    timestamp: message.timestamp,
                    progressItems: Array.isArray(message.progress) ? message.progress : [],
                    messageIndex,
                });
            }
        }
        userInputSent = false;
    }

    return {
        addClientMsg,
        addClientAttachment,
        addServerMsg,
        clearMessages,
        renderHistory,
        associateTask,
        addProgressEvent,
        showTypingIndicator,
        hideTypingIndicator,
        applyViewMoreSettingToAllBubbles,
        setViewMoreLineLimit: (limit) => {
            const next = Math.max(1, Number(limit) || 1);
            if (next === viewMoreLineLimit) {
                return;
            }
            viewMoreLineLimit = next;
            applyViewMoreSettingToAllBubbles();
        },
        markUserInputSent: () => {
            userInputSent = true;
            resetProgressEvents();
        },
        setQuickCommandHandler: (fn) => {
            quickCommandHandler = typeof fn === 'function' ? fn : null;
            applyViewMoreSettingToAllBubbles();
        },
        setTypingStateHandler: (fn) => {
            typingStateHandler = typeof fn === 'function' ? fn : null;
        }
    };
}
