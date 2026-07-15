import { initDom } from './domSetup.js';
import { createSidePanel } from './sidePanel.js';
import { createMessages } from './messages.js';
import { createComposer } from './composer.js';
import { createNetwork } from './network.js';
import { createUploader } from './upload.js';
import { createComposerAutocomplete } from './composerAutocomplete.js';
import { createSlashCommandsProvider } from './autocompleteProviders/slashCommands.js';
import { createWorkspacePathsProvider } from './autocompleteProviders/workspacePaths.js';
import { createAutocompleteState } from './autocompleteState.js';
import { createComposerMentionHighlighter } from './composerMentionHighlights.js';
import { createSessionController } from './sessions.js';
import { createTaskController } from './tasks.js';

const PURGE_TRIGGER_RE = /\bpurge\b/i;
const EDITABLE_TAGS = ['INPUT', 'TEXTAREA', 'SELECT', 'OPTION'];

const dom = initDom();
const {
    TAB_ID,
    dlog,
    markdown,
    basePath,
    toEndpoint,
    showBanner,
    hideBanner,
    getViewMoreLineLimit,
    setViewMoreChangeHandler,
    elements
} = dom;

const {
    chatList,
    typingIndicator,
    chatContainer,
    chatArea,
    sidePanel,
    sidePanelContent,
    sidePanelClose,
    sidePanelTitle,
    sidePanelResizer,
    statusEl,
    statusDot,
    cmdInput,
    sendBtn,
    settingsBtn,
    logoutBtn,
    attachmentBtn,
    attachmentMenu,
    uploadFileBtn,
    uploadFolderBtn,
    cameraActionBtn,
    fileUploadInput,
    folderUploadInput,
    filePreviewContainer,
    attachmentContainer,
    cancelBtn,
    sessionsBtn,
    historyGate,
    loadHistoryBtn,
    sessionDialog,
    sessionDialogClose,
    sessionList,
    tasksBtn,
    tasksBadge,
    tasksDialog,
    tasksDialogClose,
    tasksList,
    taskDetail,
    taskToast
} = elements;

const sidePanelApi = createSidePanel({
    chatContainer,
    chatArea,
    sidePanel,
    sidePanelContent,
    sidePanelClose,
    sidePanelTitle,
    sidePanelResizer
}, { markdown });

let sessionController = null;
let taskController = null;
taskController = createTaskController({
    toEndpoint,
    elements: {
        tasksBtn,
        tasksBadge,
        tasksDialog,
        tasksDialogClose,
        tasksList,
        taskDetail,
        taskToast,
    },
    showBanner,
});

const messages = createMessages({
    chatList,
    typingIndicator,
    historyGate
}, {
    markdown,
    initialViewMoreLineLimit: getViewMoreLineLimit(),
    sidePanel: sidePanelApi,
    taskController,
    onQuickCommand: null,
    onTypingStateChange: (typing) => {
        composer.setProcessingState(Boolean(typing));
    }
});

dom.setViewMoreChangeHandler((limit) => {
    messages.setViewMoreLineLimit(limit);
});

sidePanelApi.bindLinkDelegation(chatList);

dlog('Initializing network for agent:', dom.agentName);
const network = createNetwork({
    TAB_ID,
    toEndpoint,
    dlog,
    showBanner,
    hideBanner,
    statusEl,
    statusDot,
    agentName: dom.agentName
}, {
    addClientMsg: messages.addClientMsg,
    addClientAttachment: messages.addClientAttachment,
    addServerMsg: messages.addServerMsg,
    addProgressEvent: messages.addProgressEvent,
    showTypingIndicator: messages.showTypingIndicator,
    hideTypingIndicator: messages.hideTypingIndicator,
    markUserInputSent: messages.markUserInputSent,
    addRemoteUserMessage: (message, payload) => sessionController?.addRemoteUserMessage(message, payload),
    onSessionChanged: (session) => sessionController?.handleExternalSessionChange(session),
    onTaskUpdate: (payload) => {
        taskController?.handleUpdate(payload);
        messages.associateTask(payload);
    },
    onConnected: () => taskController?.refresh().catch(() => {})
});

sessionController = createSessionController({
    toEndpoint,
    elements: {
        sessionsBtn,
        historyGate,
        loadHistoryBtn,
        sessionDialog,
        sessionDialogClose,
        sessionList
    },
    messages,
    network,
    showBanner,
    hideBanner
});

const composer = createComposer({
    cmdInput,
    sendBtn,
    cancelBtn
}, {
    purgeTriggerRe: PURGE_TRIGGER_RE
});

const autocompleteState = createAutocompleteState();
const mentionHighlighter = createComposerMentionHighlighter({ cmdInput });

const slashProvider = createSlashCommandsProvider({
    agentName: dom.agentName,
    dlog
});
const workspacePathsProvider = createWorkspacePathsProvider({
    basePath,
    state: autocompleteState,
    dlog
});

const composerAutocomplete = createComposerAutocomplete({
    cmdInput
}, {
    providers: [slashProvider, workspacePathsProvider],
    onSelectionApplied: ({ next }) => {
        mentionHighlighter.recordSelection(next?.value || '', next?.cursor ?? 0);
    },
    dlog
});

if (cmdInput) {
    cmdInput.addEventListener('keydown', (event) => {
        if (composerAutocomplete.handleKeydown(event)) return;
    }, true);
    cmdInput.addEventListener('input', () => {
        autocompleteState.pruneByText(cmdInput.value || '');
        mentionHighlighter.pruneByText(cmdInput.value || '');
        composerAutocomplete.onInputChange();
    });
}

const uploader = createUploader({
    attachmentBtn,
    attachmentMenu,
    uploadFileBtn,
    uploadFolderBtn,
    cameraActionBtn,
    fileUploadInput,
    folderUploadInput,
    filePreviewContainer,
    attachmentContainer
}, { composer });

function refocusComposerAfterIcon(btn) {
    if (!btn) {
        return;
    }
    btn.addEventListener('click', () => {
        setTimeout(() => composer.focus(), 0);
    });
}

function initMessageToolbar() {
    if (!chatList || !composer) {
        return;
    }

    const getBubbleText = (bubble) => {
        if (!bubble) {
            return '';
        }
        const fromDataset = typeof bubble.dataset.fullText === 'string' ? bubble.dataset.fullText : '';
        const fallback = bubble.textContent || '';
        return (fromDataset || fallback || '').trim();
    };

    const copyText = async (text) => {
        const value = (text || '').trim();
        if (!value) {
            return;
        }
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(value);
            } else {
                throw new Error('Clipboard unavailable');
            }
        } catch (_) {
            try {
                const textarea = document.createElement('textarea');
                textarea.value = value;
                textarea.style.position = 'fixed';
                textarea.style.left = '-9999px';
                document.body.appendChild(textarea);
                textarea.focus();
                textarea.select();
                document.execCommand('copy');
                textarea.remove();
            } catch (_) {
                // ignore copy failures
            }
        }
    };

    const handleAction = async (action, bubble) => {
        const text = getBubbleText(bubble);
        if (action === 'copy') {
            await copyText(text);
            return;
        }
        if (action === 'insert') {
            if (text) {
                composer.setValue(text);
                composer.focus();
            }
            return;
        }
    };

    const LONG_PRESS_DURATION_MS = 430;
    const LONG_PRESS_MOVE_TOLERANCE = 10;
    let longPressTimerId = null;
    let longPressBubble = null;
    let longPressStartX = 0;
    let longPressStartY = 0;
    let suppressNextBubbleClick = false;
    let visibleMenuBubble = null;

    const clearLongPressTimer = () => {
        if (longPressTimerId) {
            window.clearTimeout(longPressTimerId);
            longPressTimerId = null;
        }
        longPressBubble = null;
    };

    const hideVisibleMenu = () => {
        if (!visibleMenuBubble) {
            return;
        }
        const menu = visibleMenuBubble.querySelector('.wa-context-menu');
        if (menu) {
            delete menu.dataset.align;
        }
        visibleMenuBubble.classList.remove('wa-context-menu-visible');
        visibleMenuBubble = null;
    };

    const updateMenuPlacement = (bubble) => {
        if (!bubble) {
            return;
        }
        const menu = bubble.querySelector('.wa-context-menu');
        if (!menu) {
            return;
        }

        delete menu.dataset.align;
        const viewportWidth = window.innerWidth || document.documentElement?.clientWidth || 0;
        if (!viewportWidth) {
            return;
        }

        const rect = menu.getBoundingClientRect();
        const edgePadding = 10;
        if (rect.left < edgePadding) {
            menu.dataset.align = 'left';
            return;
        }
        if (rect.right > viewportWidth - edgePadding) {
            menu.dataset.align = 'right';
        }
    };

    const scheduleMenuPlacement = (bubble) => {
        if (!bubble) {
            return;
        }
        const run = () => updateMenuPlacement(bubble);
        if (typeof window.requestAnimationFrame === 'function') {
            window.requestAnimationFrame(run);
        } else {
            window.setTimeout(run, 0);
        }
    };

    const showMenuForBubble = (bubble) => {
        if (!bubble) {
            return;
        }
        if (visibleMenuBubble && visibleMenuBubble !== bubble) {
            visibleMenuBubble.classList.remove('wa-context-menu-visible');
        }
        bubble.classList.add('wa-context-menu-visible');
        visibleMenuBubble = bubble;
        scheduleMenuPlacement(bubble);
    };

    const bindLongPressMenu = (bubble) => {
        if (!bubble || bubble.dataset.longPressMenuBound === 'true') {
            return;
        }
        bubble.dataset.longPressMenuBound = 'true';

        bubble.addEventListener('pointerdown', (event) => {
            if (event.pointerType !== 'touch' && event.pointerType !== 'pen') {
                return;
            }
            if (event.button !== 0) {
                return;
            }
            if (event.target?.closest('.wa-context-menu')) {
                return;
            }

            clearLongPressTimer();
            longPressBubble = bubble;
            longPressStartX = Number.isFinite(event.clientX) ? event.clientX : 0;
            longPressStartY = Number.isFinite(event.clientY) ? event.clientY : 0;

            longPressTimerId = window.setTimeout(() => {
                longPressTimerId = null;
                suppressNextBubbleClick = true;
                showMenuForBubble(bubble);
            }, LONG_PRESS_DURATION_MS);
        });

        bubble.addEventListener('pointermove', (event) => {
            if (!longPressTimerId || longPressBubble !== bubble) {
                return;
            }
            const currentX = Number.isFinite(event.clientX) ? event.clientX : 0;
            const currentY = Number.isFinite(event.clientY) ? event.clientY : 0;
            const movedX = Math.abs(currentX - longPressStartX);
            const movedY = Math.abs(currentY - longPressStartY);
            if (movedX > LONG_PRESS_MOVE_TOLERANCE || movedY > LONG_PRESS_MOVE_TOLERANCE) {
                clearLongPressTimer();
            }
        });

        bubble.addEventListener('pointerup', () => {
            clearLongPressTimer();
        });

        bubble.addEventListener('pointercancel', () => {
            clearLongPressTimer();
        });

        bubble.addEventListener('contextmenu', (event) => {
            if (window.matchMedia('(hover: none), (pointer: coarse)').matches) {
                event.preventDefault();
            }
        });

        bubble.addEventListener('click', (event) => {
            if (!suppressNextBubbleClick) {
                return;
            }
            suppressNextBubbleClick = false;
            event.preventDefault();
            event.stopPropagation();
        });

        bubble.addEventListener('mouseenter', () => {
            scheduleMenuPlacement(bubble);
        });

        bubble.addEventListener('focusin', () => {
            scheduleMenuPlacement(bubble);
        });
    };

    const attachMenuToBubble = (bubble) => {
        if (!bubble) {
            return;
        }
        const message = bubble.closest('.wa-message');
        if (message && message.classList.contains('wa-typing')) {
            return;
        }

        let menu = bubble.querySelector('.wa-context-menu');
        if (!menu) {
            menu = document.createElement('div');
            menu.className = 'wa-context-menu wa-context-menu-compact';
            menu.innerHTML = `
                <button type="button" data-action="copy" title="Copy">Copy</button>
                <button type="button" data-action="insert" title="Insert into prompt">Insert</button>
            `;
            menu.addEventListener('click', (event) => {
                const btn = event.target?.closest('button[data-action]');
                if (!btn) {
                    return;
                }
                const action = btn.dataset.action;
                void handleAction(action, bubble);
                hideVisibleMenu();
            });
            bubble.appendChild(menu);
        }

        bindLongPressMenu(bubble);
    };

    document.addEventListener('pointerdown', (event) => {
        if (!visibleMenuBubble) {
            return;
        }
        const target = event.target;
        if (!(target instanceof Element)) {
            hideVisibleMenu();
            return;
        }
        if (target.closest('.wa-context-menu')) {
            return;
        }
        if (target.closest('.wa-message-bubble') === visibleMenuBubble) {
            return;
        }
        hideVisibleMenu();
    }, true);

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            hideVisibleMenu();
        }
    });

    window.addEventListener('resize', () => {
        if (visibleMenuBubble) {
            updateMenuPlacement(visibleMenuBubble);
        }
    });

    chatList.addEventListener('scroll', () => {
        hideVisibleMenu();
    }, { passive: true });

    const attachToExisting = () => {
        const bubbles = chatList.querySelectorAll('.wa-message-bubble');
        bubbles.forEach((bubble) => attachMenuToBubble(bubble));
    };

    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            mutation.addedNodes?.forEach((node) => {
                if (!(node instanceof Element)) {
                    return;
                }
                if (node.classList.contains('wa-message-bubble')) {
                    attachMenuToBubble(node);
                    return;
                }
                const nested = node.querySelectorAll?.('.wa-message-bubble');
                if (nested && nested.length) {
                    nested.forEach((bubble) => attachMenuToBubble(bubble));
                }
            });
        }
    });

    attachToExisting();
    observer.observe(chatList, { childList: true, subtree: true });
}

refocusComposerAfterIcon(attachmentBtn);
refocusComposerAfterIcon(settingsBtn);
initMessageToolbar();

function resolveLogoutRedirect(payload) {
    const redirect = typeof payload?.redirect === 'string' ? payload.redirect.trim() : '';
    if (redirect) {
        return redirect;
    }
    return basePath ? `${basePath}/` : '/webchat/';
}

async function handleLogout() {
    if (!logoutBtn) {
        return;
    }
    logoutBtn.setAttribute('aria-disabled', 'true');
    try {
        const response = await fetch(toEndpoint('logout'), {
            method: 'POST',
            credentials: 'include'
        });
        const payload = await response.json().catch(() => ({}));
        network.stop();
        window.location.href = resolveLogoutRedirect(payload);
    } catch (_) {
        network.stop();
        window.location.href = basePath ? `${basePath}/` : '/webchat/';
    } finally {
        logoutBtn.removeAttribute('aria-disabled');
    }
}

if (logoutBtn) {
    logoutBtn.addEventListener('click', handleLogout);
}

composer.setSendHandler((cmdText) => {
    const cmd = cmdText.trim();
    const fileSelections = uploader.getSelectedFiles();
    autocompleteState.pruneByText(cmdText || '');
    const references = autocompleteState.snapshot();

    if (fileSelections.length) {
        network.sendAttachments(fileSelections, cmd, { references });
        uploader.clearFiles();
        autocompleteState.clear();
        mentionHighlighter.clear();
        return true;
    }

    if (cmd) {
        network.sendCommand(cmd, { references });
        autocompleteState.clear();
        mentionHighlighter.clear();
        return true;
    }

    return false;
});

composer.setCancelHandler(() => {
    network.sendControl('\x1b');
});

messages.setQuickCommandHandler((command) => {
    if (!command || typeof command !== 'string') {
        return false;
    }
    // Route quick actions through the same path as user typing + Send.
    composer.setValue(command);
    return composer.submit();
});

const isEditableTarget = (target) => {
    if (!target) {
        return false;
    }
    if (target.isContentEditable) {
        return true;
    }
    const tag = target.tagName;
    if (!tag) {
        return false;
    }
    return EDITABLE_TAGS.includes(tag);
};

document.addEventListener('keydown', (event) => {
    if (!composer || !cmdInput) {
        return;
    }
    if (event.defaultPrevented) {
        return;
    }
    if (document.activeElement === cmdInput) {
        return;
    }
    const activeEl = document.activeElement;
    if (isEditableTarget(activeEl) && activeEl !== cmdInput) {
        return;
    }
    if (isEditableTarget(event.target) && event.target !== cmdInput) {
        return;
    }
    const handled = typeof composer.typeFromKeyEvent === 'function'
        ? composer.typeFromKeyEvent(event)
        : false;
    if (handled) {
        event.preventDefault();
    }
});

(async () => {
    try {
        await sessionController.bootstrap();
    } catch (error) {
        showBanner(`Session initialization failed: ${error.message}`, 'err');
        return;
    }
    composerAutocomplete.refresh();
    network.start();
})();
