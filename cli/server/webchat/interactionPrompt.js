export function nextInteractionOptionIndex(currentIndex, optionCount, direction) {
    const count = Math.max(0, Number(optionCount) || 0);
    if (count === 0) return -1;
    const current = Math.max(0, Math.min(Number(currentIndex) || 0, count - 1));
    if (direction > 0) return (current + 1) % count;
    if (direction < 0) return (current - 1 + count) % count;
    return current;
}

export function createInteractionPrompt({ root, title, message, detail, options }, {
    onSubmit,
    onActiveChange,
} = {}) {
    let interaction = null;
    let selectedIndex = 0;
    let submitting = false;

    function notifyActive(active) {
        if (typeof onActiveChange === 'function') onActiveChange(active);
    }

    function renderOptions() {
        if (!options || !interaction) return;
        options.replaceChildren();
        interaction.options.forEach((option, index) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.id = `interaction-option-${interaction.id}-${index}`;
            button.className = 'wa-interaction-option';
            if (option.tone === 'danger') button.classList.add('is-danger');
            if (index === selectedIndex) button.classList.add('is-selected');
            button.setAttribute('role', 'option');
            button.setAttribute('aria-selected', index === selectedIndex ? 'true' : 'false');
            button.disabled = submitting;
            button.textContent = option.label;
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
        if (!interaction || interaction.options.length === 0) return;
        selectedIndex = Math.max(0, Math.min(index, interaction.options.length - 1));
        renderOptions();
    }

    function submit() {
        if (!interaction || submitting) return false;
        const option = interaction.options[selectedIndex];
        if (!option) return false;
        submitting = true;
        root?.classList?.add('is-submitting');
        renderOptions();
        Promise.resolve(onSubmit?.(interaction.id, option.id)).catch(() => {
            submitting = false;
            root?.classList?.remove('is-submitting');
            renderOptions();
            root?.focus?.({ preventScroll: true });
        });
        return true;
    }

    function handleKeydown(event) {
        if (!interaction) return false;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const direction = event.key === 'ArrowDown' ? 1 : -1;
            select(nextInteractionOptionIndex(selectedIndex, interaction.options.length, direction));
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
        if (!nextInteraction?.id || !Array.isArray(nextInteraction.options) || nextInteraction.options.length === 0) return;
        interaction = nextInteraction;
        submitting = false;
        selectedIndex = Math.max(0, interaction.options.findIndex((option) => option.id === interaction.defaultOptionId));
        if (title) title.textContent = interaction.title || 'Action required';
        if (message) {
            message.textContent = interaction.message || '';
            message.hidden = !interaction.message;
        }
        if (detail) {
            detail.textContent = interaction.detail || '';
            detail.hidden = !interaction.detail;
        }
        if (root) {
            root.hidden = false;
            root.classList.remove('is-submitting');
        }
        renderOptions();
        notifyActive(true);
        root?.focus?.({ preventScroll: true });
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
        notifyActive(false);
    }

    root?.addEventListener?.('keydown', handleKeydown);

    return {
        show,
        resolve,
        submit,
        handleKeydown,
        get active() {
            return Boolean(interaction);
        },
        get selectedOptionId() {
            return interaction?.options?.[selectedIndex]?.id || null;
        },
    };
}
