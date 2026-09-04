const MIN_TEXTAREA_HEIGHT_PX = 22;
const MAX_TEXTAREA_HEIGHT_PX = 132;
const COMPOSER_BOTTOM_CLEARANCE_PX = 18;
const INITIAL_FOCUS_DELAY_MS = 120;

export function createComposer({ cmdInput, sendBtn, cancelBtn }, { purgeTriggerRe, onAvailabilityChange }) {
    let onSend = null;
    let onCancel = null;
    let isProcessing = false;
    let isInteractionActive = false;
    let isReady = false;
    let isSubmitting = false;
    let draftRevision = 0;
    const composerEl = cmdInput?.closest?.('.wa-composer') || null;
    const composerMainEl = cmdInput?.closest?.('.wa-composer-main') || null;
    let composerResizeObserver = null;
    const canSubmit = () => isReady && !isInteractionActive && !isSubmitting;

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

    function purge() {
        clear();
    }

    async function submit() {
        if (!cmdInput || !canSubmit()) {
            return false;
        }
        const value = cmdInput.value;
        if (purgeTriggerRe.test(value)) {
            purge();
            return false;
        }

        const revision = draftRevision;
        const isCurrentDraft = () => draftRevision === revision && cmdInput.value === value;
        isSubmitting = true;
        updateAvailability();
        try {
            const result = typeof onSend === 'function'
                ? await onSend(value, { isCurrentDraft })
                : false;
            if (result === true) {
                if (isCurrentDraft()) clear();
                return true;
            }
            return false;
        } catch (_) {
            // The transport owns the error feedback. Keep the unaccepted draft.
            return false;
        } finally {
            isSubmitting = false;
            updateAvailability();
            focusAfterAction();
        }
    }

    function typeFromKeyEvent(event) {
        if (!cmdInput || !event || !isReady || isInteractionActive || isSubmitting) {
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
            draftRevision += 1;
            autoResize();
            if (purgeTriggerRe.test(cmdInput.value)) {
                purge();
            }
        });
        cmdInput.addEventListener('keydown', (event) => {
            if (event.defaultPrevented || !canSubmit()) {
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

    function updateAvailability() {
        const available = isReady && !isInteractionActive && !isSubmitting;
        if (cmdInput) cmdInput.disabled = !available;
        if (cancelBtn) {
            const visible = isReady && isProcessing;
            cancelBtn.style.display = visible ? 'flex' : 'none';
            cancelBtn.toggleAttribute('hidden', !visible);
            cancelBtn.setAttribute('aria-hidden', visible ? 'false' : 'true');
        }
        if (sendBtn) {
            const hidden = isProcessing || isInteractionActive;
            sendBtn.disabled = !available;
            sendBtn.style.display = hidden ? 'none' : 'flex';
            sendBtn.toggleAttribute('hidden', hidden);
            sendBtn.setAttribute('aria-hidden', hidden ? 'true' : 'false');
        }
        if (typeof onAvailabilityChange === 'function') onAvailabilityChange(available);
    }

    function setProcessingState(processing) {
        isProcessing = Boolean(processing);
        updateAvailability();
    }

    function setReadyState(ready) {
        isReady = ready === true;
        updateAvailability();
    }

    function setInteractionState(active) {
        isInteractionActive = Boolean(active);
        updateAvailability();
    }

    updateAvailability();

    return {
        submit,
        canSubmit,
        clear,
        purge,
        setValue,
        getValue,
        autoResize,
        typeFromKeyEvent,
        focus: focusInput,
        setProcessingState,
        setInteractionState,
        setReadyState,
        setSendHandler: (handler) => {
            onSend = typeof handler === 'function' ? handler : null;
        },
        setCancelHandler: (handler) => {
            onCancel = typeof handler === 'function' ? handler : null;
        }
    };
}
