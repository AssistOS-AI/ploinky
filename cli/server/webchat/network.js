const PROCESS_PREFIX_RE = /^(?:\s*\.+\s*){3,}/;
const ENVELOPE_FLAG = '__webchatMessage';
const PROGRESS_FLAG = '__webchatProgress';
const ENVELOPE_VERSION = 1;

export const __testables = {};

export function buildAttachmentUploadHeaders({ file, relativePath, destinationPath, overwrite } = {}) {
    const mime = file?.type || 'application/octet-stream';
    const headers = {
        'Content-Type': mime,
        'X-Mime-Type': mime,
        'X-File-Name': encodeURIComponent(file?.name || ''),
        'X-Destination-Path': encodeURIComponent(String(destinationPath || '').replace(/^\/+|\/+$/g, '')),
    };
    if (relativePath) headers['X-Relative-Path'] = encodeURIComponent(relativePath);
    if (overwrite === true) headers['X-Overwrite'] = '1';
    return headers;
}

function stripCtrlAndAnsi(input) {
    try {
        let out = input || '';
        out = out.replace(/\u001b\][^\u0007\u001b]*?(?:\u0007|\u001b\\)/g, '');
        out = out.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
        out = out.replace(/[\u0000-\u0008\u000B-\u001A\u001C-\u001F]/g, '');
        return out;
    } catch (_) {
        return input;
    }
}

function isProcessingChunk(text) {
    if (!text) {
        return false;
    }
    const trimmed = text.replace(/\s/g, '');
    if (trimmed.length === 0 || !/^[.·…]+$/.test(trimmed)) {
        return false;
    }
    const hasWhitespace = /\s/.test(text);
    return hasWhitespace || trimmed.length > 3;
}

function stripProcessingPrefix(text) {
    if (!text) {
        return text;
    }
    const match = PROCESS_PREFIX_RE.exec(text);
    if (!match) {
        return text;
    }
    if (match[0].length >= text.length) {
        return '';
    }
    return text.slice(match[0].length);
}

function normalizeClientReference(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const kind = typeof raw.kind === 'string' ? raw.kind.trim() : '';
    const refPath = typeof raw.path === 'string' ? raw.path.trim() : '';
    if (!kind || !refPath) return null;
    if (refPath.includes('\0')) return null;
    return {
        kind,
        path: refPath,
        type: typeof raw.type === 'string' ? raw.type.trim() : null,
        label: typeof raw.label === 'string' ? raw.label.trim() : null
    };
}

function serializeEnvelope({ text = '', attachments = [], references = [], visible = true } = {}) {
    const normalizedAttachments = Array.isArray(attachments)
        ? attachments.map((raw) => {
            if (!raw || typeof raw !== 'object') {
                return null;
            }
            const record = {
                id: typeof raw.id === 'string' ? raw.id : null,
                filename: typeof raw.filename === 'string' ? raw.filename : null,
                mime: typeof raw.mime === 'string' ? raw.mime : null,
                size: Number.isFinite(raw.size) ? raw.size : null,
                downloadUrl: typeof raw.downloadUrl === 'string' ? raw.downloadUrl : null,
                localPath: typeof raw.localPath === 'string' ? raw.localPath : null
            };
            const hasValue = Object.values(record).some((value) => value !== null);
            return hasValue ? record : null;
        }).filter(Boolean)
        : [];

    const normalizedReferences = Array.isArray(references)
        ? references.map(normalizeClientReference).filter(Boolean)
        : [];

    const payload = {
        [ENVELOPE_FLAG]: ENVELOPE_VERSION,
        version: ENVELOPE_VERSION,
        text: typeof text === 'string' ? text : '',
        attachments: normalizedAttachments,
        presentation: { visible: visible !== false },
    };
    if (normalizedReferences.length) {
        payload.references = normalizedReferences;
    }
    return JSON.stringify(payload);
}

function parseProgressEnvelope(text) {
    const normalized = String(text || '').trim();
    if (!normalized || !normalized.includes(`"${PROGRESS_FLAG}"`)) {
        return null;
    }
    try {
        const payload = JSON.parse(normalized);
        if (!payload || !payload[PROGRESS_FLAG]) {
            return null;
        }
        return {
            type: typeof payload.type === 'string' ? payload.type : '',
            tool: typeof payload.tool === 'string' ? payload.tool : '',
            reason: typeof payload.reason === 'string' ? payload.reason : '',
            stepIndex: Number.isFinite(payload.stepIndex) ? payload.stepIndex : null
        };
    } catch (_) {
        return null;
    }
}

function parseRuntimeStatePayload(text) {
    try {
        const payload = typeof text === 'string' ? JSON.parse(text) : text;
        if (!payload || typeof payload !== 'object' || !Object.prototype.hasOwnProperty.call(payload, 'model')) {
            return undefined;
        }
        if (payload.model === null) return { model: null };
        if (typeof payload.model !== 'string') return undefined;
        const model = payload.model.trim();
        return model ? { model } : { model: null };
    } catch (_) {
        return undefined;
    }
}

function parseInteractionPayload(text) {
    try {
        const payload = typeof text === 'string' ? JSON.parse(text) : text;
        if (!payload || typeof payload !== 'object') return null;
        const id = typeof payload.id === 'string' ? payload.id.trim() : '';
        const kind = typeof payload.kind === 'string' ? payload.kind.trim() : '';
        const title = typeof payload.title === 'string' ? payload.title.trim() : '';
        const options = Array.isArray(payload.options)
            ? payload.options.filter((option) => option && typeof option.id === 'string' && typeof option.label === 'string')
            : [];
        if (!id || !kind || !title || options.length === 0) return null;
        return { ...payload, id, kind, title, options };
    } catch (_) {
        return null;
    }
}

function parseInteractionResolutionPayload(text) {
    try {
        const payload = typeof text === 'string' ? JSON.parse(text) : text;
        const id = typeof payload?.id === 'string' ? payload.id.trim() : '';
        return id ? { ...payload, id } : null;
    } catch (_) {
        return null;
    }
}

function resolvesVisibleTaskCommand(payload, command) {
    const normalizedCommand = typeof command === 'string' ? command.trim() : '';
    if (payload?.event === 'list') {
        return /^\/tasks(?:\s|$)/.test(normalizedCommand);
    }
    if (payload?.event === 'view') {
        return /^\/task\s+view(?:\s|$)/.test(normalizedCommand);
    }
    return false;
}

Object.assign(__testables, {
    serializeEnvelope,
    normalizeClientReference,
    parseProgressEnvelope,
    parseRuntimeStatePayload,
    parseInteractionPayload,
    parseInteractionResolutionPayload,
    resolvesVisibleTaskCommand,
});

export { serializeEnvelope, normalizeClientReference };

export function createNetwork({
    TAB_ID,
    toEndpoint,
    dlog,
    showBanner,
    hideBanner,
    statusEl,
    statusDot,
    agentName
}, {
    addClientMsg,
    addClientAttachment,
    addServerMsg,
    addProgressEvent,
    showTypingIndicator,
    hideTypingIndicator,
    markUserInputSent,
    addRemoteUserMessage,
    onSessionState,
    onTaskUpdate,
    onRuntimeState,
    onInteractionRequest,
    onInteractionResolved,
    onConnected
}) {
    let es = null;
    let chatBuffer = '';
    let pendingUserPrompt = '';
    let pendingVisibleCommand = '';
    let reconnectAttempts = 0;
    let reconnectTimer = null;
    let pendingUploads = 0;
    let assistantMessageIndex = null;

    function trackUploadStart() {
        pendingUploads += 1;
        showTypingIndicator();
    }

    function trackUploadEnd() {
        pendingUploads = Math.max(0, pendingUploads - 1);
        if (pendingUploads === 0) {
            hideTypingIndicator(true);
        }
    }

    function handleServerChunk(raw) {
        if (raw === undefined || raw === null) {
            return;
        }
        let text = String(raw);
        if (!text) {
            return;
        }

        if (isProcessingChunk(text)) {
            showTypingIndicator();
            return;
        }

        const stripped = stripProcessingPrefix(text);

        const normalized = stripped.trim();

        if (pendingUserPrompt && normalized.startsWith('you> ')
            && normalized.slice(5).trim() === pendingUserPrompt) {
            pendingUserPrompt = '';
            return;
        }

        const progress = parseProgressEnvelope(normalized);
        if (progress) {
            if (typeof addProgressEvent === 'function') {
                addProgressEvent(progress);
            } else {
                showTypingIndicator();
            }
            return;
        }

        // Check if this looks like an envelope echo - filter it out
        // Envelopes can start with { or [ or other characters depending on how they're echoed
        if (normalized.includes('"__webchatMessage"') &&
            normalized.includes('"version"') &&
            normalized.includes('"text"') &&
            normalized.includes('"attachments"')) {
            // This is an envelope echo - suppress it
            return;
        }

        if (stripped !== text) {
            showTypingIndicator();
        }
        if (!stripped.trim()) {
            return;
        }
        const displayed = addServerMsg(stripped, { messageIndex: assistantMessageIndex });
        if (displayed && pendingUploads === 0) {
            pendingVisibleCommand = '';
            hideTypingIndicator();
        }
    }

    function pushSrvFromBuffer() {
        if (!chatBuffer) {
            return;
        }
        const parts = chatBuffer.split(/\r?\n/);
        chatBuffer = parts.pop() ?? '';
        parts.forEach((part) => {
            const clean = stripCtrlAndAnsi(part);
            handleServerChunk(clean);
        });

        const tailClean = stripCtrlAndAnsi(chatBuffer);
        if (isProcessingChunk(tailClean)) {
            showTypingIndicator();
        }
    }

    function start() {
        dlog('SSE connecting');
        showBanner('Connecting…');
        try {
            es?.close?.();
        } catch (_) {
            // Ignore close failures
        }

        es = new EventSource(toEndpoint(`stream?tabId=${TAB_ID}`));

        es.onopen = () => {
            // Reset reconnect attempts on successful connection
            reconnectAttempts = 0;

            hideTypingIndicator(true);
            if (statusEl) {
                statusEl.textContent = 'online';
            }
            if (statusDot) {
                statusDot.classList.remove('offline');
                statusDot.classList.add('online');
            }
            showBanner('Connected', 'ok');
            setTimeout(() => hideBanner(), 800);
            if (typeof onConnected === 'function') onConnected();
        };

        es.onerror = () => {
            hideTypingIndicator(true);
            if (statusEl) {
                statusEl.textContent = 'offline';
            }
            if (statusDot) {
                statusDot.classList.remove('online');
                statusDot.classList.add('offline');
            }
            try {
                es.close();
            } catch (_) {
                // Ignore close failures
            }

            // Clear any pending reconnect timer
            if (reconnectTimer) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }

            // CRITICAL FIX: Exponential backoff to prevent reconnection storms
            reconnectAttempts++;
            const baseDelay = 1000; // 1 second
            const maxDelay = 60000; // 60 seconds max
            const delay = Math.min(baseDelay * Math.pow(2, reconnectAttempts - 1), maxDelay);

            // Add jitter to prevent thundering herd
            const jitter = Math.random() * 1000;
            const totalDelay = delay + jitter;

            if (reconnectAttempts > 1) {
                showBanner(`Reconnecting in ${Math.ceil(totalDelay / 1000)}s (attempt ${reconnectAttempts})...`);
            }

            dlog(`SSE reconnect scheduled in ${Math.ceil(totalDelay)}ms (attempt ${reconnectAttempts})`);

            reconnectTimer = setTimeout(() => {
                reconnectTimer = null;
                try {
                    start();
                } catch (error) {
                    dlog('SSE restart error', error);
                }
            }, totalDelay);
        };

        es.onmessage = (event) => {
            try {
                const payload = JSON.parse(event.data);
                if (typeof payload === 'string') {
                    chatBuffer += stripCtrlAndAnsi(payload);
                    pushSrvFromBuffer();
                    return;
                }
                if (payload && typeof payload === 'object' && typeof payload.text === 'string') {
                    handleServerChunk(stripCtrlAndAnsi(payload.text));
                }
            } catch (error) {
                dlog('term write error', error);
            }
        };

        es.addEventListener('user-message', (event) => {
            try {
                const payload = JSON.parse(event.data);
                const userMessageIndex = Number(payload?.messageIndex);
                assistantMessageIndex = Number.isInteger(userMessageIndex) ? userMessageIndex + 1 : null;
                if (payload?.sourceTabId !== TAB_ID && typeof addRemoteUserMessage === 'function') {
                    addRemoteUserMessage(payload.message, payload);
                }
            } catch (error) {
                dlog('remote user message error', error);
            }
        });

        es.addEventListener('session-state', (event) => {
            try {
                const payload = JSON.parse(event.data);
                if ((payload?.event === 'current' || payload?.event === 'selected')) {
                    assistantMessageIndex = null;
                }
                if (typeof onSessionState === 'function') onSessionState(payload);
            } catch (error) {
                dlog('session state error', error);
            }
        });

        es.addEventListener('task-update', (event) => {
            try {
                const payload = JSON.parse(event.data);
                const visibleCommand = resolvesVisibleTaskCommand(payload, pendingVisibleCommand)
                    ? pendingVisibleCommand
                    : '';
                if (visibleCommand) {
                    pendingVisibleCommand = '';
                    hideTypingIndicator(true);
                }
                if (typeof onTaskUpdate === 'function') {
                    onTaskUpdate(payload, { visibleCommand });
                }
            } catch (error) {
                dlog('task update error', error);
            }
        });

        es.addEventListener('runtime-state', (event) => {
            const runtimeState = parseRuntimeStatePayload(event.data);
            if (runtimeState !== undefined && typeof onRuntimeState === 'function') {
                onRuntimeState(runtimeState);
            }
        });

        es.addEventListener('interaction-request', (event) => {
            const interaction = parseInteractionPayload(event.data);
            if (interaction && typeof onInteractionRequest === 'function') {
                onInteractionRequest(interaction);
            }
        });

        es.addEventListener('interaction-resolved', (event) => {
            const resolution = parseInteractionResolutionPayload(event.data);
            if (resolution && typeof onInteractionResolved === 'function') {
                onInteractionResolved(resolution);
            }
        });

    }

    function stop() {
        // Clear reconnect timer
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        reconnectAttempts = 0;

        if (!es) {
            return;
        }
        try {
            es.close();
        } catch (_) {
            // Ignore close failures
        }
        es = null;
    }

    function postEnvelope(payload = {}, { silent = false } = {}) {
        const text = typeof payload.text === 'string' ? payload.text : '';
        const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
        const references = Array.isArray(payload.references) ? payload.references : [];
        const serialized = serializeEnvelope({
            text,
            attachments,
            references,
            visible: !silent,
        });
        const trimmedText = text.trim();
        pendingUserPrompt = trimmedText;
        if (!silent) {
            pendingVisibleCommand = trimmedText.startsWith('/') ? trimmedText : '';
        }

        if (!silent) markUserInputSent();

        const send = () => fetch(toEndpoint(`input?tabId=${TAB_ID}`), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: `${serialized}\n`,
            credentials: 'include'
        });
        return send().then((response) => {
            if (response.status === 409) {
                return new Promise((resolve) => setTimeout(resolve, 250)).then(send);
            }
            if (!response.ok) throw new Error(`input_failed_${response.status}`);
            return response;
        }).catch((error) => {
            dlog('chat error', error);
            if (!silent) pendingVisibleCommand = '';
            if (pendingUploads === 0) {
                hideTypingIndicator(true);
            }
            addServerMsg('[input error]');
            showBanner('Chat error', 'err');
            throw error;
        });
    }

    function sendCommand(cmd, options = {}) {
        const message = typeof cmd === 'string' ? cmd : '';
        const references = Array.isArray(options?.references) ? options.references : [];
        addClientMsg(message, { references });
        postEnvelope({ text: message, references });
        if (pendingUploads === 0) {
            showTypingIndicator();
        }
        return true;
    }

    function sendQuickCommand(cmd) {
        const message = typeof cmd === 'string' ? cmd : '';
        if (!message.trim()) {
            return false;
        }
        postEnvelope({ text: message }, { silent: true });
        return true;
    }

    function uploadAttachment(filePayload, caption) {
        const {
            file,
            previewUrl,
            revokePreview,
            previewNeedsRevoke,
            isImage,
            relativePath,
            destinationPath,
            overwrite,
        } = filePayload || {};
        const isFileObject = (typeof File !== 'undefined' && file instanceof File)
            || (file && typeof file.name === 'string' && typeof file.size !== 'undefined');
        if (!isFileObject) {
            if (typeof caption === 'string' && caption.trim()) {
                addClientMsg(caption);
            } else {
                addServerMsg('[upload error: no file selected]');
            }
            return Promise.reject(new Error('no file selected'));
        }

        const effectiveRelativePath = typeof relativePath === 'string' && relativePath.trim()
            ? relativePath.trim()
            : (file.name || '');
        const normalizedDestination = typeof destinationPath === 'string'
            ? destinationPath.trim().replace(/^\/+|\/+$/g, '')
            : '';
        const targetLocalPath = [normalizedDestination, effectiveRelativePath]
            .filter(Boolean)
            .join('/');

        let clientAttachment = null;
        if (typeof addClientAttachment === 'function') {
            clientAttachment = addClientAttachment({
                fileName: targetLocalPath || file.name,
                size: file.size,
                mime: file.type,
                previewUrl,
                isImage,
                caption,
            });
        } else {
            addClientMsg(caption || effectiveRelativePath || file.name);
        }
        trackUploadStart();

        const uploadUrl = toEndpoint('uploads');

        const headers = buildAttachmentUploadHeaders({
            file,
            relativePath: effectiveRelativePath,
            destinationPath: normalizedDestination,
            overwrite,
        });

        return fetch(uploadUrl, {
            method: 'POST',
            headers,
            body: file,
            credentials: 'include',
        })
            .then(res => {
                if (!res.ok) {
                    return res.text().then(text => {
                        let message = text || 'Upload failed';
                        try {
                            const payload = JSON.parse(text);
                            message = payload?.error || message;
                        } catch (_) {
                            // Keep the plain response body.
                        }
                        throw new Error(message);
                    });
                }
                return res.json();
            })
            .then(data => {
                trackUploadEnd();
                const localPath = data.localPath || data.workspacePath || data.url || null;
                if (!localPath) {
                    throw new Error(data.error || 'Invalid upload response');
                }
                const displayName = data.filename || file.name;
                const downloadHref = typeof data.downloadUrl === 'string' && data.downloadUrl
                    ? data.downloadUrl
                    : (localPath.startsWith('/') ? localPath : `/${localPath}`);
                const absoluteUrl = new URL(downloadHref, window.location.origin).href;
                if (clientAttachment && typeof clientAttachment.markUploaded === 'function') {
                    clientAttachment.markUploaded({
                        downloadUrl: absoluteUrl,
                        size: data.size ?? (Number.isFinite(file.size) ? file.size : null),
                        mime: data.mime ?? file.type ?? null,
                        localPath,
                        id: data.id ?? null,
                    });
                    if (isImage && typeof clientAttachment.replacePreview === 'function') {
                        clientAttachment.replacePreview(absoluteUrl);
                    }
                } else {
                    const linkLabel = displayName || absoluteUrl;
                    const infoMessageFallback = `File uploaded: [${linkLabel}](${absoluteUrl})`;
                    addServerMsg(infoMessageFallback);
                }
                if (previewNeedsRevoke && typeof revokePreview === 'function') {
                    revokePreview();
                }
                return {
                    id: data.id ?? null,
                    filename: displayName || null,
                    mime: data.mime ?? file.type ?? null,
                    size: data.size ?? (Number.isFinite(file.size) ? file.size : null),
                    downloadUrl: absoluteUrl || null,
                    localPath,
                    workspacePath: data.workspacePath ?? null,
                    relativePath: data.relativePath ?? null,
                };
            })
            .catch(error => {
                trackUploadEnd();
                dlog('upload error', error);
                if (clientAttachment && typeof clientAttachment.markFailed === 'function') {
                    clientAttachment.markFailed(error.message || 'Upload failed');
                } else {
                    addServerMsg(`[upload error: ${error.message}]`);
                }
                showBanner('Upload error', 'err');
                throw error;
            });
    }

    function sendAttachments(fileSelections, caption, options = {}) {
        const selections = Array.isArray(fileSelections) ? fileSelections : [];
        const text = typeof caption === 'string' ? caption : '';
        const references = Array.isArray(options?.references) ? options.references : [];

        if (!selections.length) {
            if (text.trim()) {
                sendCommand(text, { references });
            }
            return;
        }

        const uploads = selections.map((selection, index) => uploadAttachment(selection, index === 0 ? text : ''));

        Promise.allSettled(uploads).then((results) => {
            const attachments = [];
            let hasSuccess = false;

            results.forEach((result) => {
                if (result.status === 'fulfilled' && result.value) {
                    hasSuccess = true;
                    attachments.push(result.value);
                }
            });

            const trimmedText = text.trim();

            if (!hasSuccess && !trimmedText) {
                return;
            }

            postEnvelope({ text, attachments, references });
        }).catch(() => {
            // Individual upload rejections already handled with UI feedback.
        });
    }

    function sendControl(controlSeq) {
        return fetch(toEndpoint(`control?tabId=${TAB_ID}`), {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: controlSeq
        }).catch((error) => {
            dlog('control send error', error);
        });
    }

    function sendInteractionResponse(interactionId, optionId) {
        return fetch(toEndpoint(`interaction?tabId=${TAB_ID}`), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ interactionId, optionId }),
            credentials: 'include'
        }).then((response) => {
            if (!response.ok) throw new Error(`interaction_failed_${response.status}`);
            return response;
        }).catch((error) => {
            dlog('interaction response error', error);
            showBanner('Approval response failed', 'err');
            throw error;
        });
    }

    return {
        start,
        stop,
        sendCommand,
        sendQuickCommand,
        sendAttachments,
        sendControl,
        sendInteractionResponse
    };
}
