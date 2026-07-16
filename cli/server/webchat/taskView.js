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

let task = null;
let logText = '';
let logOffset = 0;
let initialLoadComplete = false;
let logSync = null;
const pendingUpdates = [];

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
    document.title = `${description.textContent} · Task logs`;
}

function renderLog({ stickToEnd = true } = {}) {
    const previousScrollTop = log.scrollTop;
    const wasAtEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
    renderTaskLog(log, logText, initialLoadComplete ? 'No log output yet.' : 'Loading log…');
    if (stickToEnd && wasAtEnd) log.scrollTop = log.scrollHeight;
    else log.scrollTop = previousScrollTop;
}

async function fetchJson(url) {
    const response = await fetch(url, { credentials: 'include' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
        throw new Error(payload.error || `task_view_${response.status}`);
    }
    return payload;
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
renderTask();
renderLog();
setInterval(renderTask, 1000);
void initialize();
