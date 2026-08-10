import fs from 'node:fs';
import { spawn } from 'node:child_process';

import { getLogPath } from '../../commands/logUtils.js';
import { requireAdminControlRequest } from '../adminControlSecurity.js';
import { cleanupWhenResponseCloses } from '../streamLifecycle.js';

const appName = 'dashboard';
const LOG_SOURCES = new Set(['router', 'policy']);
const DEFAULT_LINE_COUNT = 200;
const MAX_LINE_COUNT = 5000;

function parseLineCount(value) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isSafeInteger(parsed) || parsed < 1) return DEFAULT_LINE_COUNT;
    return Math.min(parsed, MAX_LINE_COUNT);
}

function sendJson(res, statusCode, body) {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(body));
}

function streamLog(res, { source, lineCount, follow }) {
    const logPath = getLogPath(source);
    if (!follow && !fs.existsSync(logPath)) {
        res.writeHead(200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
        });
        res.end('');
        return;
    }

    res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        ...(follow ? {
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        } : {}),
    });
    res.flushHeaders?.();

    const args = ['-n', String(lineCount), ...(follow ? ['-F'] : []), '--', logPath];
    const child = spawn('tail', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let settled = false;
    const finish = () => {
        if (settled) return;
        settled = true;
        if (!res.writableEnded) res.end();
    };
    const stop = () => {
        if (settled) return;
        settled = true;
        child.kill('SIGTERM');
    };

    child.stdout.pipe(res, { end: false });
    child.once('error', finish);
    child.once('close', finish);
    cleanupWhenResponseCloses(res, stop);
}

function handleDashboard(req, res) {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname.substring(`/${appName}`.length) || '/';

    if (!requireAdminControlRequest(req, res)) return;

    if (pathname === '/' || pathname === '/index.html') {
        sendJson(res, 200, {
            ok: true,
            readOnly: true,
            endpoints: {
                status: '/status/data',
                resources: '/status/data?follow=1',
                logs: '/dashboard/tail?source=router&lines=200&follow=1',
            },
        });
        return;
    }

    if (pathname === '/whoami') {
        sendJson(res, 200, { ok: true, admin: true, readOnly: true });
        return;
    }

    if (pathname === '/tail' && req.method === 'GET') {
        const source = parsedUrl.searchParams.get('source') || 'router';
        if (!LOG_SOURCES.has(source)) {
            sendJson(res, 400, { ok: false, error: 'invalid_log_source' });
            return;
        }
        streamLog(res, {
            source,
            lineCount: parseLineCount(parsedUrl.searchParams.get('lines')),
            follow: parsedUrl.searchParams.get('follow') === '1',
        });
        return;
    }

    res.writeHead(404);
    res.end('Not Found in App');
}

export { handleDashboard, parseLineCount };
