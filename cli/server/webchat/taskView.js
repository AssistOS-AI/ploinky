import {
    mergeTaskLogUpdate,
    renderTaskLog,
    taskDurationLabel,
    taskStatusPresentation,
} from './taskPresentation.js';
import { createTaskLogFollower } from './taskLogFollow.js';
import { createTaskViewTransport } from './taskViewTransport.js';
import { createComposerAutocomplete } from './composerAutocomplete.js';
import {
    createTaskCommandAutocompleteProvider,
    createTaskInteractionAutocompleteProvider,
} from './taskCommandAutocomplete.js';
import { createInteractionPrompt } from './interactionPrompt.js';

const TASK_VIEW_PATH_RE = /^(.*)\/tasks\/(task_[0-9a-f]{24})\/view$/;
const match = TASK_VIEW_PATH_RE.exec(window.location.pathname);
const taskId = match?.[2] || '';
const basePath = match?.[1] || '/webchat';
const agent = document.getElementById('taskAgent');
const model = document.getElementById('taskModel');
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
const interactionPrompt = createInteractionPrompt({
    root: document.getElementById('taskInteractionPrompt'),
    title: document.getElementById('taskInteractionPromptTitle'),
    message: document.getElementById('taskInteractionPromptMessage'),
    detail: document.getElementById('taskInteractionPromptDetail'),
    inputRow: document.getElementById('taskInteractionPromptInputRow'),
    input: document.getElementById('taskInteractionPromptInput'),
    submitButton: document.getElementById('taskInteractionPromptSubmit'),
    cancelButton: document.getElementById('taskInteractionPromptCancel'),
    options: document.getElementById('taskInteractionPromptOptions'),
}, {
    onSubmit: (interactionId, optionId, response) => transport.sendInteractionResponse(
        interactionId,
        optionId,
        response,
    ),
    onCancel: (interactionId) => transport.sendInteractionCancel(interactionId),
});
const logFollower = createTaskLogFollower(log);
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
let loadErrorMessage = '';
let pendingSelectInteraction = null;
let loadingTaskCommandName = '';
let interactionCommandPrefix = '';
let logSnapshotChunks = null;
const pendingUpdates = [];
const TERMINAL_STATUSES = new Set(['finished', 'stopped', 'error']);

const taskAutocomplete = createComposerAutocomplete({ cmdInput: continuationInput }, {
    positionStrategy: 'viewport',
    providers: [
        createTaskInteractionAutocompleteProvider({
            getInteraction: () => pendingSelectInteraction,
            getCommandPrefix: () => interactionCommandPrefix,
            onSelect: (interaction, option) => void submitInteractionOption(interaction, option),
        }),
        createTaskCommandAutocompleteProvider({
            getCommands: () => (pendingSelectInteraction || interactionCommandPrefix)
                ? []
                : (task?.commands || []),
            getLoadingCommand: () => loadingTaskCommandName,
            onLoadOptions: (taskCommand) => loadTaskCommandOptions(taskCommand),
        }),
    ],
});

function clearPendingTaskInteraction() {
    pendingSelectInteraction = null;
    interactionCommandPrefix = '';
    continuationInput.value = '';
    continuationInput.dispatchEvent(new Event('input', { bubbles: true }));
    taskAutocomplete.hide();
}

async function startTaskCommand(taskCommand, suffix = '') {
    if (pendingSelectInteraction) return;
    continuationError.hidden = true;
    continuationError.textContent = '';
    try {
        await requestCommand(`${taskCommand.command}${suffix ? ` ${suffix}` : ''}`);
        if (suffix) {
            continuationInput.value = '';
            continuationInput.dispatchEvent(new Event('input', { bubbles: true }));
            autoResizeContinuationInput();
        }
    } catch (commandError) {
        continuationError.hidden = false;
        continuationError.textContent = `Unable to run task command: ${commandError?.message || commandError}`;
    }
}

async function loadTaskCommandOptions(taskCommand) {
    if (!taskCommand?.name || loadingTaskCommandName === taskCommand.name || pendingSelectInteraction) return;
    loadingTaskCommandName = taskCommand.name;
    continuationError.hidden = true;
    continuationError.textContent = '';
    taskAutocomplete.onInputChange();
    try {
        await requestCommand(taskCommand.command);
    } catch (commandError) {
        loadingTaskCommandName = '';
        taskAutocomplete.hide();
        continuationError.hidden = false;
        continuationError.textContent = `Unable to load task options: ${commandError?.message || commandError}`;
    }
}

async function submitInteractionOption(interaction, option) {
    if (pendingSelectInteraction?.id !== interaction?.id) return;
    pendingSelectInteraction = null;
    continuationInput.value = interactionCommandPrefix;
    continuationInput.dispatchEvent(new Event('input', { bubbles: true }));
    try {
        await transport.sendInteractionResponse(interaction.id, option.id);
    } catch (interactionError) {
        continuationError.hidden = false;
        continuationError.textContent = `Unable to select option: ${interactionError?.message || interactionError}`;
    }
}

function handleInteractionRequest(interaction) {
    if (interaction?.targetTaskId && interaction.targetTaskId !== taskId) return;
    if (!interactionCommandPrefix) {
        const commandName = loadingTaskCommandName
            || String(continuationInput.value || '').trim().split(/\s+/, 1)[0];
        interactionCommandPrefix = commandName.startsWith('/') ? `${commandName} ` : '/';
    }
    loadingTaskCommandName = '';
    if (!interaction?.input && Array.isArray(interaction?.options) && interaction.options.length) {
        interactionPrompt.resolve();
        pendingSelectInteraction = interaction;
        continuationInput.value = interactionCommandPrefix;
        continuationInput.setSelectionRange?.(
            interactionCommandPrefix.length,
            interactionCommandPrefix.length,
        );
        continuationInput.dispatchEvent(new Event('input', { bubbles: true }));
        continuationInput.focus?.();
        return;
    }
    pendingSelectInteraction = null;
    taskAutocomplete.hide();
    interactionPrompt.show(interaction);
}

function handleInteractionResolved(resolution) {
    if (pendingSelectInteraction?.id === resolution?.id) {
        pendingSelectInteraction = null;
        continuationInput.value = interactionCommandPrefix;
        continuationInput.dispatchEvent(new Event('input', { bubbles: true }));
        taskAutocomplete.hide();
    }
    interactionPrompt.resolve(resolution);
}

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
    const fallbackDescription = !taskId
        ? 'Invalid task'
        : (initialLoadComplete ? 'Task data unavailable' : 'Loading task…');
    agent.textContent = task?.targetAgent || 'Task';
    const taskModel = task?.execution?.model;
    model.textContent = taskModel?.label || taskModel?.key || taskModel?.model || 'default';
    description.textContent = task?.description || task?.toolName || fallbackDescription;
    status.className = `wa-task-status is-${presentation.className}`;
    status.textContent = task ? presentation.label : (initialLoadComplete ? 'UNAVAILABLE' : 'LOADING');
    duration.textContent = taskDurationLabel(task);
    const displayedError = task?.error || loadErrorMessage;
    error.hidden = !displayedError;
    error.textContent = displayedError;
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

function renderLog() {
    const previousScrollTop = log.scrollTop;
    renderTaskLog(
        log,
        logText,
        initialLoadComplete ? 'No log output yet.' : 'Loading log…',
        task,
    );
    logFollower.restoreAfterRender(previousScrollTop);
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
        return false;
    }
    if (merged.text === logText && merged.offset === logOffset) return false;
    logText = merged.text;
    logOffset = merged.offset;
    renderLog();
    return true;
}

function applyUpdate(payload) {
    if (payload?.task?.id !== taskId) return;
    if (payload.event === 'view') loadErrorMessage = '';
    const previousStatus = task?.status;
    const previousFinalOutputState = JSON.stringify([
        task?.finalOutputOffset,
        task?.finalOutputLength,
        task?.finalOutputRanges,
    ]);
    task = { ...task, ...payload.task };
    const loadedCommand = loadingTaskCommandName
        ? task.commands?.find?.((entry) => entry.name === loadingTaskCommandName)
        : null;
    const taskCommandOptionsLoaded = Array.isArray(loadedCommand?.argCompletions)
        && loadedCommand.argCompletions.length > 0;
    if (taskCommandOptionsLoaded) loadingTaskCommandName = '';
    const finalOutputStateChanged = previousFinalOutputState !== JSON.stringify([
        task?.finalOutputOffset,
        task?.finalOutputLength,
        task?.finalOutputRanges,
    ]);
    let receivedLogSnapshot = false;
    const chunkPhase = payload?.logChunk?.phase;
    if (payload.event === 'view' && chunkPhase === 'start') {
        const count = Number(payload.logChunk.count);
        logSnapshotChunks = Number.isSafeInteger(count) && count > 0
            ? { count, chunks: [], nextOffset: Number(payload.logChunk.nextOffset) || 0 }
            : null;
    } else if (payload.event === 'view-log-chunk' && chunkPhase === 'chunk') {
        const index = Number(payload.logChunk.index);
        const count = Number(payload.logChunk.count);
        const text = typeof payload.logChunk.text === 'string' ? payload.logChunk.text : null;
        if (!logSnapshotChunks || count !== logSnapshotChunks.count
            || index !== logSnapshotChunks.chunks.length || text === null) {
            logSnapshotChunks = null;
            void syncLog().catch(showLoadError);
        } else {
            logSnapshotChunks.chunks.push(text);
            if (logSnapshotChunks.chunks.length === logSnapshotChunks.count) {
                logText = logSnapshotChunks.chunks.join('');
                logOffset = Number(payload.logChunk.nextOffset) || logSnapshotChunks.nextOffset;
                logSnapshotChunks = null;
                logResyncPending = false;
                receivedLogSnapshot = true;
            }
        }
    } else if (payload.event === 'view') {
        logSnapshotChunks = null;
    }
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
        if (payload.action === 'model' || payload.action === 'login') {
            loadingTaskCommandName = '';
            if (pendingSelectInteraction) clearPendingTaskInteraction();
            else taskAutocomplete.hide();
        }
        const target = payload.action === 'continue' ? continuationError : actionError;
        target.hidden = false;
        target.textContent = payload.error || 'Task action failed.';
    }
    if ((payload.event === 'action' || payload.event === 'control')
        && payload.action === 'login') {
        clearPendingTaskInteraction();
    }
    if (payload.event === 'view' && payload.log && chunkPhase !== 'start') {
        logText = typeof payload.log.text === 'string' ? payload.log.text : '';
        logOffset = Number(payload.log.nextOffset) || 0;
        logResyncPending = false;
        receivedLogSnapshot = true;
    }
    renderTask();
    if (taskCommandOptionsLoaded) taskAutocomplete.onInputChange();
    if (receivedLogSnapshot) renderLog();
    const renderedLogUpdate = applyLogUpdate(payload);
    if (!receivedLogSnapshot && !logSnapshotChunks && finalOutputStateChanged && !renderedLogUpdate) {
        renderLog();
    }
    if (payload.event !== 'view'
        && previousStatus === 'ongoing'
        && TERMINAL_STATUSES.has(task.status)) {
        void syncLog().catch(showLoadError);
    }
}

function showLoadError(loadError) {
    initialLoadComplete = true;
    loadErrorMessage = `Unable to load task data: ${loadError?.message || loadError}`;
    renderTask();
    renderLog();
}

async function submitContinuation(event) {
    event.preventDefault();
    if (continuationSubmitting) return;
    if (pendingSelectInteraction) return;
    const message = String(continuationInput.value || '').trim();
    if (!message) return;
    const taskCommand = (task?.commands || []).find((entry) => (
        message === entry.name || message.startsWith(`${entry.name} `)
    ));
    if (taskCommand) {
        const suffix = message.slice(taskCommand.name.length).trim();
        if (!suffix && taskCommand.loadingLabel) {
            await loadTaskCommandOptions(taskCommand);
            return;
        }
        await startTaskCommand(taskCommand, suffix);
        return;
    }
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
    if (!transport.embedded) void syncLog().catch(showLoadError);
}

function receiveUpdate(payload) {
    if (payload?.event === 'list') {
        const snapshot = payload.tasks?.find?.((entry) => entry?.id === taskId);
        if (!snapshot) return;
        task = { ...task, ...snapshot };
        renderTask();
        renderLog();
        return;
    }
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
    onInteractionRequest: handleInteractionRequest,
    onInteractionResolved: handleInteractionResolved,
});

window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin || event.source !== window.parent) return;
    if (event.data?.type === 'webchat-task-update') receiveUpdate(event.data.payload);
    if (event.data?.type === 'webchat-task-interaction-request') handleInteractionRequest(event.data.payload);
    if (event.data?.type === 'webchat-task-interaction-resolved') handleInteractionResolved(event.data.payload);
});

window.addEventListener('pagehide', () => {
    taskAutocomplete.destroy();
    transport.stop();
});

applyTheme();
continuationForm.addEventListener('submit', submitContinuation);
stopButton.addEventListener('click', () => void stopTask());
continuationInput.addEventListener('input', autoResizeContinuationInput);
continuationInput.addEventListener('keydown', (event) => {
    if (taskAutocomplete.handleKeydown(event)) return;
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
continuationInput.addEventListener('input', () => taskAutocomplete.onInputChange());
autoResizeContinuationInput();
renderTask();
renderLog();
setInterval(renderTask, 1000);
initialize();
