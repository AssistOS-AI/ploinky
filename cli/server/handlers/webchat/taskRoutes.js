import { listTasks, readTaskLog } from '../../webchat/taskStore.js';

function sendJson(res, status, payload) {
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(payload));
}

export function handleTaskRoute({ pathname, req, res, parsedUrl, workspaceDirectory }) {
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
    return false;
}
