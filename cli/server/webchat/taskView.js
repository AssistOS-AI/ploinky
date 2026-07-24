import {
    mergeTaskLogUpdate,
    renderTaskLog,
    taskDurationLabel,
    taskStatusPresentation,
} from './taskPresentation.js';
import { createTaskViewTransport } from './taskViewTransport.js';

const TASK_VIEW_PATH_RE = /^(.*)\/tasks\/(task_[0-9a-f]{24})\/view$/;
const match = TASK_VIEW_PATH_RE.exec(window.location.pathname);
const taskId = match?.[2] || '';
const basePath = match?.[1] || '/webchat';
const agent = document.getElementById('taskAgent');
const description = document.getElementById('taskDescription');
const status = document.getElementById('taskStatus');
const duration = document.getElementById('taskDuration');
const error = document.getElementById('taskError');
const stopButton = document.getElementById('taskStop');
const actionError = document.getElementById('taskActionError');
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
let logResyncPending = false;
let continuationSubmitting = false;
let stopSubmitting = false;
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

function requestCommand(command) {
    return transport.requestCommand(command);
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
    const taskOngoing = task?.status === 'ongoing';
    const taskStopping = String(task?.remoteStatus || '').trim().toLowerCase() === 'cancelling';
    stopButton.hidden = !taskOngoing;
    stopButton.disabled = stopSubmitting || taskStopping;
    stopButton.textContent = stopSubmitting || taskStopping ? 'Stopping…' : 'Stop';
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
    renderTaskLog(
        log,
        logText,
        initialLoadComplete ? 'No log output yet.' : 'Loading log…',
        task,
    );
    if (stickToEnd && wasAtEnd) log.scrollTop = log.scrollHeight;
    else log.scrollTop = previousScrollTop;
}

async function stopTask() {
    if (stopSubmitting || task?.status !== 'ongoing') return;
    stopSubmitting = true;
    actionError.hidden = true;
    actionError.textContent = '';
    renderTask();
    try {
        await requestCommand(`/task stop ${taskId}`);
    } catch (stopError) {
        stopSubmitting = false;
        actionError.hidden = false;
        actionError.textContent = `Unable to stop task: ${stopError?.message || stopError}`;
        renderTask();
    }
}

async function syncLog() {
    if (logSync) return logSync;
    logSync = Promise.resolve().then(() => requestCommand(`/task view ${taskId}`)).finally(() => {
        logSync = null;
    });
    return logSync;
}

function applyLogUpdate(payload) {
    const merged = mergeTaskLogUpdate({ text: logText, offset: logOffset }, payload);
    if (merged.needsSync) {
        if (!logResyncPending) {
            logResyncPending = true;
            void syncLog().catch((syncError) => {
                logResyncPending = false;
                showLoadError(syncError);
            });
        }
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
    let receivedLogSnapshot = false;
    if (payload.event === 'action' && payload.action === 'stop') stopSubmitting = false;
    if (payload.event === 'action' && payload.action === 'continue') {
        continuationSubmitting = false;
        if (payload.ok === true) {
            continuationInput.value = '';
            autoResizeContinuationInput();
        }
    }
    if (task.status !== 'ongoing') stopSubmitting = false;
    if (payload.event === 'action' && payload.ok === false) {
        const target = payload.action === 'continue' ? continuationError : actionError;
        target.hidden = false;
        target.textContent = payload.error || 'Task action failed.';
    }
    if (payload.event === 'view' && payload.log) {
        logText = typeof payload.log.text === 'string' ? payload.log.text : '';
        logOffset = Number(payload.log.nextOffset) || 0;
        logResyncPending = false;
        receivedLogSnapshot = true;
    }
    renderTask();
    if (receivedLogSnapshot) renderLog();
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
        await requestCommand(`/task continue ${taskId} ${message}`);
    } catch (submitError) {
        continuationSubmitting = false;
        continuationError.hidden = false;
        continuationError.textContent = `Unable to continue task: ${submitError?.message || submitError}`;
        renderTask();
    }
}

function initialize() {
    if (!taskId) {
        initialLoadComplete = true;
        renderTask();
        renderLog();
        return;
    }
    transport.start();
}

function receiveUpdate(payload) {
    if (payload?.task?.id !== taskId) return;
    if (!initialLoadComplete) {
        if (payload.event !== 'view') {
            pendingUpdates.push(payload);
            return;
        }
        initialLoadComplete = true;
        applyUpdate(payload);
        for (const pending of pendingUpdates.splice(0)) applyUpdate(pending);
        return;
    }
    applyUpdate(payload);
}

const transport = createTaskViewTransport({
    windowRef: window,
    basePath,
    taskId,
    onOpen: () => {
        void syncLog().catch(showLoadError);
    },
    onUpdate: receiveUpdate,
    onError: showLoadError,
});

window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin || event.source !== window.parent) return;
    if (event.data?.type !== 'webchat-task-update') return;
    receiveUpdate(event.data.payload);
});

window.addEventListener('pagehide', () => transport.stop());

applyTheme();
continuationForm.addEventListener('submit', submitContinuation);
stopButton.addEventListener('click', () => void stopTask());
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
initialize();
