import { renderLogMarkdown } from './logMarkdown.js';
import { normalizeTaskLiveSession } from './taskLiveSession.js';
import { normalizeTaskDetails } from './taskDetails.js';

const TERMINAL_STATUSES = new Set(['finished', 'paused', 'error']);
const ANSI_RE = /[\u001b\u009b][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
const STREAM_PREFIX_RE = /^\[([^\]]+)\s+(stdout|stderr)\]\s?/i;
const RUNNER_PREFIX_RE = /^\[[^\]]+\/[^\]]+\]\s?/;
export function taskStatusPresentation(task) {
    if (!task) return { label: 'UNAVAILABLE', className: 'unavailable' };
    if (task.status === 'finished') return { label: 'COMPLETED', className: 'finished' };
    if (task.status === 'paused') return { label: 'PAUSED', className: 'paused' };
    if (task.status === 'error') return { label: 'FAILED', className: 'error' };
    const remoteStatus = String(task.remoteStatus || '').trim().toLowerCase();
    if (remoteStatus === 'cancelling') {
        return { label: 'PAUSING', className: 'cancelling' };
    }
    if (remoteStatus === 'pending' || remoteStatus === 'queued') {
        return { label: 'QUEUED', className: 'queued' };
    }
    return { label: 'RUNNING', className: 'running' };
}

export function taskDurationSeconds(task, now = Date.now()) {
    if (Number.isFinite(task?.elapsedMs) && task.elapsedMs >= 0) {
        const since = Date.parse(task.activeSince || '');
        const current = task.status === 'ongoing' && Number.isFinite(since) ? Math.max(0, now - since) : 0;
        return Math.floor((task.elapsedMs + current) / 1000);
    }
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

export function taskDetailsLink(value) {
    return normalizeTaskDetails(value);
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
    // Parse whole consecutive blocks so lists, tables and code fences span lines.
    const blocks = [];
    for (const entry of lines) {
        const className = `wa-log-block wa-log-markdown is-${entry.stream} is-${entry.tone} is-${entry.kind || 'output'}`;
        const previous = blocks.at(-1);
        if (previous?.className === className) previous.text += '\n' + entry.text;
        else blocks.push({ className, text: entry.text });
    }
    for (const block of blocks) {
        if (!block.text.trim()) continue;
        const node = document.createElement('div');
        node.className = block.className;
        renderLogMarkdown(node, block.text);
        container.appendChild(node);
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
    const description = document.createElement('span');
    description.className = 'wa-task-summary-description';
    const status = document.createElement('span');
    const duration = document.createElement('span');
    duration.className = 'wa-task-summary-duration';
    summary.append(agent, description, status, duration);
    const body = document.createElement('div');
    body.className = 'wa-task-summary-body';
    body.id = `task-summary-body-${taskId}`;
    body.hidden = false;
    const actions = document.createElement('div');
    actions.className = 'wa-task-summary-actions';
    const link = document.createElement('a');
    link.className = 'wa-task-log-link';
    link.href = taskController.getTaskViewUrl(taskId);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.dataset.wcLink = 'true';
    link.dataset.wcTaskId = taskId;
    link.textContent = 'View Task Details';
    const logs = document.createElement('a');
    logs.className = 'wa-task-log-link';
    logs.href = taskController.getTaskViewUrl(taskId);
    logs.target = '_blank';
    logs.rel = 'noopener noreferrer';
    logs.dataset.wcLink = 'true';
    logs.dataset.wcTaskId = taskId;
    logs.textContent = 'View task logs';
    logs.hidden = true;
    const live = document.createElement('a');
    live.className = 'wa-task-log-link';
    live.target = '_blank';
    live.rel = 'noopener noreferrer';
    live.dataset.wcLink = 'true';
    live.hidden = true;
    actions.append(link, logs, live);
    body.append(actions);
    panel.append(summary, body);
    const timeNode = bubble.querySelector(':scope > .wa-message-time');
    if (timeNode) bubble.insertBefore(panel, timeNode);
    else bubble.appendChild(panel);
    let latest = { task: null, ready: false };
    const render = () => {
        const task = latest.task;
        const presentation = taskStatusPresentation(task);
        agent.textContent = task?.robotName ? `Robot: ${task.robotName}` : task?.targetAgent ? `Agent: ${task.targetAgent}` : 'Loading robot…';
        description.textContent = task?.description || task?.toolName || 'Loading task…';
        status.className = `wa-task-status is-${presentation.className}`;
        status.textContent = latest.ready || task ? presentation.label : 'LOADING';
        duration.textContent = taskDurationLabel(task);
        const details = taskDetailsLink(task?.details);
        link.href = details ? details.url : taskController.getTaskViewUrl(taskId);
        link.textContent = details?.label || 'View Task Details';
        if (details) delete link.dataset.wcTaskId;
        else link.dataset.wcTaskId = taskId;
        logs.hidden = !details;
        if (details) logs.textContent = details.logsLabel || 'View task logs';
        const session = normalizeTaskLiveSession(task?.liveSession);
        live.hidden = !session;
        if (session) {
            live.href = session.url;
            live.textContent = session.mode === 'browser' ? 'Open live browser' : 'Open live desktop';
        }
    };
    const unsubscribe = taskController.subscribe(taskId, value => { latest = value; render(); });
    const timer = setInterval(render, 1000);
    render();
    return () => { clearInterval(timer); unsubscribe(); };
}
