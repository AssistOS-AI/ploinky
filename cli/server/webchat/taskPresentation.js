import { createTaskLogFollower } from './taskLogFollow.js';

const TERMINAL_STATUSES = new Set(['finished', 'stopped', 'error']);
const ANSI_RE = /[\u001b\u009b][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
const STREAM_PREFIX_RE = /^\[([^\]]+)\s+(stdout|stderr)\]\s?/i;
const RUNNER_PREFIX_RE = /^\[[^\]]+\/[^\]]+\]\s?/;
const TASK_LOG_INLINE_CODE_RE = /`[^`\r\n]+`/gu;
const TASK_LOG_PATH_RE = /(?:[A-Za-z]:[\\/][^\s"'`<>|]+|(?:\/|~\/|\.{1,2}\/)[^\s"'`<>|]+|[\p{L}\p{N}_+.-]+(?:[\\/][\p{L}\p{N}_+.@-]+)+(?::\d+(?::\d+)?)?)/gu;
const TASK_LOG_FILE_RE = /(?:^|[\s([{<"'`])([\p{L}\p{N}_+-]+\.(?:c|cc|cpp|cs|css|csv|go|h|hpp|htm|html|java|jpeg|jpg|js|json|jsx|log|md|mdx|mjs|pdf|php|png|py|rb|rs|scss|sh|sql|svg|toml|ts|tsx|txt|webp|xml|yaml|yml)(?::\d+(?::\d+)?)?)(?=$|[\s)\]}>.,'";!?`])/giu;
const TASK_LOG_TRAILING_PATH_PUNCTUATION_RE = /[),.;!?}\]]+$/u;
const TASK_LOG_MARKDOWN_LINK_RE = /\[([^\]\r\n]+)\]\(([^)\s]+)\)/gu;

function addTaskLogHighlight(matches, start, end, kind) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) return;
    if (matches.some((match) => start < match.end && end > match.start)) return;
    matches.push({ start, end, kind });
}

function addTaskLogRegexHighlights(text, regex, matches, kind) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(text)) !== null) {
        addTaskLogHighlight(matches, match.index, match.index + match[0].length, kind);
    }
}

function taskLogPathLength(value) {
    const trimmed = value.replace(TASK_LOG_TRAILING_PATH_PUNCTUATION_RE, '');
    if (!trimmed) return 0;
    if (trimmed.startsWith('/') && !trimmed.slice(1).includes('/')
        && !/\.[\p{L}\p{N}]{1,10}(?::\d+(?::\d+)?)?$/u.test(trimmed)) {
        return 0;
    }
    return trimmed.length;
}

export function tokenizeTaskLogText(value) {
    const text = String(value || '');
    if (!text) return [{ text, kind: null }];
    const matches = [];
    addTaskLogRegexHighlights(text, TASK_LOG_INLINE_CODE_RE, matches, 'code');

    TASK_LOG_PATH_RE.lastIndex = 0;
    let pathMatch;
    while ((pathMatch = TASK_LOG_PATH_RE.exec(text)) !== null) {
        const length = taskLogPathLength(pathMatch[0]);
        addTaskLogHighlight(matches, pathMatch.index, pathMatch.index + length, 'path');
    }

    TASK_LOG_FILE_RE.lastIndex = 0;
    let fileMatch;
    while ((fileMatch = TASK_LOG_FILE_RE.exec(text)) !== null) {
        const start = fileMatch.index + fileMatch[0].indexOf(fileMatch[1]);
        addTaskLogHighlight(matches, start, start + fileMatch[1].length, 'path');
    }

    matches.sort((left, right) => left.start - right.start);
    const tokens = [];
    let cursor = 0;
    for (const match of matches) {
        if (match.start > cursor) {
            tokens.push({ text: text.slice(cursor, match.start), kind: null });
        }
        tokens.push({ text: text.slice(match.start, match.end), kind: match.kind });
        cursor = match.end;
    }
    if (cursor < text.length) tokens.push({ text: text.slice(cursor), kind: null });
    return tokens.length ? tokens : [{ text, kind: null }];
}

export function taskStatusPresentation(task) {
    if (!task) return { label: 'UNAVAILABLE', className: 'unavailable' };
    if (task.status === 'finished') return { label: 'COMPLETED', className: 'finished' };
    if (task.status === 'stopped') return { label: 'STOPPED', className: 'stopped' };
    if (task.status === 'error') return { label: 'FAILED', className: 'error' };
    const remoteStatus = String(task.remoteStatus || '').trim().toLowerCase();
    if (remoteStatus === 'cancelling') {
        return { label: 'STOPPING', className: 'cancelling' };
    }
    if (remoteStatus === 'pending' || remoteStatus === 'queued') {
        return { label: 'QUEUED', className: 'queued' };
    }
    return { label: 'RUNNING', className: 'running' };
}

export function taskDurationSeconds(task, now = Date.now()) {
    const start = Date.parse(task?.executionStartedAt || task?.createdAt || '');
    if (!Number.isFinite(start)) return null;
    const terminal = TERMINAL_STATUSES.has(task?.status);
    const end = terminal ? Date.parse(task?.updatedAt || '') : now;
    if (!Number.isFinite(end)) return null;
    return Math.max(0, Math.floor((end - start) / 1000));
}

export function taskDurationLabel(task, now = Date.now()) {
    const seconds = taskDurationSeconds(task, now);
    return seconds === null ? '' : `${seconds}s`;
}

function taskFinalOutputRanges(task) {
    const declared = Array.isArray(task?.finalOutputRanges)
        ? task.finalOutputRanges
        : [];
    const legacy = {
        turn: task?.turn,
        offset: task?.finalOutputOffset,
        length: task?.finalOutputLength,
    };
    return [...declared, legacy].filter((range) => {
        return Number.isSafeInteger(range?.offset)
            && range.offset >= 0
            && Number.isSafeInteger(range?.length)
            && range.length > 0;
    });
}

function parseTaskLogEntries(text, finalOutputs = []) {
    const rawText = String(text || '');
    const lines = rawText.split(/\r?\n/);
    const orderedFinalOutputs = [...finalOutputs]
        .sort((left, right) => left.offset - right.offset);
    let cursor = 0;
    let finalOutputIndex = 0;
    return lines.flatMap((unstrippedLine) => {
        const lineStart = cursor;
        const lineEnd = lineStart + unstrippedLine.length;
        const separatorLength = rawText.startsWith('\r\n', lineEnd)
            ? 2
            : (rawText[lineEnd] === '\n' ? 1 : 0);
        cursor = lineEnd + separatorLength;
        while (finalOutputIndex < orderedFinalOutputs.length
            && orderedFinalOutputs[finalOutputIndex].offset
                + orderedFinalOutputs[finalOutputIndex].length <= lineStart) {
            finalOutputIndex += 1;
        }
        const finalOutput = orderedFinalOutputs[finalOutputIndex];
        const isFinal = finalOutput
            && finalOutput.offset + finalOutput.length > lineStart
            && finalOutput.offset < lineEnd;
        const tone = isFinal
            ? 'final'
            : 'intermediate';
        const rawLine = unstrippedLine.replace(ANSI_RE, '');
        let line = rawLine;
        let stream = 'stdout';
        const streamMatch = STREAM_PREFIX_RE.exec(line);
        if (streamMatch) {
            stream = streamMatch[2].toLowerCase();
            line = line.slice(streamMatch[0].length);
        }
        const runnerMatch = RUNNER_PREFIX_RE.exec(line);
        if (runnerMatch) {
            line = line.slice(runnerMatch[0].length);
            if (/^(?:timeout|error|crashed)\b/i.test(line)) stream = 'stderr';
            if (/^(?:start\b|exit\b)/i.test(line)) return [];
        }
        if (/^\[Continuation \d+\]$/i.test(line.trim())) return [];
        if (/^\[(?:task result|older task log content truncated)\]$/i.test(line.trim())) {
            return line.trim().toLowerCase() === '[task result]'
                ? []
                : [{ text: 'Older task log content was truncated.', stream: 'stderr', tone }];
        }
        if (/^\[task log source truncated or restarted\]$/i.test(line.trim())) {
            return [{ text: 'Task log source was truncated or restarted.', stream: 'stderr', tone }];
        }
        const promptMatch = /^(?:User:\s*|you>\s?)(.*)$/i.exec(line);
        const kind = promptMatch ? 'user-prompt' : 'output';
        if (promptMatch) line = `you> ${promptMatch[1]}`;
        return [{ text: line, stream, tone, kind }];
    });
}

export function parseTaskLog(text) {
    return parseTaskLogEntries(text).map(({ text: lineText, stream }) => ({
        text: lineText,
        stream,
    }));
}

export function parseTaskLogPresentation(text, task = null) {
    return parseTaskLogEntries(text, taskFinalOutputRanges(task));
}

function safeTaskLogUrl(rawUrl) {
    try {
        const origin = globalThis.window?.location?.origin || 'http://localhost';
        const url = new URL(rawUrl, origin);
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
    } catch {
        return '';
    }
}

function highlightedTaskLogFragments(text) {
    return tokenizeTaskLogText(text).map((token) => {
        const fragment = document.createElement('span');
        fragment.className = token.kind
            ? `wa-task-log-token is-${token.kind}`
            : 'wa-task-log-fragment';
        fragment.textContent = token.text;
        return fragment;
    });
}

function linkedTaskLogFragments(text) {
    const fragments = [];
    let cursor = 0;
    let found = false;
    TASK_LOG_MARKDOWN_LINK_RE.lastIndex = 0;
    let match;
    while ((match = TASK_LOG_MARKDOWN_LINK_RE.exec(text)) !== null) {
        const href = safeTaskLogUrl(match[2]);
        if (!href) continue;
        fragments.push(...highlightedTaskLogFragments(text.slice(cursor, match.index)));
        const link = document.createElement('a');
        link.className = 'wa-task-log-inline-link';
        link.href = href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.dataset.wcLink = 'true';
        link.textContent = match[1];
        fragments.push(link);
        cursor = match.index + match[0].length;
        found = true;
    }
    if (!found) return null;
    fragments.push(...highlightedTaskLogFragments(text.slice(cursor)));
    return fragments;
}

export function renderTaskLog(container, text, emptyText = 'No log output yet.', task = null) {
    if (!container) return;
    container.replaceChildren();
    const lines = parseTaskLogPresentation(text, task);
    if (!lines.length || lines.every((line) => !line.text)) {
        const empty = document.createElement('span');
        empty.className = 'wa-task-log-empty';
        empty.textContent = emptyText;
        container.appendChild(empty);
        return;
    }
    for (const entry of lines) {
        const line = document.createElement('span');
        line.className = `wa-task-log-line is-${entry.stream} is-${entry.tone} is-${entry.kind || 'output'}`;
        const text = entry.text || '\u00a0';
        line.textContent = text;
        const tokens = tokenizeTaskLogText(text);
        const linkedFragments = linkedTaskLogFragments(text);
        if (typeof line.replaceChildren === 'function' && (linkedFragments || tokens.some((token) => token.kind))) {
            const fragments = linkedFragments || highlightedTaskLogFragments(text);
            line.replaceChildren(...fragments);
        }
        container.appendChild(line);
    }
}

export function mergeTaskLogUpdate(state, payload) {
    const text = typeof state?.text === 'string' ? state.text : '';
    const offset = Number.isFinite(Number(state?.offset)) ? Number(state.offset) : text.length;
    const appended = typeof payload?.logAppend === 'string' ? payload.logAppend : '';
    const nextOffset = Number(payload?.logOffset);
    if (!appended) return { text, offset, needsSync: false };
    if (!Number.isFinite(nextOffset)) {
        return { text: text + appended, offset: offset + appended.length, needsSync: false };
    }
    if (nextOffset <= offset) return { text, offset, needsSync: false };
    if (nextOffset - appended.length !== offset) return { text, offset, needsSync: true };
    return { text: text + appended, offset: nextOffset, needsSync: false };
}

export function attachTaskSummary({ bubble, taskId, taskController }) {
    const panel = document.createElement('div');
    panel.className = 'wa-task-summary is-expanded';
    panel.dataset.taskId = taskId;
    const summary = document.createElement('button');
    summary.type = 'button';
    summary.className = 'wa-task-summary-row';
    const bodyId = `task-summary-body-${taskId}`;
    summary.setAttribute('aria-expanded', 'true');
    summary.setAttribute('aria-controls', bodyId);
    summary.setAttribute('aria-label', 'Collapse task log');
    const agent = document.createElement('strong');
    agent.className = 'wa-task-summary-agent';
    agent.textContent = 'Task';
    const description = document.createElement('span');
    description.className = 'wa-task-summary-description';
    const status = document.createElement('span');
    status.className = 'wa-task-status is-unavailable';
    status.textContent = 'LOADING';
    const duration = document.createElement('span');
    duration.className = 'wa-task-summary-duration';
    const arrow = document.createElement('span');
    arrow.className = 'wa-task-summary-arrow';
    arrow.setAttribute('aria-hidden', 'true');
    arrow.textContent = '▾';
    summary.append(agent, description, status, duration, arrow);
    const body = document.createElement('div');
    body.id = bodyId;
    body.className = 'wa-task-summary-body';
    const log = document.createElement('div');
    log.className = 'wa-task-log wa-task-summary-log';
    const logFollower = createTaskLogFollower(log);
    const link = document.createElement('a');
    link.className = 'wa-task-log-link';
    link.href = taskController.getTaskViewUrl(taskId);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.dataset.wcLink = 'true';
    link.dataset.wcTaskId = taskId;
    link.textContent = 'Open Task';
    const actions = document.createElement('div');
    actions.className = 'wa-task-summary-actions';
    const actionButton = document.createElement('button');
    actionButton.type = 'button';
    actionButton.className = 'wa-task-inline-action';
    actionButton.hidden = true;
    actions.append(link, actionButton);
    const actionError = document.createElement('div');
    actionError.className = 'wa-task-summary-error';
    actionError.hidden = true;
    body.append(log, actions, actionError);
    const composer = document.createElement('form');
    composer.className = 'wa-task-composer';
    composer.hidden = true;
    const input = document.createElement('textarea');
    input.placeholder = 'Send a message to this task…';
    input.setAttribute('aria-label', 'Task message');
    input.maxLength = 32768;
    input.rows = 2;
    const send = document.createElement('button');
    send.type = 'submit';
    send.textContent = 'Send';
    composer.append(input, send);
    body.appendChild(composer);
    panel.append(summary, body);
    const timeNode = bubble.querySelector(':scope > .wa-message-time');
    if (timeNode) bubble.insertBefore(panel, timeNode);
    else bubble.appendChild(panel);

    let latest = { task: null, ready: false, log: '', logLoaded: false };
    let renderedLog = null;
    let disposed = false;
    let actionPending = '';
    let messagePending = false;
    let actionErrorText = '';
    const resizeInput = () => {
        if (disposed || composer.hidden || body.hidden) return;
        input.style.height = 'auto';
        // scrollHeight includes padding but excludes the two 1px borders.
        const contentHeight = input.value ? Math.ceil(input.scrollHeight) + 2 : 64;
        input.style.height = `${Math.min(180, Math.max(64, contentHeight))}px`;
        input.style.overflowY = contentHeight > 180 ? 'auto' : 'hidden';
        if (contentHeight <= 180) input.scrollTop = 0;
    };
    input.oninput = resizeInput;
    const renderSummary = () => {
        if (disposed) return;
        const task = latest.task;
        const presentation = taskStatusPresentation(task);
        agent.textContent = task?.targetAgent || 'Task';
        description.textContent = task?.description || task?.toolName || (latest.ready ? 'Task data unavailable' : 'Loading task…');
        status.className = `wa-task-status is-${presentation.className}`;
        status.textContent = latest.ready || task ? presentation.label : 'LOADING';
        duration.textContent = taskDurationLabel(task);
        const stopping = task?.status === 'ongoing'
            && String(task?.remoteStatus || '').trim().toLowerCase() === 'cancelling';
        const canStop = task?.status === 'ongoing';
        const canResume = task?.status === 'stopped' && Boolean(task?.continuation?.handle);
        const composerWasHidden = composer.hidden;
        composer.hidden = !task?.continuation?.handle
            || (task.status === 'ongoing' && !task.continuation.messageToolName);
        if (composerWasHidden && !composer.hidden) resizeInput();
        send.disabled = messagePending;
        send.textContent = messagePending ? 'Sending…' : 'Send';
        if (actionPending === 'stop' && (!canStop || stopping || task?.error)) actionPending = '';
        if (actionPending === 'resume' && (task?.status === 'ongoing' || task?.error)) actionPending = '';
        actionButton.hidden = !canStop && !canResume;
        actionButton.disabled = Boolean(actionPending) || stopping;
        actionButton.className = `wa-task-inline-action ${canResume ? 'is-resume' : 'is-stop'}`;
        actionButton.textContent = actionPending === 'resume'
            ? 'Resuming…'
            : (actionPending === 'stop' || stopping ? 'Stopping…' : (canResume ? 'Resume' : 'Stop'));
        const nextLog = latest.logLoaded ? latest.log : '';
        if (nextLog !== renderedLog) {
            const previousScrollTop = log.scrollTop;
            renderTaskLog(
                log,
                nextLog,
                latest.logLoaded ? 'No log output yet.' : 'Loading log…',
                task,
            );
            logFollower.restoreAfterRender(previousScrollTop);
            renderedLog = nextLog;
        }
    };
    summary.onclick = () => {
        const expanded = body.hidden;
        body.hidden = !expanded;
        panel.classList.toggle('is-expanded', expanded);
        summary.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        summary.setAttribute('aria-label', expanded ? 'Collapse task log' : 'Expand task log');
        arrow.textContent = expanded ? '▾' : '▸';
        if (expanded) resizeInput();
        if (expanded && typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => logFollower.restoreAfterRender(log.scrollTop));
        }
    };
    actionButton.onclick = (event) => {
        event.preventDefault?.();
        event.stopPropagation?.();
        if (actionButton.disabled) return;
        const operation = latest.task?.status === 'stopped' ? 'resume' : 'stop';
        actionPending = operation;
        renderSummary();
        const accepted = operation === 'resume'
            ? taskController.resumeTask?.(taskId)
            : taskController.stopTask?.(taskId);
        if (!accepted) {
            actionPending = '';
            renderSummary();
        }
    };
    const unsubscribe = taskController.subscribe(taskId, (value) => {
        if (value?.actionEvent && value.action === 'continue') {
            messagePending = false;
            if (value.actionOk !== false) {
                input.value = '';
                resizeInput();
            }
            else actionErrorText = value.actionError || 'Message was not accepted.';
        }
        if (value?.actionEvent && value.action === actionPending) {
            actionPending = '';
            actionErrorText = value.actionOk === false
                ? (value.actionError || 'Task action failed.')
                : '';
        }
        latest = value;
        actionError.hidden = !actionErrorText;
        actionError.textContent = actionErrorText;
        renderSummary();
    });
    composer.onsubmit = (event) => {
        event.preventDefault();
        const prompt = input.value.trim();
        if (!prompt || messagePending) return;
        messagePending = true;
        actionErrorText = '';
        if (!taskController.continueTask?.(taskId, prompt)) messagePending = false;
        renderSummary();
    };
    input.onkeydown = (event) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
            event.preventDefault(); composer.requestSubmit();
        }
    };
    void taskController.loadLog?.(taskId).catch(() => {
        if (disposed || latest.logLoaded) return;
        latest = { ...latest, log: 'Unable to load task log.', logLoaded: true };
        renderSummary();
    });
    const timer = setInterval(renderSummary, 1000);
    renderSummary();
    return () => {
        disposed = true;
        clearInterval(timer);
        unsubscribe();
    };
}
