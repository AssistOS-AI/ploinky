const MIN_TEXTAREA_HEIGHT_PX = 22;
const MAX_TEXTAREA_HEIGHT_PX = 132;
const COMPOSER_BOTTOM_CLEARANCE_PX = 18;
const INITIAL_FOCUS_DELAY_MS = 120;

export function createComposer({ cmdInput, sendBtn, cancelBtn }, { purgeTriggerRe }) {
    let onSend = null;
    let onPurge = null;
    let onCancel = null;
    let isProcessing = false;
    const composerEl = cmdInput?.closest?.('.wa-composer') || null;
    const composerMainEl = cmdInput?.closest?.('.wa-composer-main') || null;
    let composerResizeObserver = null;

    function updateComposerSpace() {
        if (!composerEl) {
            return;
        }
        try {
            const nextSpace = Math.ceil(composerEl.offsetHeight + COMPOSER_BOTTOM_CLEARANCE_PX);
            document.documentElement.style.setProperty('--wa-floating-composer-space', `${nextSpace}px`);
        } catch (_) {
            // ignore
        }
    }

    function focusAfterAction() {
        if (!cmdInput) {
            return;
        }
        setTimeout(() => {
            focusInput();
        }, 0);
    }

    function focusInput(options = {}) {
        if (!cmdInput) {
            return;
        }
        const { preserveSelection = false } = options;
        if (document.activeElement !== cmdInput) {
            try {
                cmdInput.focus({ preventScroll: true });
            } catch (_) {
                cmdInput.focus();
            }
        }
        if (preserveSelection) {
            return;
        }
        const pos = cmdInput.value.length;
        try {
            cmdInput.setSelectionRange(pos, pos);
        } catch (_) {
            // Ignore selection issues
        }
    }

    function emitInputChange() {
        if (!cmdInput) {
            return;
        }
        try {
            cmdInput.dispatchEvent(new Event('input', { bubbles: true }));
        } catch (_) {
            // Ignore event dispatch failures
        }
    }

    function autoResize() {
        if (!cmdInput) {
            return;
        }
        try {
            cmdInput.style.height = 'auto';
            const scrollHeight = Math.ceil(cmdInput.scrollHeight);
            const next = Math.min(MAX_TEXTAREA_HEIGHT_PX, Math.max(MIN_TEXTAREA_HEIGHT_PX, scrollHeight));
            cmdInput.style.height = `${next}px`;
            cmdInput.style.overflowY = scrollHeight > MAX_TEXTAREA_HEIGHT_PX ? 'auto' : 'hidden';
            if (composerMainEl) {
                composerMainEl.classList.toggle('is-expanded', next > MIN_TEXTAREA_HEIGHT_PX + 8);
            }
            if (scrollHeight <= MAX_TEXTAREA_HEIGHT_PX) {
                cmdInput.scrollTop = 0;
            }
            window.requestAnimationFrame(updateComposerSpace);
        } catch (_) {
            // ignore
        }
    }

    function insertTextAtCursor(text) {
        if (!cmdInput || !text) {
            return false;
        }
        let selStart = cmdInput.value.length;
        let selEnd = selStart;
        try {
            if (typeof cmdInput.selectionStart === 'number') {
                selStart = cmdInput.selectionStart;
            }
            if (typeof cmdInput.selectionEnd === 'number') {
                selEnd = cmdInput.selectionEnd;
            }
        } catch (_) {
            // Ignore selection access issues
        }
        const before = cmdInput.value.slice(0, selStart);
        const after = cmdInput.value.slice(selEnd);
        cmdInput.value = `${before}${text}${after}`;
        const nextPos = selStart + text.length;
        try {
            cmdInput.setSelectionRange(nextPos, nextPos);
        } catch (_) {
            // Ignore selection issues
        }
        emitInputChange();
        return true;
    }

    function clear() {
        if (!cmdInput) {
            return;
        }
        cmdInput.value = '';
        try {
            cmdInput.setSelectionRange(0, 0);
        } catch (_) {
            // Ignore selection issues
        }
        emitInputChange();
        focusAfterAction();
    }

    function purge(options = {}) {
        const { resetVoice = false } = options;
        clear();
        if (typeof onPurge === 'function') {
            onPurge({ resetVoice });
        }
    }

    function submit() {
        if (!cmdInput) {
            return false;
        }
        const value = cmdInput.value;
        if (purgeTriggerRe.test(value)) {
            purge();
            return false;
        }

        const result = typeof onSend === 'function' ? onSend(value) : true;

        if (result !== false) {
            clear();
            return true;
        }
        focusAfterAction();
        return false;
    }

    function appendVoiceText(addition) {
        if (!cmdInput || !addition) {
            return;
        }
        const current = cmdInput.value;
        let insert = addition;
        const additionHasLeadingSpace = /^\s/.test(insert);
        const additionStartsPunct = /^[.,!?;:]/.test(insert);
        if (!additionHasLeadingSpace && current && !/\s$/.test(current) && !additionStartsPunct) {
            insert = ` ${insert}`;
        }
        const selStart = cmdInput.selectionStart;
        const selEnd = cmdInput.selectionEnd;
        const hadFocus = document.activeElement === cmdInput;
        const prevScroll = cmdInput.scrollTop;
        cmdInput.value = current + insert;
        if (hadFocus) {
            if (selStart !== current.length || selEnd !== current.length) {
                cmdInput.setSelectionRange(selStart, selEnd);
            } else {
                const pos = cmdInput.value.length;
                cmdInput.setSelectionRange(pos, pos);
            }
        }
        cmdInput.scrollTop = prevScroll;
        emitInputChange();
        if (purgeTriggerRe.test(cmdInput.value)) {
            purge({ resetVoice: true });
        }
    }

    function typeFromKeyEvent(event) {
        if (!cmdInput || !event) {
            return false;
        }
        if (event.metaKey || event.ctrlKey || event.altKey) {
            return false;
        }
        const key = event.key;
        if (!key || key.length !== 1) {
            return false;
        }
        focusInput({ preserveSelection: true });
        const inserted = insertTextAtCursor(key);
        if (inserted && purgeTriggerRe.test(cmdInput.value)) {
            purge();
        }
        return inserted;
    }

    function setValue(value) {
        if (!cmdInput) {
            return;
        }
        cmdInput.value = value;
        try {
            const pos = cmdInput.value.length;
            cmdInput.setSelectionRange(pos, pos);
        } catch (_) {
            // Ignore selection issues
        }
        emitInputChange();
    }

    const getValue = () => (cmdInput ? cmdInput.value : '');

    if (cmdInput) {
        setTimeout(autoResize, 0);
        updateComposerSpace();
        const scheduleInitialFocus = () => {
            setTimeout(() => {
                focusInput();
            }, INITIAL_FOCUS_DELAY_MS);
        };
        scheduleInitialFocus();
        window.addEventListener('pageshow', scheduleInitialFocus);
        window.addEventListener('resize', updateComposerSpace);
        if (typeof ResizeObserver === 'function' && composerEl) {
            composerResizeObserver = new ResizeObserver(updateComposerSpace);
            composerResizeObserver.observe(composerEl);
        }
        cmdInput.addEventListener('input', () => {
            autoResize();
            if (purgeTriggerRe.test(cmdInput.value)) {
                purge();
            }
        });
        cmdInput.addEventListener('keydown', (event) => {
            if (event.defaultPrevented) {
                return;
            }
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                insertTextAtCursor('\n');
                return;
            }
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit();
            }
        });
    }

    if (sendBtn) {
        sendBtn.onclick = () => submit();
    }

    if (cancelBtn) {
        cancelBtn.onclick = () => {
            if (typeof onCancel === 'function') {
                onCancel();
            }
        };
    }

    function setProcessingState(processing) {
        isProcessing = processing;
        if (cancelBtn) {
            cancelBtn.style.display = processing ? 'flex' : 'none';
            cancelBtn.toggleAttribute('hidden', !processing);
            cancelBtn.setAttribute('aria-hidden', processing ? 'false' : 'true');
        }
        if (sendBtn) {
            sendBtn.style.display = processing ? 'none' : 'flex';
            sendBtn.toggleAttribute('hidden', processing);
            sendBtn.setAttribute('aria-hidden', processing ? 'true' : 'false');
        }
    }

    return {
        submit,
        clear,
        purge,
        appendVoiceText,
        setValue,
        getValue,
        autoResize,
        typeFromKeyEvent,
        focus: focusInput,
        setProcessingState,
        setSendHandler: (handler) => {
            onSend = typeof handler === 'function' ? handler : null;
        },
        setPurgeHandler: (handler) => {
            onPurge = typeof handler === 'function' ? handler : null;
        },
        setCancelHandler: (handler) => {
            onCancel = typeof handler === 'function' ? handler : null;
        }
    };
}
