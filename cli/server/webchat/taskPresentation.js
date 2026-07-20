const TERMINAL_STATUSES = new Set(['finished', 'stopped', 'error']);
const ANSI_RE = /[\u001b\u009b][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
const STREAM_PREFIX_RE = /^\[([^\]]+)\s+(stdout|stderr)\]\s?/i;
const RUNNER_PREFIX_RE = /^\[[^\]]+\/[^\]]+\]\s?/;

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

function parseTaskLogEntries(text, finalOutput = null) {
    const rawText = String(text || '');
    const lines = rawText.split(/\r?\n/);
    let cursor = 0;
    return lines.flatMap((unstrippedLine) => {
        const lineStart = cursor;
        const lineEnd = lineStart + unstrippedLine.length;
        const separatorLength = rawText.startsWith('\r\n', lineEnd)
            ? 2
            : (rawText[lineEnd] === '\n' ? 1 : 0);
        cursor = lineEnd + separatorLength;
        const finalStart = Number.isSafeInteger(finalOutput?.offset)
            ? finalOutput.offset
            : null;
        const finalEnd = finalStart === null
            ? null
            : finalStart + Math.max(0, Number(finalOutput?.length) || 0);
        const tone = finalStart !== null && finalEnd > lineStart && finalStart < lineEnd
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
        if (/^\[(?:task result|older task log content truncated)\]$/i.test(line.trim())) {
            return line.trim().toLowerCase() === '[task result]'
                ? []
                : [{ text: 'Older task log content was truncated.', stream: 'stderr', tone }];
        }
        if (/^\[task log source truncated or restarted\]$/i.test(line.trim())) {
            return [{ text: 'Task log source was truncated or restarted.', stream: 'stderr', tone }];
        }
        return [{ text: line, stream, tone }];
    });
}

export function parseTaskLog(text) {
    return parseTaskLogEntries(text).map(({ text: lineText, stream }) => ({
        text: lineText,
        stream,
    }));
}

export function parseTaskLogPresentation(text, task = null) {
    return parseTaskLogEntries(text, {
        offset: task?.finalOutputOffset,
        length: task?.finalOutputLength,
    });
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
        line.className = `wa-task-log-line is-${entry.stream} is-${entry.tone}`;
        line.textContent = entry.text || '\u00a0';
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
    panel.className = 'wa-task-summary';
    panel.dataset.taskId = taskId;
    const summary = document.createElement('div');
    summary.className = 'wa-task-summary-row';
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
    summary.append(agent, description, status, duration);
    const link = document.createElement('a');
    link.className = 'wa-task-log-link';
    link.href = taskController.getTaskViewUrl(taskId);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.dataset.wcLink = 'true';
    link.dataset.wcTaskId = taskId;
    link.textContent = 'View task details';
    panel.append(summary, link);
    const timeNode = bubble.querySelector(':scope > .wa-message-time');
    if (timeNode) bubble.insertBefore(panel, timeNode);
    else bubble.appendChild(panel);

    let latest = { task: null, ready: false };
    let disposed = false;
    const renderSummary = () => {
        if (disposed) return;
        const task = latest.task;
        const presentation = taskStatusPresentation(task);
        agent.textContent = task?.targetAgent || 'Task';
        description.textContent = task?.description || task?.toolName || (latest.ready ? 'Task data unavailable' : 'Loading task…');
        status.className = `wa-task-status is-${presentation.className}`;
        status.textContent = latest.ready || task ? presentation.label : 'LOADING';
        duration.textContent = taskDurationLabel(task);
    };
    const unsubscribe = taskController.subscribe(taskId, (value) => {
        latest = value;
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
