import { enhanceWorkspaceFileLinks, workspaceFilePreviewKind } from './workspaceFileLinks.js';

const PANEL_SIZE_KEY = 'webchat_sidepanel_pct';
const MAX_INLINE_TEXT_CHARACTERS = 2_000_000;

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function renderMarkdown(markdown, text) {
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

export function createSidePanel({
    chatContainer,
    chatArea,
    sidePanel,
    sidePanelContent,
    sidePanelClose,
    sidePanelTitle,
    sidePanelResizer
}, {
    markdown,
    workspaceBase = '',
    webchatBasePath = '/webchat',
    workspaceFileIndex = null,
    sendQuickCommand = null,
    sendInteractionResponse = null,
}) {
    let activeBubble = null;
    let activeFrame = null;
    let activeFrameUrl = '';
    let activeTaskId = '';
    let activeTaskCommands = [];
    let activeTaskInteractionId = '';
    let activeFileRequest = 0;
    const panelWrapper = sidePanel?.querySelector('.wa-side-panel-content') || null;

    function clearPanelTitle() {
        if (!sidePanelTitle) {
            return;
        }
        sidePanelTitle.textContent = '';
        try {
            while (sidePanelTitle.firstChild) {
                sidePanelTitle.removeChild(sidePanelTitle.firstChild);
            }
        } catch (_) {
            // Ignore DOM issues while clearing title
        }
    }

    function setPanelTitleText(text) {
        if (!sidePanelTitle) {
            return;
        }
        clearPanelTitle();
        sidePanelTitle.textContent = text || '';
    }

    function setPanelTitleLink(url, label = url) {
        if (!sidePanelTitle) {
            return;
        }
        clearPanelTitle();

        const anchor = document.createElement('a');
        anchor.className = 'wa-side-panel-title-link';
        anchor.href = url;
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        anchor.textContent = label;
        anchor.title = url;

        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        icon.classList.add('wa-side-panel-title-icon');
        icon.setAttribute('width', '16');
        icon.setAttribute('height', '16');
        icon.setAttribute('viewBox', '0 0 24 24');

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('fill', 'currentColor');
        path.setAttribute('d', 'M14 3h7v7h-2V6.41l-9.29 9.3-1.42-1.42 9.3-9.29H14V3z M19 19H5V5h7V3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7z');
        icon.appendChild(path);

        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.title = 'Copy link';
        copyBtn.className = 'wa-copy-btn';
        copyBtn.onclick = async (event) => {
            event.preventDefault();
            try {
                await navigator.clipboard.writeText(url);
                copyBtn.classList.add('ok');
                copyBtn.title = 'Copied';
                setTimeout(() => {
                    copyBtn.classList.remove('ok');
                    copyBtn.title = 'Copy link';
                }, 1000);
            } catch (_) {
                // Ignore clipboard failures
            }
        };
        copyBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M16 1H4c-1.1 0-2 .9-2 2v12h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>';

        const wrap = document.createElement('span');
        wrap.className = 'wa-side-panel-title-row';
        wrap.appendChild(anchor);
        wrap.appendChild(icon);
        wrap.appendChild(copyBtn);

        sidePanelTitle.appendChild(wrap);
    }

    function ensurePanelVisible() {
        if (!sidePanel || !chatContainer) {
            return;
        }
        sidePanel.style.display = 'flex';
        chatContainer.classList.add('side-panel-open');
    }

    function resetChatAreaSizing() {
        if (!chatArea) {
            return;
        }
        chatArea.style.width = '';
        chatArea.style.flex = '';
    }

    function applyPanelSize(percent) {
        const pct = clamp(percent, 20, 80);
        if (sidePanel) {
            sidePanel.style.flex = `0 0 ${pct}%`;
            sidePanel.style.maxWidth = 'unset';
            sidePanel.style.width = `${pct}%`;
        }
        if (chatArea) {
            const leftPct = 100 - pct;
            chatArea.style.flex = '0 0 auto';
            chatArea.style.width = `calc(${leftPct}% - 6px)`;
        }
    }

    function applyPanelSizeFromStorage() {
        let stored = 40;
        try {
            stored = parseFloat(localStorage.getItem(PANEL_SIZE_KEY) || '40');
        } catch (_) {
            stored = 40;
        }
        applyPanelSize(Number.isFinite(stored) ? stored : 40);
    }

    function showText(text) {
        if (!panelWrapper) {
            return;
        }
        panelWrapper.innerHTML = '<div id="sidePanelContent" class="wa-side-panel-body"></div>';
        const container = panelWrapper.querySelector('#sidePanelContent');
        if (!container) {
            return;
        }
        container.innerHTML = renderMarkdown(markdown, text);
        enhanceWorkspaceFileLinks(container, {
            workspaceBase,
            webchatBasePath,
            fileIndex: workspaceFileIndex,
        });
        bindLinkDelegation(container);
        setPanelTitleText('Full Answer');
        activeFrame = null;
        activeFrameUrl = '';
        activeTaskId = '';
        activeTaskCommands = [];
        activeTaskInteractionId = '';
    }

    function openText(bubble, text) {
        if (!sidePanel) {
            return;
        }
        activeFileRequest += 1;
        showText(text);
        activeBubble = bubble || null;
        ensurePanelVisible();
        applyPanelSizeFromStorage();
    }

    function openIframe(url, { taskId = '', sandbox = false, title = url } = {}) {
        if (!panelWrapper || !sidePanel) {
            return null;
        }
        const normalizedTaskId = String(taskId || '').trim();
        const normalizedUrl = String(url || '');
        if (normalizedTaskId
            && activeTaskId === normalizedTaskId
            && activeFrame
            && activeFrameUrl === normalizedUrl) {
            ensurePanelVisible();
            setPanelTitleLink(url, title);
            applyPanelSizeFromStorage();
            return activeFrame;
        }
        activeFileRequest += 1;
        panelWrapper.innerHTML = '';

        const holder = document.createElement('div');
        holder.className = 'wa-iframe-wrap';
        holder.style.position = 'relative';
        holder.style.width = '100%';
        holder.style.height = '100%';

        const frame = document.createElement('iframe');
        frame.src = url;
        frame.style.border = '0';
        frame.style.width = '100%';
        frame.style.height = '100%';
        frame.referrerPolicy = 'no-referrer';
        frame.loading = 'lazy';
        if (sandbox) {
            frame.setAttribute?.('sandbox', '');
        }

        const overlay = document.createElement('div');
        overlay.className = 'wa-iframe-error';
        overlay.style.display = 'none';
        overlay.innerHTML = `
            <div class="wa-iframe-error-card">
              <div class="wa-iframe-error-title">Cannot display this site in an embedded view</div>
              <div class="wa-iframe-error-text">It may be blocked by X-Frame-Options or Content Security Policy.</div>
              <div class="wa-iframe-error-actions">
                <a class="wa-btn" href="${url}" target="_blank" rel="noopener noreferrer">Open in new tab</a>
              </div>
            </div>`;

        holder.appendChild(frame);
        holder.appendChild(overlay);
        panelWrapper.appendChild(holder);

        let loaded = false;
        frame.addEventListener('load', () => {
            loaded = true;
            overlay.style.display = 'none';
            if (normalizedTaskId
                && activeFrame === frame
                && activeTaskId === normalizedTaskId) {
                sendQuickCommand?.(`/task view ${normalizedTaskId}`);
            }
        });
        setTimeout(() => {
            if (!loaded) {
                overlay.style.display = 'flex';
            }
        }, 2500);

        activeBubble = null;
        activeFrame = frame;
        activeFrameUrl = normalizedUrl;
        activeTaskId = normalizedTaskId;
        activeTaskCommands = [];
        activeTaskInteractionId = '';
        ensurePanelVisible();
        setPanelTitleLink(url, title);
        applyPanelSizeFromStorage();
        return frame;
    }

    function showFileMessage(message, className = '') {
        if (!panelWrapper) return;
        panelWrapper.innerHTML = '';
        const body = document.createElement('div');
        body.className = `wa-side-panel-body wa-workspace-file-status ${className}`.trim();
        body.textContent = message;
        panelWrapper.appendChild(body);
    }
    function showTextFile(text, { path, markdownFile }) {
        if (!panelWrapper) return;
        panelWrapper.innerHTML = '';
        const container = document.createElement('div');
        container.className = 'wa-side-panel-body wa-workspace-file-text';
        panelWrapper.appendChild(container);
        if (markdownFile) {
            container.innerHTML = renderMarkdown(markdown, text);
            enhanceWorkspaceFileLinks(container, {
                workspaceBase,
                webchatBasePath,
                fileIndex: workspaceFileIndex,
            });
            bindLinkDelegation(container);
            return;
        }
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.textContent = text;
        if (path) code.dataset.path = path;
        pre.appendChild(code);
        container.appendChild(pre);
    }
    function showImageFile(url, path) {
        if (!panelWrapper) return;
        panelWrapper.innerHTML = '';
        const holder = document.createElement('div');
        holder.className = 'wa-workspace-file-image-wrap';
        const img = document.createElement('img');
        img.className = 'wa-workspace-file-image';
        img.src = url;
        img.alt = path || 'Workspace file';
        img.addEventListener('error', () => {
            showFileMessage('Unable to preview this image.', 'is-error');
        }, { once: true });
        holder.appendChild(img);
        panelWrapper.appendChild(holder);
    }
    async function openWorkspaceFile(url, { path = '' } = {}) {
        if (!panelWrapper || !sidePanel) return;
        const kind = workspaceFilePreviewKind(path || url);
        const requestId = ++activeFileRequest;
        activeBubble = null;
        activeFrame = null;
        activeFrameUrl = '';
        activeTaskId = '';
        activeTaskCommands = [];
        activeTaskInteractionId = '';
        ensurePanelVisible();
        applyPanelSizeFromStorage();
        setPanelTitleLink(url, path || url);
        if (kind === 'image') {
            showImageFile(url, path);
            return;
        }
        if (kind === 'pdf') {
            openIframe(url, { title: path || url });
            return;
        }
        if (kind === 'html') {
            openIframe(url, { sandbox: true, title: path || url });
            return;
        }
        if (kind !== 'markdown' && kind !== 'text') {
            showFileMessage('Preview is not available for this file type.', 'is-error');
            return;
        }
        showFileMessage('Loading file…', 'is-loading');
        try {
            const response = await fetch(url, { credentials: 'include' });
            if (!response.ok) {
                throw new Error(response.status === 404 ? 'File not found.' : 'Unable to load this file.');
            }
            const text = await response.text();
            if (requestId !== activeFileRequest) return;
            if (text.length > MAX_INLINE_TEXT_CHARACTERS) {
                showFileMessage('This file is too large to preview.', 'is-error');
                return;
            }
            showTextFile(text, { path, markdownFile: kind === 'markdown' });
        } catch (error) {
            if (requestId !== activeFileRequest) return;
            showFileMessage(error?.message || 'Unable to load this file.', 'is-error');
        }
    }

    function close() {
        if (!sidePanel || !chatContainer) {
            return;
        }
        sidePanel.style.display = 'none';
        chatContainer.classList.remove('side-panel-open');
        activeBubble = null;
        activeFrame = null;
        activeFrameUrl = '';
        activeTaskId = '';
        activeTaskCommands = [];
        activeTaskInteractionId = '';
        activeFileRequest += 1;
        resetChatAreaSizing();
    }

    function postTaskUpdate(payload) {
        const taskId = String(payload?.task?.id || '').trim();
        if (!activeFrame?.contentWindow || !activeTaskId || taskId !== activeTaskId) {
            return;
        }
        if (Array.isArray(payload?.task?.commands)) {
            activeTaskCommands = payload.task.commands
                .map((entry) => String(entry?.command || '').trim())
                .filter(Boolean);
        }
        try {
            activeFrame.contentWindow.postMessage({
                type: 'webchat-task-update',
                payload,
            }, window.location.origin);
        } catch (_) {
            // The embedded task view may have closed between the update and delivery.
        }
    }

    function postTaskInteraction(interaction) {
        if (!activeFrame?.contentWindow || interaction?.targetTaskId !== activeTaskId) return false;
        activeTaskInteractionId = String(interaction.id || '');
        try {
            activeFrame.contentWindow.postMessage({
                type: 'webchat-task-interaction-request',
                payload: interaction,
            }, window.location.origin);
            return true;
        } catch (_) {
            activeTaskInteractionId = '';
            return false;
        }
    }

    function postTaskInteractionResolved(resolution) {
        if (!activeFrame?.contentWindow || resolution?.id !== activeTaskInteractionId) return false;
        try {
            activeFrame.contentWindow.postMessage({
                type: 'webchat-task-interaction-resolved',
                payload: resolution,
            }, window.location.origin);
        } catch (_) {
            return false;
        } finally {
            activeTaskInteractionId = '';
        }
        return true;
    }

    window.addEventListener?.('message', (event) => {
        if (event.origin !== window.location.origin || event.source !== activeFrame?.contentWindow) return;
        if (event.data?.type === 'webchat-task-interaction-response') {
            if (event.data.taskId !== activeTaskId || event.data.interactionId !== activeTaskInteractionId) return;
            const optionId = typeof event.data.optionId === 'string' ? event.data.optionId : null;
            const response = typeof event.data.response === 'string' ? event.data.response : null;
            if ((!optionId && response === null) || (optionId && response !== null)) return;
            sendInteractionResponse?.(activeTaskInteractionId, optionId, response);
            return;
        }
        if (event.data?.type !== 'webchat-task-command' || event.data.taskId !== activeTaskId) return;
        const command = String(event.data.command || '');
        const escapedTaskId = activeTaskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const allowed = new RegExp(`^/task (?:view|stop) ${escapedTaskId}$|^/task continue ${escapedTaskId} [\\s\\S]+$`);
        const declaredTaskCommand = activeTaskCommands.some((baseCommand) => (
            command === baseCommand || command.startsWith(`${baseCommand} `)
        ));
        if (!allowed.test(command) && !declaredTaskCommand) return;
        sendQuickCommand?.(command);
    });

    function updateIfActive(bubble, text) {
        if (!bubble || bubble !== activeBubble) {
            return;
        }
        showText(text);
        applyPanelSizeFromStorage();
    }

    if (sidePanelClose) {
        sidePanelClose.onclick = () => close();
    }

    (function initResizer() {
        if (!sidePanelResizer || !chatContainer || !sidePanel) {
            return;
        }
        let dragging = false;
        let startX = 0;
        let containerWidth = 0;
        let startPanelWidth = 0;
        let raf = 0;
        let pendingPct = null;

        function scheduleApply(pct) {
            pendingPct = pct;
            if (raf) {
                return;
            }
            raf = requestAnimationFrame(() => {
                if (pendingPct !== null) {
                    applyPanelSize(pendingPct);
                }
                raf = 0;
                pendingPct = null;
            });
        }

        function onPointerDown(event) {
            try {
                event.preventDefault();
            } catch (_) {
                // Ignore prevention failures
            }
            dragging = true;
            chatContainer.classList.add('dragging');
            startX = event.clientX;
            try {
                sidePanelResizer.setPointerCapture(event.pointerId);
            } catch (_) {
                // Ignore pointer capture failures
            }
            const containerRect = chatContainer.getBoundingClientRect();
            containerWidth = containerRect.width;
            startPanelWidth = sidePanel.getBoundingClientRect().width;
            window.addEventListener('pointermove', onPointerMove);
            window.addEventListener('pointerup', onPointerUp, { once: true });
            window.addEventListener('pointercancel', onPointerUp, { once: true });
        }

        function onPointerMove(event) {
            if (!dragging) {
                return;
            }
            try {
                event.preventDefault();
            } catch (_) {
                // Ignore prevention failures
            }
            const delta = event.clientX - startX;
            const newWidth = clamp(startPanelWidth - delta, containerWidth * 0.2, containerWidth * 0.8);
            const pct = (newWidth / containerWidth) * 100;
            scheduleApply(pct);
        }

        function onPointerUp(event) {
            if (!dragging) {
                return;
            }
            dragging = false;
            chatContainer.classList.remove('dragging');
            try {
                sidePanelResizer.releasePointerCapture(event.pointerId);
            } catch (_) {
                // Ignore release failures
            }
            window.removeEventListener('pointermove', onPointerMove);
            try {
                const panelRect = sidePanel.getBoundingClientRect();
                const containerRect = chatContainer.getBoundingClientRect();
                const pct = clamp((panelRect.width / containerRect.width) * 100, 20, 80);
                localStorage.setItem(PANEL_SIZE_KEY, String(pct.toFixed(1)));
            } catch (_) {
                // Ignore storage failures
            }
        }

        sidePanelResizer.addEventListener('pointerdown', onPointerDown);
    })();

    function bindLinkDelegation(container) {
        if (!container || container.dataset.linksBound === 'true') {
            return;
        }
        container.addEventListener('click', (event) => {
            const link = event.target.closest('a[data-wc-link="true"]');
            if (!link) {
                return;
            }
            event.preventDefault();
            if (link.dataset.wcFile === 'true') {
                void openWorkspaceFile(link.href, {
                    path: link.dataset.wcFilePath || '',
                });
                return;
            }
            openIframe(link.href, { taskId: link.dataset.wcTaskId || '' });
        });
        container.dataset.linksBound = 'true';
    }

    function refreshWorkspaceFileLinks() {
        const containers = panelWrapper?.querySelectorAll?.('.wa-side-panel-body') || [];
        for (const container of containers) {
            enhanceWorkspaceFileLinks(container, {
                workspaceBase,
                webchatBasePath,
                fileIndex: workspaceFileIndex,
            });
        }
    }

    return {
        openText,
        openIframe,
        openWorkspaceFile,
        postTaskUpdate,
        postTaskInteraction,
        postTaskInteractionResolved,
        close,
        updateIfActive,
        refreshWorkspaceFileLinks,
        isActive: (bubble) => bubble === activeBubble,
        applyPanelSizeFromStorage,
        bindLinkDelegation
    };
}
