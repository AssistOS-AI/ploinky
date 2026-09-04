import {
    renderTaskLog,
    taskDurationLabel,
    taskStatusPresentation,
} from './taskPresentation.js';

function formatTime(value) {
    const date = new Date(value || 0);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString();
}

export function createTaskController({ toEndpoint, sendQuickCommand, elements, showBanner }) {
    const {
        tasksBtn,
        tasksBadge,
        tasksDialog,
        tasksDialogClose,
        tasksList,
        taskDetail,
        taskToast,
        taskToastText,
        taskToastClose,
    } = elements;
    const tasks = new Map();
    const logs = new Map();
    const subscribers = new Map();
    let selectedId = '';
    let toastTimer = null;
    let unreadTerminal = 0;
    let ready = false;

    function orderedTasks() {
        return [...tasks.values()].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    }

    function snapshot(taskId) {
        const log = logs.get(taskId);
        return {
            task: tasks.get(taskId) || null,
            ready,
            log: log?.loaded ? log.text : '',
            logLoaded: log?.loaded === true,
        };
    }

    function notify(taskId) {
        const listeners = subscribers.get(taskId);
        if (!listeners) return;
        const value = snapshot(taskId);
        for (const listener of listeners) listener(value);
    }

    function notifyAll() {
        for (const taskId of subscribers.keys()) notify(taskId);
    }

    function subscribe(taskId, listener) {
        if (!subscribers.has(taskId)) subscribers.set(taskId, new Set());
        subscribers.get(taskId).add(listener);
        listener(snapshot(taskId));
        return () => {
            const listeners = subscribers.get(taskId);
            listeners?.delete(listener);
            if (listeners?.size === 0) subscribers.delete(taskId);
        };
    }

    function updateBadge() {
        if (!tasksBadge) return;
        const ongoing = orderedTasks().filter((task) => task.status === 'ongoing').length;
        const count = ongoing || unreadTerminal;
        tasksBadge.hidden = count === 0;
        tasksBadge.textContent = count ? String(count) : '';
        if (tasksBtn) tasksBtn.title = `${ongoing} ongoing task${ongoing === 1 ? '' : 's'}, ${unreadTerminal} unread update${unreadTerminal === 1 ? '' : 's'}`;
    }

    function hideToast() {
        if (!taskToast) return;
        taskToast.hidden = true;
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = null;
    }

    function showToast(task) {
        if (!taskToast) return;
        const message = `${task.description || task.toolName || 'Task'}: ${taskStatusPresentation(task).label}`;
        if (taskToastText) taskToastText.textContent = message;
        else taskToast.textContent = message;
        taskToast.hidden = false;
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(hideToast, 5000);
    }

    function renderDetail({ stickToEnd = true } = {}) {
        if (!taskDetail) return;
        const task = tasks.get(selectedId);
        taskDetail.replaceChildren();
        if (!task) {
            const empty = document.createElement('div');
            empty.className = 'wa-task-empty';
            empty.textContent = 'Select a task to view its log.';
            taskDetail.appendChild(empty);
            return;
        }
        const heading = document.createElement('div');
        heading.className = 'wa-task-detail-heading';
        const title = document.createElement('h3');
        title.textContent = task.description || task.toolName || task.id;
        const meta = document.createElement('div');
        meta.className = 'wa-task-meta';
        meta.textContent = `${task.targetAgent} · ${task.toolName} · ${formatTime(task.updatedAt)} · ${taskDurationLabel(task)}`;
        const presentation = taskStatusPresentation(task);
        const status = document.createElement('span');
        status.className = `wa-task-status is-${presentation.className}`;
        status.textContent = presentation.label;
        heading.append(title, meta, status);
        if (task.error) {
            const error = document.createElement('div');
            error.className = 'wa-task-error';
            error.textContent = task.error;
            heading.appendChild(error);
        }
        const log = document.createElement('div');
        log.className = 'wa-task-log';
        renderTaskLog(log, logs.get(task.id)?.text || '', 'No log output yet.', task);
        taskDetail.append(heading, log);
        if (stickToEnd) log.scrollTop = log.scrollHeight;
    }

    function renderList() {
        if (!tasksList) return;
        tasksList.replaceChildren();
        const ordered = orderedTasks();
        if (!ordered.length) {
            const empty = document.createElement('div');
            empty.className = 'wa-task-empty';
            empty.textContent = 'No background tasks yet.';
            tasksList.appendChild(empty);
            return;
        }
        for (const task of ordered) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'wa-task-list-item';
            if (task.id === selectedId) button.classList.add('is-selected');
            const description = document.createElement('span');
            description.className = 'wa-task-list-description';
            description.textContent = task.description || task.toolName || task.id;
            const footer = document.createElement('span');
            footer.className = 'wa-task-list-footer';
            const agent = document.createElement('span');
            agent.textContent = `${task.targetAgent || ''} · ${taskDurationLabel(task)}`;
            const presentation = taskStatusPresentation(task);
            const status = document.createElement('span');
            status.className = `wa-task-status is-${presentation.className}`;
            status.textContent = presentation.label;
            footer.append(agent, status);
            button.append(description, footer);
            button.addEventListener('click', () => void selectTask(task.id));
            tasksList.appendChild(button);
        }
    }

    async function loadLog(taskId) {
        if (!await sendQuickCommand?.(`/task view ${taskId}`)) throw new Error('task_command_unavailable');
        return '';
    }

    async function selectTask(taskId) {
        selectedId = taskId;
        renderList();
        renderDetail();
        try {
            await loadLog(taskId);
        } catch (error) {
            showBanner(`Unable to load task log: ${error.message}`, 'err');
        }
    }

    async function refresh() {
        if (!await sendQuickCommand?.('/tasks')) throw new Error('task_command_unavailable');
    }

    function open({ refresh: shouldRefresh = true } = {}) {
        if (!tasksDialog) return;
        unreadTerminal = 0;
        updateBadge();
        tasksDialog.hidden = false;
        if (shouldRefresh) {
            void refresh().catch((error) => showBanner(`Unable to load tasks: ${error.message}`, 'err'));
        }
    }

    function close() {
        if (tasksDialog) tasksDialog.hidden = true;
    }

    function handleUpdate(payload) {
        if (payload?.event === 'list') {
            tasks.clear();
            for (const item of Array.isArray(payload.tasks) ? payload.tasks : []) tasks.set(item.id, item);
            ready = true;
            updateBadge();
            renderList();
            notifyAll();
            return;
        }
        const task = payload?.task;
        if (!task?.id) return;
        const previous = tasks.get(task.id);
        tasks.set(task.id, { ...previous, ...task });
        if (payload.event === 'view' && payload.log) {
            logs.set(task.id, {
                text: typeof payload.log.text === 'string' ? payload.log.text : '',
                offset: Number(payload.log.nextOffset) || 0,
                loaded: true,
            });
        }
        const cache = logs.get(task.id);
        const appended = typeof payload.logAppend === 'string' ? payload.logAppend : '';
        const nextOffset = Number(payload.logOffset);
        if (cache?.loaded && appended) {
            if (!Number.isFinite(nextOffset) || nextOffset > cache.offset) {
                cache.text += appended;
                cache.offset = Number.isFinite(nextOffset) ? nextOffset : cache.text.length;
            } else if (nextOffset < cache.offset) {
                cache.loaded = false;
                void loadLog(task.id).catch(() => {});
            }
        }
        const becameTerminal = previous?.status === 'ongoing' && task.status !== 'ongoing';
        if (becameTerminal) {
            unreadTerminal += 1;
            showToast(task);
        }
        updateBadge();
        renderList();
        notify(task.id);
        if (selectedId === task.id) {
            const currentLog = taskDetail?.querySelector('.wa-task-log');
            const stickToEnd = !currentLog
                || currentLog.scrollHeight - currentLog.scrollTop - currentLog.clientHeight < 24;
            renderDetail({ stickToEnd });
        }
    }

    tasksBtn?.addEventListener('click', open);
    tasksDialogClose?.addEventListener('click', close);
    taskToastClose?.addEventListener('click', hideToast);
    tasksDialog?.addEventListener('click', (event) => {
        if (event.target === tasksDialog) close();
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && tasksDialog && !tasksDialog.hidden) close();
    });
    setInterval(() => {
        if (!tasksDialog || tasksDialog.hidden) return;
        renderList();
        renderDetail({ stickToEnd: false });
    }, 1000);

    return {
        handleUpdate,
        refresh,
        open,
        close,
        subscribe,
        loadLog,
        getTask: (taskId) => tasks.get(taskId) || null,
        getTaskViewUrl: (taskId) => toEndpoint(`tasks/${encodeURIComponent(taskId)}/view`),
    };
}
