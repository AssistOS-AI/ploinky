const PANEL_SIZE_KEY = 'webchat_sidepanel_pct';

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
}, { markdown }) {
    let activeBubble = null;
    let activeFrame = null;
    let activeTaskId = '';

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

    function setPanelTitleLink(url) {
        if (!sidePanelTitle) {
            return;
        }
        clearPanelTitle();

        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        anchor.textContent = url;
        anchor.title = url;
        anchor.style.color = 'var(--wa-accent)';
        anchor.style.textDecoration = 'none';
        anchor.style.wordBreak = 'break-all';
        anchor.style.overflowWrap = 'anywhere';
        anchor.style.fontFamily = 'Menlo, Monaco, Consolas, monospace';
        anchor.style.fontSize = '13px';

        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        icon.setAttribute('width', '16');
        icon.setAttribute('height', '16');
        icon.setAttribute('viewBox', '0 0 24 24');
        icon.style.marginLeft = '6px';
        icon.style.verticalAlign = 'text-bottom';

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
        wrap.style.display = 'inline-flex';
        wrap.style.alignItems = 'center';
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
        bindLinkDelegation(container);
        setPanelTitleText('Full Answer');
        activeFrame = null;
        activeTaskId = '';
    }

    function openText(bubble, text) {
        if (!sidePanel) {
            return;
        }
        showText(text);
        activeBubble = bubble || null;
        ensurePanelVisible();
        applyPanelSizeFromStorage();
    }

    function openIframe(url, { taskId = '' } = {}) {
        if (!panelWrapper || !sidePanel) {
            return;
        }
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
        });
        setTimeout(() => {
            if (!loaded) {
                overlay.style.display = 'flex';
            }
        }, 2500);

        activeBubble = null;
        activeFrame = frame;
        activeTaskId = String(taskId || '').trim();
        ensurePanelVisible();
        setPanelTitleLink(url);
        applyPanelSizeFromStorage();
    }

    function close() {
        if (!sidePanel || !chatContainer) {
            return;
        }
        sidePanel.style.display = 'none';
        chatContainer.classList.remove('side-panel-open');
        activeBubble = null;
        activeFrame = null;
        activeTaskId = '';
        resetChatAreaSizing();
    }

    function postTaskUpdate(payload) {
        const taskId = String(payload?.task?.id || '').trim();
        if (!activeFrame?.contentWindow || !activeTaskId || taskId !== activeTaskId) {
            return;
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
            openIframe(link.href, { taskId: link.dataset.wcTaskId || '' });
        });
        container.dataset.linksBound = 'true';
    }

    return {
        openText,
        openIframe,
        postTaskUpdate,
        close,
        updateIfActive,
        isActive: (bubble) => bubble === activeBubble,
        applyPanelSizeFromStorage,
        bindLinkDelegation
    };
}
