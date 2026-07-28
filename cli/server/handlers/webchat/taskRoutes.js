function sendHtml(res, status, html) {
    res.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Pragma: 'no-cache',
        Expires: '0',
    });
    res.end(html);
}

export async function handleTaskRoute({ pathname, req, res, renderTaskView }) {
    const viewMatch = /^\/tasks\/(task_[0-9a-f]{24})\/view$/.exec(pathname);
    if (!viewMatch || req.method !== 'GET') return false;
    const html = typeof renderTaskView === 'function' ? renderTaskView(viewMatch[1]) : '';
    if (!html) {
        sendHtml(res, 404, 'Task view unavailable.');
        return true;
    }
    sendHtml(res, 200, html);
    return true;
}

export const __testables = {};
