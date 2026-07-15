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
    if (remoteStatus === 'pending' || remoteStatus === 'queued') {
        return { label: 'QUEUED', className: 'queued' };
    }
    return { label: 'RUNNING', className: 'running' };
}

export function taskDurationSeconds(task, now = Date.now()) {
    const start = Date.parse(task?.createdAt || '');
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

export function parseTaskLog(text) {
    const lines = String(text || '').replace(ANSI_RE, '').split(/\r?\n/);
    return lines.flatMap((rawLine) => {
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
                : [{ text: 'Older task log content was truncated.', stream: 'stderr' }];
        }
        if (/^\[task log source truncated or restarted\]$/i.test(line.trim())) {
            return [{ text: 'Task log source was truncated or restarted.', stream: 'stderr' }];
        }
        return [{ text: line, stream }];
    });
}

export function renderTaskLog(container, text, emptyText = 'No log output yet.') {
    if (!container) return;
    container.replaceChildren();
    const lines = parseTaskLog(text);
    if (!lines.length || lines.every((line) => !line.text)) {
        const empty = document.createElement('span');
        empty.className = 'wa-task-log-empty';
        empty.textContent = emptyText;
        container.appendChild(empty);
        return;
    }
    for (const entry of lines) {
        const line = document.createElement('span');
        line.className = `wa-task-log-line is-${entry.stream}`;
        line.textContent = entry.text || '\u00a0';
        container.appendChild(line);
    }
}

export function attachInlineTaskPanel({ bubble, taskId, taskController }) {
    const panel = document.createElement('div');
    panel.className = 'wa-inline-task is-collapsed';
    panel.dataset.taskId = taskId;
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'wa-inline-task-toggle';
    toggle.setAttribute('aria-expanded', 'false');
    const arrow = document.createElement('span');
    arrow.className = 'wa-inline-task-arrow';
    arrow.textContent = '▸';
    const agent = document.createElement('strong');
    agent.className = 'wa-inline-task-agent';
    agent.textContent = 'Task';
    const description = document.createElement('span');
    description.className = 'wa-inline-task-description';
    const status = document.createElement('span');
    status.className = 'wa-task-status is-unavailable';
    status.textContent = 'LOADING';
    const duration = document.createElement('span');
    duration.className = 'wa-inline-task-duration';
    toggle.append(arrow, agent, description, status, duration);
    const log = document.createElement('div');
    log.className = 'wa-task-log wa-inline-task-log';
    const error = document.createElement('div');
    error.className = 'wa-task-error wa-inline-task-error';
    error.hidden = true;
    panel.append(toggle, error, log);
    const timeNode = bubble.querySelector(':scope > .wa-message-time');
    if (timeNode) bubble.insertBefore(panel, timeNode);
    else bubble.appendChild(panel);

    let latest = { task: null, ready: false, log: '', logLoaded: false };
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
        error.hidden = !task?.error;
        error.textContent = task?.error || '';
    };
    const renderLog = () => {
        if (disposed || !panel.classList.contains('is-expanded')) return;
        const previousScrollTop = log.scrollTop;
        const stickToEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
        renderTaskLog(log, latest.log, latest.logLoaded ? 'No log output yet.' : 'Loading log…');
        log.scrollTop = stickToEnd ? log.scrollHeight : previousScrollTop;
    };
    const unsubscribe = taskController.subscribe(taskId, (value) => {
        const logChanged = value.log !== latest.log || value.logLoaded !== latest.logLoaded;
        latest = value;
        renderSummary();
        if (logChanged) renderLog();
    });
    const timer = setInterval(renderSummary, 1000);
    toggle.addEventListener('click', () => {
        const expanded = panel.classList.toggle('is-expanded');
        panel.classList.toggle('is-collapsed', !expanded);
        toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        arrow.textContent = expanded ? '▾' : '▸';
        if (expanded && !latest.logLoaded) {
            renderSummary();
            renderLog();
            void taskController.loadLog(taskId).catch(() => {
                latest = { ...latest, logLoaded: true, log: 'Unable to load task log.' };
                renderSummary();
                renderLog();
            });
        } else {
            renderSummary();
            renderLog();
        }
    });
    renderSummary();
    return () => {
        disposed = true;
        clearInterval(timer);
        unsubscribe();
    };
}
