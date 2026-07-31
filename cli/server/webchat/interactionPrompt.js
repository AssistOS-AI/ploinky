export function nextInteractionOptionIndex(currentIndex, optionCount, direction) {
    const count = Math.max(0, Number(optionCount) || 0);
    if (count === 0) return -1;
    const current = Math.max(0, Math.min(Number(currentIndex) || 0, count - 1));
    if (direction > 0) return (current + 1) % count;
    if (direction < 0) return (current - 1 + count) % count;
    return current;
}

export function createInteractionPrompt({ root, title, message, detail, inputRow, input, submitButton, cancelButton, options }, {
    onSubmit,
    onCancel,
    onActiveChange,
} = {}) {
    let interaction = null;
    let selectedIndex = 0;
    let submitting = false;
    let visibleOptions = [];

    function renderDetail() {
        if (!detail || !interaction) return;
        const challenge = interaction.challenge;
        const challengeUrl = challenge?.type === 'device_code'
            ? challenge.verificationUri
            : challenge?.url;
        detail.replaceChildren?.();
        if (challengeUrl) {
            const link = document.createElement('a');
            link.href = challengeUrl;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = challengeUrl;
            detail.appendChild(link);
            const instructions = String(challenge.instructions || '').trim();
            if (instructions) {
                const text = document.createElement('span');
                text.textContent = instructions;
                detail.appendChild(text);
            }
        } else {
            detail.textContent = interaction.detail || '';
        }
        detail.hidden = !challengeUrl && !interaction.detail;
    }

    function notifyActive(active) {
        if (typeof onActiveChange === 'function') onActiveChange(active);
    }

    function renderOptions() {
        if (!options || !interaction) return;
        if (input) input.disabled = submitting;
        if (submitButton) submitButton.disabled = submitting;
        if (cancelButton) cancelButton.disabled = submitting;
        options.replaceChildren();
        const query = interaction.searchable ? String(input?.value || '').trim().toLowerCase() : '';
        visibleOptions = interaction.options.filter((option) => !query
            || [option.label, option.description].some((value) => String(value || '').toLowerCase().includes(query)));
        if (selectedIndex >= visibleOptions.length) selectedIndex = Math.max(0, visibleOptions.length - 1);
        visibleOptions.forEach((option, index) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.id = `interaction-option-${interaction.id}-${index}`;
            button.className = 'wa-interaction-option';
            if (option.tone === 'danger') button.classList.add('is-danger');
            if (index === selectedIndex) button.classList.add('is-selected');
            button.setAttribute('role', 'option');
            button.setAttribute('aria-selected', index === selectedIndex ? 'true' : 'false');
            button.disabled = submitting;
            const label = document.createElement('span');
            label.textContent = option.label;
            button.appendChild(label);
            if (option.description) {
                const description = document.createElement('span');
                description.className = 'wa-interaction-option-description';
                description.textContent = option.description;
                button.appendChild(description);
            }
            button.addEventListener('click', () => {
                selectedIndex = index;
                renderOptions();
                submit();
            });
            options.appendChild(button);
        });
        const active = options.children?.[selectedIndex];
        if (active?.id) options.setAttribute('aria-activedescendant', active.id);
    }

    function select(index) {
        if (!interaction || visibleOptions.length === 0) return;
        selectedIndex = Math.max(0, Math.min(index, visibleOptions.length - 1));
        renderOptions();
    }

    function submit() {
        if (!interaction || submitting) return false;
        const inputInteraction = Boolean(interaction.input);
        const option = visibleOptions[selectedIndex];
        if (!inputInteraction && !option) return false;
        submitting = true;
        root?.classList?.add('is-submitting');
        renderOptions();
        Promise.resolve(onSubmit?.(
            interaction.id,
            inputInteraction ? null : option.id,
            inputInteraction ? String(input?.value || '') : null,
        )).catch(() => {
            submitting = false;
            root?.classList?.remove('is-submitting');
            renderOptions();
            root?.focus?.({ preventScroll: true });
        });
        return true;
    }

    function cancel() {
        if (!interaction || submitting || typeof onCancel !== 'function') return false;
        submitting = true;
        root?.classList?.add('is-submitting');
        renderOptions();
        Promise.resolve(onCancel(interaction.id)).catch(() => {
            submitting = false;
            root?.classList?.remove('is-submitting');
            renderOptions();
            root?.focus?.({ preventScroll: true });
        });
        return true;
    }

    function handleKeydown(event) {
        if (!interaction) return false;
        if (!interaction.input && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault();
            const direction = event.key === 'ArrowDown' ? 1 : -1;
            select(nextInteractionOptionIndex(selectedIndex, visibleOptions.length, direction));
            return true;
        }
        if (event.key === 'Enter') {
            event.preventDefault();
            submit();
            return true;
        }
        return false;
    }

    function show(nextInteraction) {
        if (!nextInteraction?.id || !Array.isArray(nextInteraction.options)
            || (!nextInteraction.input && nextInteraction.options.length === 0)) return;
        interaction = nextInteraction;
        submitting = false;
        selectedIndex = Math.max(0, interaction.options.findIndex((option) => option.id === interaction.defaultOptionId));
        if (title) title.textContent = interaction.title || 'Action required';
        if (message) {
            message.textContent = interaction.message || '';
            message.hidden = !interaction.message;
        }
        if (detail) {
            renderDetail();
        }
        if (root) {
            root.hidden = false;
            root.classList.remove('is-submitting');
        }
        if (inputRow) inputRow.hidden = !interaction.input && !interaction.searchable;
        if (input) {
            input.value = '';
            input.type = interaction.input?.type === 'secret' ? 'password' : (interaction.searchable ? 'search' : 'text');
            input.placeholder = interaction.input?.placeholder || (interaction.searchable ? 'Filter options…' : '');
            input.maxLength = interaction.input?.maxLength || 300;
            input.disabled = false;
        }
        if (submitButton) submitButton.hidden = !interaction.input;
        if (cancelButton) cancelButton.hidden = !interaction.input;
        renderOptions();
        notifyActive(true);
        if (interaction.input || interaction.searchable) input?.focus?.({ preventScroll: true });
        else root?.focus?.({ preventScroll: true });
    }

    function resolve(resolution = {}) {
        if (!interaction) return;
        if (resolution.id && resolution.id !== interaction.id) return;
        interaction = null;
        submitting = false;
        if (root) {
            root.hidden = true;
            root.classList.remove('is-submitting');
        }
        options?.replaceChildren?.();
        if (inputRow) inputRow.hidden = true;
        if (input) input.value = '';
        notifyActive(false);
    }

    root?.addEventListener?.('keydown', handleKeydown);
    input?.addEventListener?.('input', () => {
        if (!interaction?.searchable) return;
        selectedIndex = 0;
        renderOptions();
    });
    submitButton?.addEventListener?.('click', submit);
    cancelButton?.addEventListener?.('click', cancel);

    return {
        show,
        resolve,
        submit,
        cancel,
        handleKeydown,
        get active() {
            return Boolean(interaction);
        },
        get selectedOptionId() {
            return visibleOptions[selectedIndex]?.id || null;
        },
    };
}
