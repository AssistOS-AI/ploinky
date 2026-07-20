import {
    mergeTaskLogUpdate,
    renderTaskLog,
    taskDurationLabel,
    taskStatusPresentation,
} from './taskPresentation.js';

const TASK_VIEW_PATH_RE = /^(.*)\/tasks\/(task_[0-9a-f]{24})\/view$/;
const match = TASK_VIEW_PATH_RE.exec(window.location.pathname);
const basePath = match?.[1] || '/webchat';
const taskId = match?.[2] || '';
const agent = document.getElementById('taskAgent');
const description = document.getElementById('taskDescription');
const status = document.getElementById('taskStatus');
const duration = document.getElementById('taskDuration');
const error = document.getElementById('taskError');
const log = document.getElementById('taskLog');
const continuationForm = document.getElementById('taskContinuation');
const continuationInput = document.getElementById('taskContinuationInput');
const continuationSend = document.getElementById('taskContinuationSend');
const continuationError = document.getElementById('taskContinuationError');
const MIN_CONTINUATION_INPUT_HEIGHT_PX = 40;
const MAX_CONTINUATION_INPUT_HEIGHT_PX = 132;

let task = null;
let logText = '';
let logOffset = 0;
let initialLoadComplete = false;
let logSync = null;
let refreshSync = null;
let continuationSubmitting = false;
const pendingUpdates = [];
const TERMINAL_STATUSES = new Set(['finished', 'stopped', 'error']);

function autoResizeContinuationInput() {
    continuationInput.style.height = 'auto';
    const scrollHeight = Math.ceil(continuationInput.scrollHeight);
    const nextHeight = Math.min(
        MAX_CONTINUATION_INPUT_HEIGHT_PX,
        Math.max(MIN_CONTINUATION_INPUT_HEIGHT_PX, scrollHeight),
    );
    continuationInput.style.height = `${nextHeight}px`;
    continuationInput.style.overflowY = scrollHeight > MAX_CONTINUATION_INPUT_HEIGHT_PX
        ? 'auto'
        : 'hidden';
    if (scrollHeight <= MAX_CONTINUATION_INPUT_HEIGHT_PX) {
        continuationInput.scrollTop = 0;
    }
}

function insertContinuationNewline() {
    const start = typeof continuationInput.selectionStart === 'number'
        ? continuationInput.selectionStart
        : continuationInput.value.length;
    const end = typeof continuationInput.selectionEnd === 'number'
        ? continuationInput.selectionEnd
        : start;
    continuationInput.setRangeText('\n', start, end, 'end');
    continuationInput.dispatchEvent(new Event('input', { bubbles: true }));
}

function applyTheme() {
    const supported = new Set(['light', 'dark', 'explorer', 'obsidian']);
    let theme = 'explorer';
    try {
        const stored = localStorage.getItem('webchat_theme');
        if (supported.has(stored)) theme = stored;
    } catch (_) {
        theme = 'explorer';
    }
    document.body.dataset.theme = theme;
}

function endpoint(relativePath, params = {}) {
    const url = new URL(`${basePath}/${String(relativePath || '').replace(/^\/+/, '')}`, window.location.origin);
    const current = new URLSearchParams(window.location.search);
    for (const [key, value] of current.entries()) url.searchParams.append(key, value);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    return `${url.pathname}${url.search}`;
}

function renderTask() {
    const presentation = taskStatusPresentation(task);
    agent.textContent = task?.targetAgent || 'Task';
    description.textContent = task?.description || task?.toolName || (taskId ? 'Task data unavailable' : 'Invalid task');
    status.className = `wa-task-status is-${presentation.className}`;
    status.textContent = task ? presentation.label : 'UNAVAILABLE';
    duration.textContent = taskDurationLabel(task);
    error.hidden = !task?.error;
    error.textContent = task?.error || '';
    const canContinue = Boolean(task?.continuation?.handle)
        && TERMINAL_STATUSES.has(task?.status);
    continuationForm.hidden = !canContinue;
    continuationInput.disabled = continuationSubmitting || !canContinue;
    continuationSend.disabled = continuationSubmitting || !canContinue;
    continuationSend.textContent = continuationSubmitting ? 'Sending…' : 'Send';
    document.title = `${description.textContent} · Task logs`;
}

function renderLog({ stickToEnd = true } = {}) {
    const previousScrollTop = log.scrollTop;
    const wasAtEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
    renderTaskLog(log, logText, initialLoadComplete ? 'No log output yet.' : 'Loading log…');
    if (stickToEnd && wasAtEnd) log.scrollTop = log.scrollHeight;
    else log.scrollTop = previousScrollTop;
}

async function fetchJson(url, options = {}) {
    const response = await fetch(url, { credentials: 'include', ...options });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
        throw new Error(payload.error || `task_view_${response.status}`);
    }
    return payload;
}

async function refreshTask() {
    if (refreshSync || task?.status !== 'ongoing' || !task?.continuation) return refreshSync;
    refreshSync = fetchJson(endpoint(`tasks/${encodeURIComponent(taskId)}/refresh`))
        .then((payload) => {
            applyUpdate(payload);
            return syncLog(logOffset);
        })
        .catch(showLoadError)
        .finally(() => {
            refreshSync = null;
        });
    return refreshSync;
}

async function syncLog(offset = logOffset) {
    if (logSync) return logSync;
    logSync = fetchJson(endpoint(`tasks/${encodeURIComponent(taskId)}/log`, { offset }))
        .then((payload) => {
            if (payload.reset || offset === 0) logText = typeof payload.text === 'string' ? payload.text : '';
            else logText += typeof payload.text === 'string' ? payload.text : '';
            logOffset = Number(payload.nextOffset) || 0;
            renderLog();
        })
        .finally(() => {
            logSync = null;
        });
    return logSync;
}

function applyLogUpdate(payload) {
    const merged = mergeTaskLogUpdate({ text: logText, offset: logOffset }, payload);
    if (merged.needsSync) {
        void syncLog(logOffset)
            .then(() => applyLogUpdate(payload))
            .catch(showLoadError);
        return;
    }
    if (merged.text === logText && merged.offset === logOffset) return;
    logText = merged.text;
    logOffset = merged.offset;
    renderLog();
}

function applyUpdate(payload) {
    if (payload?.task?.id !== taskId) return;
    task = { ...task, ...payload.task };
    renderTask();
    applyLogUpdate(payload);
}

function showLoadError(loadError) {
    error.hidden = false;
    error.textContent = `Unable to load task data: ${loadError?.message || loadError}`;
}

async function submitContinuation(event) {
    event.preventDefault();
    if (continuationSubmitting) return;
    const message = String(continuationInput.value || '').trim();
    if (!message) return;
    continuationSubmitting = true;
    continuationError.hidden = true;
    continuationError.textContent = '';
    renderTask();
    try {
        const payload = await fetchJson(endpoint(`tasks/${encodeURIComponent(taskId)}/continue`), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message }),
        });
        continuationInput.value = '';
        autoResizeContinuationInput();
        applyUpdate(payload);
        await syncLog(logOffset);
    } catch (submitError) {
        continuationError.hidden = false;
        continuationError.textContent = `Unable to continue task: ${submitError?.message || submitError}`;
    } finally {
        continuationSubmitting = false;
        renderTask();
    }
}

async function initialize() {
    if (!taskId) {
        initialLoadComplete = true;
        renderTask();
        renderLog();
        return;
    }
    try {
        const [tasksPayload] = await Promise.all([
            fetchJson(endpoint('tasks')),
            syncLog(0),
        ]);
        task = (Array.isArray(tasksPayload.tasks) ? tasksPayload.tasks : [])
            .find((candidate) => candidate?.id === taskId) || null;
    } catch (loadError) {
        showLoadError(loadError);
    } finally {
        initialLoadComplete = true;
        renderTask();
        renderLog();
        for (const payload of pendingUpdates.splice(0)) applyUpdate(payload);
        void refreshTask();
    }
}

window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin || event.source !== window.parent) return;
    if (event.data?.type !== 'webchat-task-update') return;
    const payload = event.data.payload;
    if (payload?.task?.id !== taskId) return;
    if (!initialLoadComplete) pendingUpdates.push(payload);
    else applyUpdate(payload);
});

applyTheme();
continuationForm.addEventListener('submit', submitContinuation);
continuationInput.addEventListener('input', autoResizeContinuationInput);
continuationInput.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.isComposing || event.key !== 'Enter') return;
    if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        insertContinuationNewline();
        return;
    }
    if (event.shiftKey) return;
    event.preventDefault();
    continuationForm.requestSubmit();
});
autoResizeContinuationInput();
renderTask();
renderLog();
setInterval(renderTask, 1000);
setInterval(() => void refreshTask(), 2000);
void initialize();
