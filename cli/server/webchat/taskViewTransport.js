import { serializeEnvelope } from './network.js';

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
} = {}) {
    const embedded = windowRef.parent && windowRef.parent !== windowRef;
    const tabId = embedded ? '' : resolveTabId(windowRef, taskId);
    let eventSource = null;
    let opened = false;

    async function postStandaloneCommand(command) {
        const endpoint = buildTaskEndpoint(windowRef, basePath, 'input', tabId);
        const body = `${serializeEnvelope({ text: command, visible: false })}\n`;
        const send = () => windowRef.fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
            credentials: 'include',
        });
        let response = await send();
        if (response.status === 409) {
            await new Promise((resolve) => windowRef.setTimeout(resolve, 250));
            response = await send();
        }
        if (!response.ok) throw new Error(`task_input_failed_${response.status}`);
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
            opened = true;
            onOpen?.();
        };
        eventSource.onerror = () => {
            if (!opened) onError?.(new Error('task_stream_unavailable'));
        };
        eventSource.addEventListener('task-update', (event) => {
            try {
                const payload = JSON.parse(event.data);
                if (payload?.task?.id === taskId) onUpdate?.(payload);
            } catch (_) {
                // Ignore malformed runtime events and keep the stream alive.
            }
        });
    }

    function stop() {
        eventSource?.close?.();
        eventSource = null;
        opened = false;
    }

    return {
        embedded,
        requestCommand,
        start,
        stop,
    };
}

export const __testables = { buildTaskEndpoint };
