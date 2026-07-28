export function createHeaderMenu({ button, panel, documentRef = globalThis.document } = {}) {
    if (!button || !panel || !documentRef) {
        return {
            open() {},
            close() {},
            toggle() {},
            isOpen: () => false,
            destroy() {},
        };
    }

    const setOpen = (open, { restoreFocus = false } = {}) => {
        panel.classList.toggle('show', open);
        button.classList.toggle('active', open);
        button.setAttribute('aria-expanded', String(open));
        if (restoreFocus) button.focus();
    };
    const isOpen = () => panel.classList.contains('show');
    const open = () => setOpen(true);
    const close = (options) => setOpen(false, options);
    const toggle = () => setOpen(!isOpen());

    const onButtonClick = (event) => {
        event.stopPropagation();
        toggle();
    };
    const onPanelClick = (event) => {
        if (event.target?.closest?.('[data-menu-action]')) close();
    };
    const onDocumentPointerDown = (event) => {
        if (!isOpen()) return;
        if (panel.contains(event.target) || button.contains(event.target)) return;
        close();
    };
    const onDocumentKeyDown = (event) => {
        if (event.key === 'Escape' && isOpen()) close({ restoreFocus: true });
    };

    button.addEventListener('click', onButtonClick);
    panel.addEventListener('click', onPanelClick);
    documentRef.addEventListener('pointerdown', onDocumentPointerDown);
    documentRef.addEventListener('keydown', onDocumentKeyDown);

    return {
        open,
        close,
        toggle,
        isOpen,
        destroy() {
            button.removeEventListener('click', onButtonClick);
            panel.removeEventListener('click', onPanelClick);
            documentRef.removeEventListener('pointerdown', onDocumentPointerDown);
            documentRef.removeEventListener('keydown', onDocumentKeyDown);
        },
    };
}

export function createResponsiveHeaderActions({
    actions = [],
    desktopContainer,
    mobileContainer,
    mobileSection,
    windowRef = globalThis.window,
    query = '(max-width: 640px)',
} = {}) {
    const movableActions = actions.filter(Boolean);
    if (!desktopContainer || !mobileContainer || !mobileSection || !windowRef?.matchMedia || movableActions.length === 0) {
        return { isMobile: () => false, destroy() {} };
    }

    const originalPositions = movableActions.map((action) => ({
        action,
        parent: action.parentNode,
        nextSibling: action.nextSibling,
    }));
    const mediaQuery = windowRef.matchMedia(query);

    const restoreDesktopOrder = () => {
        for (let index = originalPositions.length - 1; index >= 0; index -= 1) {
            const { action, parent, nextSibling } = originalPositions[index];
            parent.insertBefore(action, nextSibling);
        }
    };
    const applyLayout = () => {
        if (mediaQuery.matches) {
            movableActions.forEach((action) => mobileContainer.append(action));
            mobileSection.hidden = false;
            return;
        }
        restoreDesktopOrder();
        mobileSection.hidden = true;
    };
    const onChange = () => applyLayout();

    applyLayout();
    if (mediaQuery.addEventListener) mediaQuery.addEventListener('change', onChange);
    else mediaQuery.addListener?.(onChange);

    return {
        isMobile: () => mediaQuery.matches,
        destroy() {
            if (mediaQuery.removeEventListener) mediaQuery.removeEventListener('change', onChange);
            else mediaQuery.removeListener?.(onChange);
            restoreDesktopOrder();
            mobileSection.hidden = true;
        },
    };
}
