function normalizeRelativePath(value) {
    return String(value || '')
        .replace(/\\+/g, '/')
        .replace(/\/+/g, '/')
        .replace(/^\/+|\/+$/g, '');
}

export function joinUploadPath(...parts) {
    return parts.map(normalizeRelativePath).filter(Boolean).join('/');
}

export function buildUploadSelectionRoots(selections = [], mode = 'file') {
    const roots = new Map();
    for (const selection of selections) {
        const relativePath = normalizeRelativePath(selection?.relativePath || selection?.file?.name);
        if (!relativePath) continue;
        const name = relativePath.split('/')[0];
        roots.set(name, {
            name,
            kind: mode === 'folder' ? 'folder' : 'file',
        });
    }
    return [...roots.values()];
}

export function createUploadDestinationDialog({ toEndpoint, composer } = {}) {
    const overlay = document.createElement('div');
    overlay.className = 'wa-upload-destination-overlay';
    overlay.hidden = true;
    overlay.innerHTML = `
        <section class="wa-upload-destination-dialog" role="dialog" aria-modal="true" aria-labelledby="uploadDestinationTitle">
            <header class="wa-upload-destination-header">
                <div>
                    <h2 id="uploadDestinationTitle">Choose upload destination</h2>
                    <p class="wa-upload-selection-summary"></p>
                </div>
                <button type="button" class="wa-upload-destination-close" aria-label="Close">×</button>
            </header>
            <nav class="wa-upload-breadcrumbs" aria-label="Current folder"></nav>
            <div class="wa-upload-directory-toolbar">
                <span class="wa-upload-current-path"></span>
                <button type="button" class="wa-upload-new-folder-toggle">New folder</button>
            </div>
            <form class="wa-upload-new-folder-form" hidden>
                <input type="text" maxlength="255" autocomplete="off" placeholder="Folder name" aria-label="New folder name" />
                <button type="submit">Create</button>
                <button type="button" data-action="cancel-create">Cancel</button>
            </form>
            <div class="wa-upload-directory-status" role="status" aria-live="polite"></div>
            <div class="wa-upload-directory-list" role="list"></div>
            <div class="wa-upload-overwrite-warning" role="alert" hidden></div>
            <footer class="wa-upload-destination-footer">
                <button type="button" class="wa-upload-cancel">Cancel</button>
                <button type="button" class="wa-upload-confirm" disabled>Upload here</button>
            </footer>
        </section>
    `;
    document.body.appendChild(overlay);

    const dialog = overlay.querySelector('.wa-upload-destination-dialog');
    const closeBtn = overlay.querySelector('.wa-upload-destination-close');
    const summaryEl = overlay.querySelector('.wa-upload-selection-summary');
    const breadcrumbsEl = overlay.querySelector('.wa-upload-breadcrumbs');
    const currentPathEl = overlay.querySelector('.wa-upload-current-path');
    const newFolderToggle = overlay.querySelector('.wa-upload-new-folder-toggle');
    const newFolderForm = overlay.querySelector('.wa-upload-new-folder-form');
    const newFolderInput = newFolderForm.querySelector('input');
    const cancelCreateBtn = newFolderForm.querySelector('[data-action="cancel-create"]');
    const statusEl = overlay.querySelector('.wa-upload-directory-status');
    const listEl = overlay.querySelector('.wa-upload-directory-list');
    const warningEl = overlay.querySelector('.wa-upload-overwrite-warning');
    const cancelBtn = overlay.querySelector('.wa-upload-cancel');
    const confirmBtn = overlay.querySelector('.wa-upload-confirm');

    let currentPath = '';
    let currentEntries = [];
    let selectionRoots = [];
    let resolver = null;
    let loadRequestId = 0;
    let overwriteConfirmationPending = false;

    const endpoint = (suffix) => typeof toEndpoint === 'function'
        ? toEndpoint(suffix)
        : `/webchat/${String(suffix || '').replace(/^\/+/, '')}`;

    function refocusComposer() {
        setTimeout(() => {
            try { composer?.focus?.(); } catch (_) { /* ignore */ }
        }, 0);
    }

    function resetConfirmation() {
        overwriteConfirmationPending = false;
        warningEl.hidden = true;
        warningEl.textContent = '';
        confirmBtn.textContent = 'Upload here';
    }

    function renderBreadcrumbs() {
        breadcrumbsEl.replaceChildren();
        const segments = currentPath.split('/').filter(Boolean);
        const root = document.createElement('button');
        root.type = 'button';
        root.textContent = 'Working directory';
        root.addEventListener('click', () => loadDirectory(''));
        breadcrumbsEl.appendChild(root);
        let accumulated = '';
        for (const segment of segments) {
            const separator = document.createElement('span');
            separator.textContent = '›';
            breadcrumbsEl.appendChild(separator);
            accumulated = joinUploadPath(accumulated, segment);
            const targetPath = accumulated;
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = segment;
            button.addEventListener('click', () => loadDirectory(targetPath));
            breadcrumbsEl.appendChild(button);
        }
        currentPathEl.textContent = currentPath || 'Working directory';
    }

    function renderEntries() {
        listEl.replaceChildren();
        if (!currentEntries.length) {
            const empty = document.createElement('div');
            empty.className = 'wa-upload-directory-empty';
            empty.textContent = 'This folder is empty.';
            listEl.appendChild(empty);
            return;
        }
        for (const entry of currentEntries) {
            const row = document.createElement(entry.kind === 'folder' ? 'button' : 'div');
            if (entry.kind === 'folder') row.type = 'button';
            row.className = `wa-upload-directory-entry ${entry.kind}`;
            row.setAttribute('role', 'listitem');
            const icon = document.createElement('span');
            icon.className = 'wa-upload-directory-entry-icon';
            icon.textContent = entry.kind === 'folder' ? '📁' : '📄';
            const name = document.createElement('span');
            name.className = 'wa-upload-directory-entry-name';
            name.textContent = entry.name;
            row.append(icon, name);
            if (entry.kind === 'folder') {
                row.addEventListener('click', () => loadDirectory(entry.path));
            } else {
                row.setAttribute('aria-disabled', 'true');
            }
            listEl.appendChild(row);
        }
    }

    async function loadDirectory(pathValue) {
        const requestId = ++loadRequestId;
        resetConfirmation();
        confirmBtn.disabled = true;
        statusEl.textContent = 'Loading…';
        try {
            const params = new URLSearchParams({ path: normalizeRelativePath(pathValue) });
            const response = await fetch(endpoint(`directories?${params.toString()}`), {
                credentials: 'include',
            });
            const payload = await response.json().catch(() => null);
            if (!response.ok || !payload?.ok) {
                throw new Error(payload?.error || 'Unable to open folder');
            }
            if (requestId !== loadRequestId) return;
            currentPath = normalizeRelativePath(payload.path);
            currentEntries = Array.isArray(payload.entries) ? payload.entries : [];
            renderBreadcrumbs();
            renderEntries();
            statusEl.textContent = '';
            confirmBtn.disabled = false;
        } catch (error) {
            if (requestId !== loadRequestId) return;
            currentEntries = [];
            listEl.replaceChildren();
            statusEl.textContent = error.message || 'Unable to open folder.';
        }
    }

    function close(result) {
        const resolve = resolver;
        resolver = null;
        loadRequestId += 1;
        overlay.hidden = true;
        document.removeEventListener('keydown', handleKeydown, true);
        newFolderForm.hidden = true;
        resetConfirmation();
        refocusComposer();
        resolve?.(result);
    }

    function handleKeydown(event) {
        if (event.key === 'Escape') {
            event.preventDefault();
            close(null);
            return;
        }
        if (event.key !== 'Tab') return;
        const focusable = [...dialog.querySelectorAll('button:not([disabled]), input:not([disabled])')]
            .filter((element) => !element.hidden && element.offsetParent !== null);
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    }

    async function createFolder(event) {
        event.preventDefault();
        const name = normalizeRelativePath(newFolderInput.value);
        if (!name || name.includes('/')) {
            statusEl.textContent = 'Enter a valid folder name.';
            return;
        }
        const nextPath = joinUploadPath(currentPath, name);
        statusEl.textContent = 'Creating folder…';
        try {
            const response = await fetch(endpoint('directories'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: nextPath }),
                credentials: 'include',
            });
            const payload = await response.json().catch(() => null);
            if (!response.ok || !payload?.ok) {
                throw new Error(payload?.error || 'Unable to create folder');
            }
            newFolderInput.value = '';
            newFolderForm.hidden = true;
            await loadDirectory(payload.path);
        } catch (error) {
            statusEl.textContent = error.message || 'Unable to create folder.';
        }
    }

    function confirmDestination() {
        const entriesByName = new Map(currentEntries.map((entry) => [entry.name, entry]));
        const collisions = [];
        const typeConflicts = [];
        for (const root of selectionRoots) {
            const existing = entriesByName.get(root.name);
            if (!existing) continue;
            if (existing.kind !== root.kind) typeConflicts.push(root.name);
            else collisions.push(root.name);
        }
        if (typeConflicts.length) {
            resetConfirmation();
            warningEl.hidden = false;
            warningEl.textContent = `Cannot replace a file with a folder or a folder with a file: ${typeConflicts.join(', ')}`;
            return;
        }
        if (collisions.length && !overwriteConfirmationPending) {
            overwriteConfirmationPending = true;
            warningEl.hidden = false;
            warningEl.textContent = `Already exists: ${collisions.join(', ')}. Existing files will be overwritten; existing folders will be merged.`;
            confirmBtn.textContent = 'Overwrite and attach';
            return;
        }
        close({
            destinationPath: currentPath,
            overwriteRoots: collisions,
        });
    }

    closeBtn.addEventListener('click', () => close(null));
    cancelBtn.addEventListener('click', () => close(null));
    confirmBtn.addEventListener('click', confirmDestination);
    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) close(null);
    });
    newFolderToggle.addEventListener('click', () => {
        newFolderForm.hidden = false;
        newFolderInput.value = '';
        newFolderInput.focus();
    });
    cancelCreateBtn.addEventListener('click', () => {
        newFolderForm.hidden = true;
        newFolderInput.value = '';
        statusEl.textContent = '';
    });
    newFolderForm.addEventListener('submit', createFolder);

    return {
        open({ roots = [], summary = '' } = {}) {
            if (resolver) close(null);
            selectionRoots = roots;
            summaryEl.textContent = summary;
            currentPath = '';
            currentEntries = [];
            statusEl.textContent = '';
            listEl.replaceChildren();
            overlay.hidden = false;
            document.addEventListener('keydown', handleKeydown, true);
            closeBtn.focus();
            const result = new Promise((resolve) => {
                resolver = resolve;
            });
            loadDirectory('');
            return result;
        },
    };
}
