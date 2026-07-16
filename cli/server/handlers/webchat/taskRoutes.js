import { listTasks, readTaskLog } from '../../webchat/taskStore.js';

function sendJson(res, status, payload) {
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(payload));
}

function sendHtml(res, status, html) {
    res.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Pragma: 'no-cache',
        Expires: '0',
    });
    res.end(html);
}

export function handleTaskRoute({
    pathname,
    req,
    res,
    parsedUrl,
    workspaceDirectory,
    renderTaskView,
}) {
    if (pathname === '/tasks' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, tasks: listTasks(workspaceDirectory) });
        return true;
    }

    const match = /^\/tasks\/(task_[0-9a-f]{24})\/log$/.exec(pathname);
    if (match && req.method === 'GET') {
        try {
            const log = readTaskLog(workspaceDirectory, match[1], parsedUrl.searchParams.get('offset'));
            sendJson(res, 200, { ok: true, ...log });
        } catch (error) {
            sendJson(res, 400, { ok: false, error: error?.message || 'invalid_task_log' });
        }
        return true;
    }

    const viewMatch = /^\/tasks\/(task_[0-9a-f]{24})\/view$/.exec(pathname);
    if (viewMatch && req.method === 'GET') {
        const html = typeof renderTaskView === 'function' ? renderTaskView(viewMatch[1]) : '';
        if (!html) {
            sendHtml(res, 404, 'Task view unavailable.');
            return true;
        }
        sendHtml(res, 200, html);
        return true;
    }
    return false;
}
