import { interactionTargetsTab, serializeEnvelope } from './network.js';

const RUNTIME_RETRY_DELAYS_MS = [100, 250, 500, 1000, 2000, 4000];

function buildTaskEndpoint(windowRef, basePath, path, tabId) {
    const suffix = String(path || '').replace(/^\/+/, '');
    const normalizedBase = String(basePath || '/webchat').replace(/\/+$/, '');
    const url = new URL(`${normalizedBase}/${suffix}`, windowRef.location.origin);
    const sourceParams = new URLSearchParams(windowRef.location.search || '');
    sourceParams.delete('tabId');
    sourceParams.delete('sessionId');
    for (const [key, value] of sourceParams.entries()) url.searchParams.append(key, value);
    if (tabId) url.searchParams.set('tabId', tabId);
    return `${url.pathname}${url.search}`;
}

function resolveTabId(windowRef, taskId) {
    const storageKey = `webchat_task_tab_id:${windowRef.location.pathname}:${taskId}`;
    try {
        const stored = windowRef.sessionStorage?.getItem(storageKey);
        if (stored) return stored;
    } catch (_) {
        // Session storage is optional for standalone task views.
    }
    const generated = windowRef.crypto?.randomUUID?.()
        || `task-view-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    try {
        windowRef.sessionStorage?.setItem(storageKey, generated);
    } catch (_) {
        // A fresh tab id is sufficient when storage is unavailable.
    }
    return generated;
}

export function createTaskViewTransport({
    windowRef = window,
    basePath = '/webchat',
    taskId,
    onOpen = null,
    onUpdate = null,
    onError = null,
    onInteractionRequest = null,
    onInteractionResolved = null,
} = {}) {
    const embedded = windowRef.parent && windowRef.parent !== windowRef;
    const tabId = embedded ? '' : resolveTabId(windowRef, taskId);
    let eventSource = null;

    async function postStandaloneCommand(command) {
        const endpoint = buildTaskEndpoint(windowRef, basePath, 'input', tabId);
        const body = `${serializeEnvelope({ text: command, visible: false })}\n`;
        const send = () => windowRef.fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
            credentials: 'include',
        });
        for (let attempt = 0; ; attempt += 1) {
            const response = await send();
            if (response.status !== 409) {
                if (!response.ok) throw new Error(`task_input_failed_${response.status}`);
                return;
            }
            const delay = RUNTIME_RETRY_DELAYS_MS[attempt];
            if (delay === undefined) throw new Error('task_runtime_unavailable');
            await new Promise((resolve) => windowRef.setTimeout(resolve, delay));
        }
    }

    function requestCommand(command) {
        if (embedded) {
            windowRef.parent.postMessage({
                type: 'webchat-task-command',
                taskId,
                command,
            }, windowRef.location.origin);
            return Promise.resolve();
        }
        return postStandaloneCommand(command);
    }

    async function sendInteractionResponse(interactionId, optionId = null, responseValue = null) {
        if (embedded) {
            windowRef.parent.postMessage({
                type: 'webchat-task-interaction-response',
                taskId,
                interactionId,
                ...(typeof responseValue === 'string' ? { response: responseValue } : { optionId }),
            }, windowRef.location.origin);
            return;
        }
        const response = await windowRef.fetch(
            buildTaskEndpoint(windowRef, basePath, 'interaction', tabId),
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    interactionId,
                    ...(typeof responseValue === 'string' ? { response: responseValue } : { optionId }),
                }),
                credentials: 'include',
            },
        );
        if (!response.ok) throw new Error(`task_interaction_failed_${response.status}`);
    }

    function start() {
        if (embedded || eventSource) return;
        const EventSourceClass = windowRef.EventSource;
        if (typeof EventSourceClass !== 'function') {
            onError?.(new Error('task_stream_unavailable'));
            return;
        }
        eventSource = new EventSourceClass(
            buildTaskEndpoint(windowRef, basePath, 'stream', tabId),
        );
        eventSource.onopen = () => {
            onOpen?.();
        };
        eventSource.addEventListener('task-update', (event) => {
            try {
                const payload = JSON.parse(event.data);
                const includesTask = payload?.task?.id === taskId
                    || (payload?.event === 'list'
                        && payload.tasks?.some?.((entry) => entry?.id === taskId));
                if (includesTask) onUpdate?.(payload);
            } catch (_) {
                // Ignore malformed runtime events and keep the stream alive.
            }
        });
        eventSource.addEventListener('interaction-request', (event) => {
            try {
                const interaction = JSON.parse(event.data);
                if (!interactionTargetsTab(interaction, tabId)) return;
                onInteractionRequest?.(interaction);
            } catch (_) { }
        });
        eventSource.addEventListener('interaction-resolved', (event) => {
            try { onInteractionResolved?.(JSON.parse(event.data)); } catch (_) { }
        });
    }

    function stop() {
        eventSource?.close?.();
        eventSource = null;
    }

    return {
        embedded,
        requestCommand,
        sendInteractionResponse,
        start,
        stop,
    };
}

export const __testables = { buildTaskEndpoint };
