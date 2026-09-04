const PROCESS_PREFIX_RE = /^(?:\s*\.+\s*){3,}/;
const ENVELOPE_FLAG = '__webchatMessage';
const PROGRESS_FLAG = '__webchatProgress';
const ENVELOPE_VERSION = 1;
const MAX_STREAM_RECONNECT_ATTEMPTS = 6;
const STABLE_STREAM_MS = 30000;
const BROWSER_CSRF_HEADER = 'x-ploinky-browser-csrf-token';
const BROWSER_MUTATION_RETRY_ERRORS = new Set([
    'browser_csrf_invalid',
    'edge_generation_changed',
]);
const BROWSER_MUTATION_RETRY_DELAYS_MS = Object.freeze([
    100,
    250,
    500,
    1000,
    1500,
    2000,
    2500,
    3000,
    3000,
]);

export const __testables = {};

function waitForRetry(delayMs) {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function browserMutationError(message, code = '') {
    const error = new Error(message);
    error.code = String(code || '').toLowerCase();
    return error;
}

async function loadBrowserMutationProof(agentName, {
    fetchImpl = globalThis.fetch,
    locationRef = globalThis.location,
} = {}) {
    const routeKey = String(agentName || '').trim();
    if (!routeKey) throw browserMutationError('agent route key is required');
    if (typeof fetchImpl !== 'function') {
        throw browserMutationError('browser mutation proof transport is unavailable');
    }
    const proofUrl = new URL('/auth/token', locationRef?.href || locationRef?.origin);
    proofUrl.searchParams.set('mutationRoute', routeKey);
    const response = await fetchImpl(proofUrl.toString(), {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        headers: { accept: 'application/json' },
    });
    const payload = await response.json().catch(() => ({}));
    const failureCode = String(payload?.error || '').toLowerCase();
    if (!response.ok) {
        throw browserMutationError(
            `browser mutation proof unavailable for ${routeKey}`,
            failureCode,
        );
    }
    const proof = payload?.browserMutation;
    if (!proof?.csrfToken
        || proof.routeKey !== routeKey
        || proof.origin !== locationRef?.origin) {
        throw browserMutationError(`browser mutation proof unavailable for ${routeKey}`);
    }
    return proof.csrfToken;
}

async function readMutationFailureCode(response) {
    if (![403, 503].includes(response?.status)) return '';
    const payload = await response.clone().json().catch(() => null);
    return String(payload?.error || '').toLowerCase();
}

export async function fetchWithBrowserMutationProof(
    agentName,
    endpoint,
    options = {},
    {
        fetchImpl = globalThis.fetch,
        locationRef = globalThis.location,
        wait = waitForRetry,
        retryDelays = BROWSER_MUTATION_RETRY_DELAYS_MS,
    } = {},
) {
    const delays = Array.isArray(retryDelays) ? retryDelays : [];
    for (let attempt = 0; attempt <= delays.length; attempt += 1) {
        if (attempt > 0) await wait(delays[attempt - 1]);
        let csrfToken;
        try {
            csrfToken = await loadBrowserMutationProof(agentName, {
                fetchImpl,
                locationRef,
            });
        } catch (error) {
            if (attempt < delays.length && BROWSER_MUTATION_RETRY_ERRORS.has(error?.code)) {
                continue;
            }
            throw error;
        }
        const headers = new Headers(options.headers || {});
        headers.set(BROWSER_CSRF_HEADER, csrfToken);
        const response = await fetchImpl(endpoint, {
            ...options,
            headers,
            credentials: 'include',
        });
        const failureCode = await readMutationFailureCode(response);
        if (attempt < delays.length && BROWSER_MUTATION_RETRY_ERRORS.has(failureCode)) {
            continue;
        }
        return response;
    }
    throw browserMutationError('browser mutation request exhausted its retry budget');
}

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

export function parseWorkspaceFilesPayload(text) {
    try {
        const payload = typeof text === 'string' ? JSON.parse(text) : text;
        const indexVersion = Number(payload?.indexVersion);
        if (!Number.isSafeInteger(indexVersion) || indexVersion < 1) return null;
        if (payload.reset === true && Array.isArray(payload.files)) {
            return { indexVersion, reset: true, files: payload.files };
        }
        if (payload.reset === false && Array.isArray(payload.added) && Array.isArray(payload.removed)) {
            return {
                indexVersion,
                reset: false,
                added: payload.added,
                removed: payload.removed,
            };
        }
        return null;
    } catch (_) {
        return null;
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
        const input = payload.input && typeof payload.input === 'object' ? payload.input : null;
        if (!id || !kind || !title || (options.length === 0 && !input)) return null;
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

function interactionTargetsTab(interaction, tabId, pageInstanceId = '') {
    const target = typeof interaction?.targetTabId === 'string' ? interaction.targetTabId : '';
    const targetPage = typeof interaction?.targetPageInstanceId === 'string'
        ? interaction.targetPageInstanceId
        : '';
    return (!target || target === tabId) && (!targetPage || targetPage === pageInstanceId);
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
    interactionTargetsTab,
    resolvesVisibleTaskCommand,
});

export { serializeEnvelope, normalizeClientReference, interactionTargetsTab };

export function createNetwork({
    TAB_ID,
    PAGE_INSTANCE_ID,
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
    onSkillsState,
    onRuntimeState,
    onWorkspaceFiles,
    onInteractionRequest,
    onInteractionResolved,
    onInputReadinessChange,
    onConnected
}) {
    let es = null;
    let chatBuffer = '';
    let pendingUserPrompt = '';
    let pendingVisibleCommand = '';
    let reconnectAttempts = 0;
    let reconnectTimer = null;
    let stableTimer = null;
    let bannerTimer = null;
    let stopped = false;
    let pendingUploads = 0;
    let assistantMessageIndex = null;
    let pendingPageInteractionId = '';
    let inputReady = false;
    let activeInteractionId = '';
    const uploadedSelections = new WeakMap();

    function setInputReady(ready) {
        inputReady = ready === true;
        if (typeof onInputReadinessChange === 'function') onInputReadinessChange(inputReady);
    }

    const canSendInput = () => inputReady && !activeInteractionId;

    const runtimePath = (path) => `${path}${path.includes('?') ? '&' : '?'}pageInstanceId=${encodeURIComponent(PAGE_INSTANCE_ID || '')}`;

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

    function setConnectionStatus(status, online = false) {
        if (statusEl) statusEl.textContent = status;
        if (statusDot) {
            statusDot.classList.remove(online ? 'offline' : 'online');
            statusDot.classList.add(online ? 'online' : 'offline');
        }
    }

    function clearConnectionTimers() {
        for (const timer of [reconnectTimer, stableTimer, bannerTimer]) {
            if (timer !== null) clearTimeout(timer);
        }
        reconnectTimer = stableTimer = bannerTimer = null;
    }

    function terminalConnection(message) {
        stop();
        hideTypingIndicator(true);
        setConnectionStatus('offline');
        showBanner(message, 'err');
    }

    function start({ reconnecting = false } = {}) {
        clearConnectionTimers();
        if (!reconnecting) reconnectAttempts = 0;
        stopped = false;
        setInputReady(false);
        dlog('SSE connecting');
        setConnectionStatus('connecting');
        showBanner('Connecting…');
        try {
            es?.close?.();
        } catch (_) {
            // Ignore close failures
        }

        const source = new EventSource(toEndpoint(runtimePath(`stream?tabId=${encodeURIComponent(TAB_ID)}`)));
        es = source;
        let runtimeReady = false;
        const isCurrent = () => !stopped && es === source;

        es.onopen = () => {
            if (!isCurrent()) return;
            runtimeReady = false;
            setInputReady(false);
            setConnectionStatus('starting');
            showBanner('Starting agent…');
        };

        es.onerror = () => {
            if (!isCurrent()) return;
            setInputReady(false);
            hideTypingIndicator(true);
            setConnectionStatus('offline');
            try {
                source.close();
            } catch (_) {
                // Ignore close failures
            }
            es = null;
            clearConnectionTimers();
            if (reconnectAttempts >= MAX_STREAM_RECONNECT_ATTEMPTS) {
                terminalConnection('Unable to reconnect. Reload to retry.');
                return;
            }
            reconnectAttempts++;
            const baseDelay = 1000; // 1 second
            const maxDelay = 60000; // 60 seconds max
            const delay = Math.min(baseDelay * Math.pow(2, reconnectAttempts - 1), maxDelay);

            // Add jitter to prevent thundering herd
            const jitter = Math.random() * 1000;
            const totalDelay = delay + jitter;

            showBanner(`Reconnecting in ${Math.ceil(totalDelay / 1000)}s (attempt ${reconnectAttempts}/${MAX_STREAM_RECONNECT_ATTEMPTS})…`);

            dlog(`SSE reconnect scheduled in ${Math.ceil(totalDelay)}ms (attempt ${reconnectAttempts})`);

            reconnectTimer = setTimeout(() => {
                reconnectTimer = null;
                try {
                    start({ reconnecting: true });
                } catch (error) {
                    dlog('SSE restart error', error);
                }
            }, totalDelay);
        };

        es.onmessage = (event) => {
            if (!isCurrent()) return;
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

        es.addEventListener('startup-state', (event) => {
            if (!isCurrent()) return;
            let state;
            try { state = JSON.parse(event.data)?.state; } catch (_) { return; }
            if (state === 'starting') {
                runtimeReady = false;
                setInputReady(false);
                clearConnectionTimers();
                setConnectionStatus('starting');
                showBanner('Starting agent…');
                return;
            }
            if (state === 'failed') {
                terminalConnection('Agent startup failed. Reload to retry.');
                return;
            }
            if (state !== 'ready' || runtimeReady) return;
            runtimeReady = true;
            setInputReady(true);
            hideTypingIndicator(true);
            setConnectionStatus('online', true);
            showBanner('Connected', 'ok');
            bannerTimer = setTimeout(() => {
                bannerTimer = null;
                if (isCurrent()) hideBanner();
            }, 800);
            // Briefly opening a transport (or a crashing CLI) cannot replenish
            // the retry budget. Only a sustained ready runtime does so.
            stableTimer = setTimeout(() => {
                stableTimer = null;
                if (isCurrent()) reconnectAttempts = 0;
            }, STABLE_STREAM_MS);
            if (typeof onConnected === 'function') onConnected();
        });

        es.addEventListener('close', (event) => {
            if (!isCurrent()) return;
            let failed = !runtimeReady;
            try { failed = failed || JSON.parse(event.data)?.state === 'failed'; } catch (_) { }
            terminalConnection(failed
                ? 'Agent startup failed. Reload to retry.'
                : 'Agent session closed. Reload to reconnect.');
        });

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

        es.addEventListener('skills-state', (event) => {
            try {
                const payload = JSON.parse(event.data);
                if (typeof onSkillsState === 'function') onSkillsState(payload);
            } catch (error) {
                dlog('skills state error', error);
            }
        });

        es.addEventListener('runtime-state', (event) => {
            const runtimeState = parseRuntimeStatePayload(event.data);
            if (runtimeState !== undefined && typeof onRuntimeState === 'function') {
                onRuntimeState(runtimeState);
            }
        });

        es.addEventListener('workspace-files', (event) => {
            const update = parseWorkspaceFilesPayload(event.data);
            if (update && typeof onWorkspaceFiles === 'function') {
                onWorkspaceFiles(update);
            }
        });

        es.addEventListener('interaction-request', (event) => {
            if (!isCurrent()) return;
            const interaction = parseInteractionPayload(event.data);
            if (!interactionTargetsTab(interaction, TAB_ID, PAGE_INSTANCE_ID)) return;
            if (interaction && !interaction.targetTaskId) activeInteractionId = interaction.id;
            if (interaction?.targetPageInstanceId === PAGE_INSTANCE_ID) {
                pendingPageInteractionId = interaction.id;
            }
            if (interaction && typeof onInteractionRequest === 'function') {
                onInteractionRequest(interaction);
            }
        });

        es.addEventListener('interaction-resolved', (event) => {
            if (!isCurrent()) return;
            const resolution = parseInteractionResolutionPayload(event.data);
            if (resolution?.id === activeInteractionId) activeInteractionId = '';
            if (resolution?.id === pendingPageInteractionId) pendingPageInteractionId = '';
            if (resolution && typeof onInteractionResolved === 'function') {
                onInteractionResolved(resolution);
            }
        });

    }

    function stop() {
        stopped = true;
        setInputReady(false);
        clearConnectionTimers();
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

    async function postEnvelope(payload = {}, { silent = false } = {}) {
        if (!canSendInput()) return false;
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

        const inputSource = es;
        const send = () => fetchWithBrowserMutationProof(
            agentName,
            toEndpoint(runtimePath(`input?tabId=${encodeURIComponent(TAB_ID)}`)),
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: `${serialized}\n`,
            },
            {
                fetchImpl: (url, options) => {
                    if (options?.method === 'POST' && (!canSendInput() || es !== inputSource)) {
                        throw new Error('input_not_ready');
                    }
                    return fetch(url, options);
                },
            },
        );
        return send().then((response) => {
            // Admission conflicts are authoritative, not a timer-based startup
            // signal. Never retry an input blindly or treat a rejected retry
            // as accepted; readiness arrives on the current runtime stream.
            if (!response.ok) throw new Error(`input_failed_${response.status}`);
            return response;
        }).catch((error) => {
            dlog('chat error', error);
            pendingUserPrompt = '';
            if (!silent) pendingVisibleCommand = '';
            if (pendingUploads === 0) {
                hideTypingIndicator(true);
            }
            addServerMsg('[input error]');
            showBanner('Chat error', 'err');
            throw error;
        });
    }

    async function sendCommand(cmd, options = {}) {
        if (!canSendInput()) return false;
        const message = typeof cmd === 'string' ? cmd : '';
        const references = Array.isArray(options?.references) ? options.references : [];
        const pendingMessage = addClientMsg(message, { references, pending: true });
        let accepted = false;
        if (pendingUploads === 0) {
            showTypingIndicator();
        }
        try {
            if (!await postEnvelope({ text: message, references })) return false;
            accepted = true;
            pendingMessage?.markSent?.();
            return true;
        } catch (_) {
            return false;
        } finally {
            if (!accepted) pendingMessage?.remove?.();
        }
    }

    function sendQuickCommand(cmd) {
        const message = typeof cmd === 'string' ? cmd : '';
        if (!message.trim() || !canSendInput()) {
            return false;
        }
        return postEnvelope({ text: message }, { silent: true })
            .then((response) => Boolean(response)).catch(() => false);
    }

    async function sendQuickCommands(commands) {
        if (!Array.isArray(commands) || commands.length === 0
            || commands.some((command) => typeof command !== 'string' || !command.trim())) {
            return false;
        }
        try {
            for (const command of commands) {
                if (!await postEnvelope({ text: command }, { silent: true })) return false;
            }
            return true;
        } catch (_) {
            return false;
        }
    }

    function uploadAttachment(filePayload) {
        const {
            file,
            relativePath,
            destinationPath,
            overwrite,
        } = filePayload || {};
        const isFileObject = (typeof File !== 'undefined' && file instanceof File)
            || (file && typeof file.name === 'string' && typeof file.size !== 'undefined');
        if (!isFileObject) {
            addServerMsg('[upload error: no file selected]');
            return Promise.reject(new Error('no file selected'));
        }

        const selectionKey = filePayload.selectionId || file;
        if (uploadedSelections.has(selectionKey)) {
            return Promise.resolve(uploadedSelections.get(selectionKey));
        }

        const effectiveRelativePath = typeof relativePath === 'string' && relativePath.trim()
            ? relativePath.trim()
            : (file.name || '');
        const normalizedDestination = typeof destinationPath === 'string'
            ? destinationPath.trim().replace(/^\/+|\/+$/g, '')
            : '';
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
                const localPath = data.localPath || data.workspacePath || data.url || null;
                if (!localPath) {
                    throw new Error(data.error || 'Invalid upload response');
                }
                const displayName = data.filename || file.name;
                const downloadHref = typeof data.downloadUrl === 'string' && data.downloadUrl
                    ? data.downloadUrl
                    : (localPath.startsWith('/') ? localPath : `/${localPath}`);
                const absoluteUrl = new URL(downloadHref, window.location.origin).href;
                const attachment = {
                    id: data.id ?? null,
                    filename: displayName || null,
                    mime: data.mime ?? file.type ?? null,
                    size: data.size ?? (Number.isFinite(file.size) ? file.size : null),
                    downloadUrl: absoluteUrl || null,
                    localPath,
                    workspacePath: data.workspacePath ?? null,
                    relativePath: data.relativePath ?? null,
                };
                // A successful upload is not yet an accepted chat message.
                // Retain it with the draft so a rejected input can be retried
                // without overwriting or uploading the same file again.
                uploadedSelections.set(selectionKey, attachment);
                return attachment;
            })
            .catch(error => {
                dlog('upload error', error);
                addServerMsg(`[upload error: ${error.message}]`);
                showBanner('Upload error', 'err');
                throw error;
            }).finally(trackUploadEnd);
    }

    async function sendAttachments(fileSelections, caption, options = {}) {
        const selections = Array.isArray(fileSelections) ? fileSelections : [];
        const text = typeof caption === 'string' ? caption : '';
        const references = Array.isArray(options?.references) ? options.references : [];

        if (!selections.length) {
            return text.trim() ? sendCommand(text, { references }) : false;
        }

        const inputSource = es;
        const pendingMessages = [];
        let accepted = false;
        try {
            if (!canSendInput()) return false;
            const results = await Promise.allSettled(selections.map((selection) => uploadAttachment(selection)));
            if (results.some((result) => result.status !== 'fulfilled')) return false;
            if (!canSendInput() || es !== inputSource) return false;
            const attachments = results.map((result) => result.value);
            attachments.forEach((attachment, index) => {
                const selection = selections[index];
                const clientAttachment = addClientAttachment?.({
                    fileName: attachment.localPath || attachment.filename,
                    size: attachment.size,
                    mime: attachment.mime,
                    previewUrl: attachment.downloadUrl,
                    isImage: selection.isImage,
                    caption: index === 0 ? text : '',
                    pending: true,
                });
                pendingMessages.push(clientAttachment || addClientMsg(
                    index === 0 ? text || attachment.filename : attachment.filename,
                    { references, pending: true },
                ));
            });
            showTypingIndicator();
            if (!await postEnvelope({ text, attachments, references })) return false;
            accepted = true;
            attachments.forEach((attachment, index) => {
                pendingMessages[index]?.markUploaded?.(attachment);
                pendingMessages[index]?.markSent?.();
                const selection = selections[index];
                uploadedSelections.delete(selection.selectionId || selection.file);
            });
            return true;
        } catch (_) {
            // Upload and input transports already report their exact error.
            return false;
        } finally {
            if (!accepted) pendingMessages.forEach((message) => message?.remove?.());
            for (const selection of selections) {
                if (selection.previewNeedsRevoke) selection.revokePreview?.();
            }
        }
    }

    function sendControl(controlSeq) {
        if (!inputReady) return Promise.resolve(false);
        return fetch(toEndpoint(runtimePath(`control?tabId=${encodeURIComponent(TAB_ID)}`)), {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: controlSeq
        }).catch((error) => {
            dlog('control send error', error);
        });
    }

    function sendInteractionResponse(interactionId, optionId = null, responseValue = null) {
        return fetch(toEndpoint(runtimePath(`interaction?tabId=${encodeURIComponent(TAB_ID)}`)), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                interactionId,
                ...(typeof responseValue === 'string' ? { response: responseValue } : { optionId }),
            }),
            credentials: 'include'
        }).then((response) => {
            if (!response.ok) throw new Error(`interaction_failed_${response.status}`);
            return response;
        }).catch((error) => {
            dlog('interaction response error', error);
            showBanner('Interaction response failed', 'err');
            throw error;
        });
    }

    function sendInteractionCancel(interactionId, { keepalive = false, silent = false } = {}) {
        if (!interactionId) return Promise.resolve(null);
        return fetch(toEndpoint(runtimePath(`interaction?tabId=${encodeURIComponent(TAB_ID)}`)), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ interactionId, cancelled: true }),
            credentials: 'include',
            keepalive,
        }).then((response) => {
            if (!response.ok) throw new Error(`interaction_cancel_failed_${response.status}`);
            if (pendingPageInteractionId === interactionId) pendingPageInteractionId = '';
            return response;
        }).catch((error) => {
            dlog('interaction cancel error', error);
            if (!silent) showBanner('Interaction cancellation failed', 'err');
            throw error;
        });
    }

    globalThis.addEventListener?.('pagehide', (event) => {
        if (event?.persisted === true || !pendingPageInteractionId) return;
        void sendInteractionCancel(pendingPageInteractionId, { keepalive: true, silent: true }).catch(() => {});
    });

    return {
        start,
        stop,
        sendCommand,
        sendQuickCommand,
        sendQuickCommands,
        sendAttachments,
        sendControl,
        sendInteractionResponse,
        sendInteractionCancel
    };
}
