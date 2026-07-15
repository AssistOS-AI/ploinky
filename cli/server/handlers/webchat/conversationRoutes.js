import { readJsonBody } from '../common.js';
import {
    createSession,
    listSessions,
    loadSession,
    selectSession,
    summarizeSession
} from '../../webchat/sessionStore.js';
import { broadcastWorkspaceSessionChange } from './runtimeState.js';

export async function handleConversationRoute({ pathname, req, res, workspaceDirectory, appState }) {
    if (pathname === '/sessions' && req.method === 'GET') {
        try {
            const payload = listSessions(workspaceDirectory);
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ ok: true, ...payload }));
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ ok: false, error: error?.message || 'session_store_unavailable' }));
        }
        return true;
    }

    if (pathname === '/sessions' && req.method === 'POST') {
        try {
            const created = createSession(workspaceDirectory);
            broadcastWorkspaceSessionChange(appState, workspaceDirectory, created);
            res.writeHead(201, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ ok: true, session: summarizeSession(created) }));
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ ok: false, error: error?.message || 'session_create_failed' }));
        }
        return true;
    }

    if (pathname === '/sessions/current' && req.method === 'PUT') {
        try {
            const body = await readJsonBody(req);
            const selected = selectSession(workspaceDirectory, body?.sessionId);
            broadcastWorkspaceSessionChange(appState, workspaceDirectory, selected);
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ ok: true, session: summarizeSession(selected) }));
        } catch (error) {
            const status = /invalid_session|ENOENT/.test(String(error?.message || error)) ? 400 : 500;
            res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ ok: false, error: status === 400 ? 'invalid_session' : 'session_select_failed' }));
        }
        return true;
    }

    if (pathname.startsWith('/sessions/') && req.method === 'GET') {
        try {
            const sessionId = decodeURIComponent(pathname.slice('/sessions/'.length));
            const loaded = loadSession(workspaceDirectory, sessionId);
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ ok: true, session: loaded }));
        } catch (error) {
            const status = /invalid_session|ENOENT/.test(String(error?.message || error)) ? 404 : 500;
            res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ ok: false, error: status === 404 ? 'session_not_found' : 'session_load_failed' }));
        }
        return true;
    }

    return false;
}
