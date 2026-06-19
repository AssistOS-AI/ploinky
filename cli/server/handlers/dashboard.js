import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

import { loadToken, parseCookies, buildCookie, readJsonBody, appendSetCookie } from './common.js';
import * as staticSrv from '../static/index.js';
import { PLOINKY_WORKSPACE_ROOT } from '../../services/config.js';
import { resolveVarValue } from '../../services/secretVars.js';
import { appendLog } from '../utils/logger.js';
import { getConversation as getTranscriptConversation, listConversations as listTranscripts } from '../utils/transcriptStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const appName = 'dashboard';
const fallbackAppPath = path.join(__dirname, '../', appName);
const SID_COOKIE = `${appName}_sid`;

function renderTemplate(filenames, replacements) {
    const target = staticSrv.resolveFirstAvailable(appName, fallbackAppPath, filenames);
    if (!target) return null;
    let html = fs.readFileSync(target, 'utf8');
    for (const [key, value] of Object.entries(replacements || {})) {
        html = html.split(key).join(String(value ?? ''));
    }
    return html;
}

function getSession(req, appState) {
    const cookies = parseCookies(req);
    const sid = cookies.get(SID_COOKIE);
    return (sid && appState.sessions.has(sid)) ? sid : null;
}

function authorized(req, appState) {
    if (req.user) return true;
    return !!getSession(req, appState);
}

async function handleAuth(req, res, appConfig, appState) {
    if (req.user) {
        res.writeHead(400);
        res.end('SSO is enabled; legacy auth disabled.');
        return;
    }
    try {
        const token = loadToken(appName);
        const body = await readJsonBody(req);
        if (body && body.token && String(body.token).trim() === token) {
            const sid = crypto.randomBytes(16).toString('hex');
            appState.sessions.set(sid, { createdAt: Date.now() });
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Set-Cookie': buildCookie(SID_COOKIE, sid, req, `/${appName}`)
            });
            res.end(JSON.stringify({ ok: true }));
        } else {
            res.writeHead(403);
            res.end('Forbidden');
        }
    } catch (_) {
        res.writeHead(400);
        res.end('Bad Request');
    }
}

function ensureAppSession(req, res, appState) {
    const cookies = parseCookies(req);
    let sid = cookies.get(SID_COOKIE);
    if (!sid) {
        sid = crypto.randomBytes(16).toString('hex');
        appState.sessions.set(sid, { createdAt: Date.now() });
        appendSetCookie(res, buildCookie(SID_COOKIE, sid, req, `/${appName}`));
    } else if (!appState.sessions.has(sid)) {
        appState.sessions.set(sid, { createdAt: Date.now() });
    }
    if (!cookies.has(SID_COOKIE)) {
        const existing = req.headers.cookie || '';
        req.headers.cookie = existing ? `${existing}; ${SID_COOKIE}=${sid}` : `${SID_COOKIE}=${sid}`;
    }
    return sid;
}

function readBoolConfig(name, fallback = false) {
    const raw = resolveVarValue(name) || process.env[name] || '';
    if (!raw) return fallback;
    const normalized = String(raw).trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function getTranscriptViewerRoles() {
    const raw = resolveVarValue('PLOINKY_TRANSCRIPT_VIEWER_ROLES')
        || process.env.PLOINKY_TRANSCRIPT_VIEWER_ROLES
        || 'admin,security';
    return raw.split(',')
        .map((value) => String(value || '').trim())
        .filter(Boolean);
}

function getAuditViewerHash(req, appState) {
    const raw = String(req?.user?.id || getSession(req, appState) || '').trim();
    if (!raw) return '[anonymous]';
    return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

function hasTranscriptViewerAccess(req, appState) {
    const localViewerAllowed = readBoolConfig('PLOINKY_TRANSCRIPT_VIEWER_ALLOW_LOCAL', false);
    if (req?.user) {
        if (req.authMode === 'local') {
            return localViewerAllowed;
        }
        const allowedRoles = getTranscriptViewerRoles();
        if (allowedRoles.includes('*')) {
            return true;
        }
        const actualRoles = Array.isArray(req.user.roles) ? req.user.roles.map((value) => String(value || '').trim()) : [];
        return allowedRoles.some((role) => actualRoles.includes(role));
    }
    if (localViewerAllowed && getSession(req, appState)) {
        return true;
    }
    return false;
}

function buildFeedbackSummary({ limit = 1000 } = {}) {
    const transcriptIndex = listTranscripts({ limit });
    const entries = [];
    const totals = {
        conversations: 0,
        ratedTurns: 0,
        positiveTurns: 0,
        negativeTurns: 0,
        agents: {}
    };

    const conversations = Array.isArray(transcriptIndex?.conversations) ? transcriptIndex.conversations : [];
    totals.conversations = conversations.length;

    for (const item of conversations) {
        if (!item?.conversationId) {
            continue;
        }
        let conversation;
        try {
            conversation = getTranscriptConversation(item.conversationId);
        } catch (_) {
            continue;
        }
        const messages = Array.isArray(conversation?.messages) ? conversation.messages : [];
        const byMessageId = new Map(messages.map((message) => [message.messageId, message]));
        for (const message of messages) {
            if (message?.role !== 'assistant' || (message?.rating !== 'up' && message?.rating !== 'down')) {
                continue;
            }
            const metadata = message.metadata && typeof message.metadata === 'object' ? message.metadata : {};
            const promptMessageId = typeof metadata.promptMessageId === 'string' ? metadata.promptMessageId.trim() : '';
            const userMessage = promptMessageId ? byMessageId.get(promptMessageId) : null;
            const createdAt = message.createdAt || conversation.updatedAt || conversation.createdAt || null;
            const agentName = conversation.agentName || item.agentName || 'webchat';
            const rating = message.rating;

            totals.ratedTurns += 1;
            if (rating === 'up') {
                totals.positiveTurns += 1;
            } else {
                totals.negativeTurns += 1;
            }

            const agentBucket = totals.agents[agentName] || {
                agentName,
                ratedTurns: 0,
                positiveTurns: 0,
                negativeTurns: 0
            };
            agentBucket.ratedTurns += 1;
            if (rating === 'up') {
                agentBucket.positiveTurns += 1;
            } else {
                agentBucket.negativeTurns += 1;
            }
            totals.agents[agentName] = agentBucket;

            entries.push({
                conversationId: conversation.conversationId,
                turnId: typeof metadata.turnId === 'string' ? metadata.turnId : '',
                rating,
                agentName,
                runtime: conversation.runtime || '',
                authMode: conversation.authMode || '',
                createdAt,
                userMessageId: userMessage?.messageId || promptMessageId || '',
                assistantMessageId: message.messageId,
                userText: userMessage?.text || '',
                assistantText: message.text || ''
            });
        }
    }

    entries.sort((left, right) => Date.parse(right.createdAt || 0) - Date.parse(left.createdAt || 0));

    const agents = Object.values(totals.agents)
        .map((agent) => ({
            ...agent,
            positiveRate: agent.ratedTurns ? Number((agent.positiveTurns / agent.ratedTurns).toFixed(4)) : 0,
            negativeRate: agent.ratedTurns ? Number((agent.negativeTurns / agent.ratedTurns).toFixed(4)) : 0
        }))
        .sort((left, right) => right.ratedTurns - left.ratedTurns || left.agentName.localeCompare(right.agentName));

    const ratedTurns = totals.ratedTurns;
    return {
        retentionDays: transcriptIndex?.retentionDays || null,
        summary: {
            conversations: totals.conversations,
            ratedTurns,
            positiveTurns: totals.positiveTurns,
            negativeTurns: totals.negativeTurns,
            positiveRate: ratedTurns ? Number((totals.positiveTurns / ratedTurns).toFixed(4)) : 0,
            negativeRate: ratedTurns ? Number((totals.negativeTurns / ratedTurns).toFixed(4)) : 0
        },
        agents,
        turns: entries
    };
}

function handleDashboard(req, res, appConfig, appState) {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname.substring(`/${appName}`.length) || '/';

    if (pathname === '/auth' && req.method === 'POST') return handleAuth(req, res, appConfig, appState);
    if (pathname === '/whoami') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: authorized(req, appState) }));
    }

    if (req.user) {
        ensureAppSession(req, res, appState);
    }

    if (pathname.startsWith('/assets/')) {
        const rel = pathname.substring('/assets/'.length);
        const assetPath = staticSrv.resolveAssetPath(appName, fallbackAppPath, rel);
        if (assetPath && staticSrv.sendFile(res, assetPath)) return;
    }

    if (!authorized(req, appState)) {
        if (req.user) {
            res.writeHead(403);
            return res.end('Access forbidden');
        }
        const html = renderTemplate(['login.html', 'index.html'], {
            '__ASSET_BASE__': `/${appName}/assets`,
            '__AGENT_NAME__': appConfig.agentName || 'Dashboard',
            '__CONTAINER_NAME__': appConfig.containerName || '-',
            '__RUNTIME__': appConfig.runtime || 'local',
            '__REQUIRES_AUTH__': 'true',
            '__BASE_PATH__': `/${appName}`
        });
        if (html) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            return res.end(html);
        }
        res.writeHead(403); return res.end('Forbidden');
    }

    if (pathname === '/api/transcripts' && req.method === 'GET') {
        if (!hasTranscriptViewerAccess(req, appState)) {
            res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            return res.end(JSON.stringify({
                ok: false,
                error: 'transcript_access_denied',
                detail: 'Transcript viewing requires an authenticated user session, or local dashboard access when transcript viewing is explicitly enabled.'
            }));
        }
        const limit = Math.max(1, Math.min(200, parseInt(parsedUrl.searchParams.get('limit') || '50', 10) || 50));
        try {
            const result = listTranscripts({ limit });
            appendLog('transcript_list_access', {
                viewerHash: getAuditViewerHash(req, appState),
                count: result.conversations.length
            });
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            return res.end(JSON.stringify({ ok: true, ...result }));
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            return res.end(JSON.stringify({ ok: false, error: error?.message || 'transcript_list_failed' }));
        }
    }

    if (pathname === '/api/feedback' && req.method === 'GET') {
        if (!hasTranscriptViewerAccess(req, appState)) {
            res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            return res.end(JSON.stringify({
                ok: false,
                error: 'transcript_access_denied',
                detail: 'Feedback viewing requires transcript viewer access.'
            }));
        }
        const limit = Math.max(1, Math.min(5000, parseInt(parsedUrl.searchParams.get('limit') || '1000', 10) || 1000));
        const ratingFilter = String(parsedUrl.searchParams.get('rating') || 'all').trim().toLowerCase();
        try {
            const result = buildFeedbackSummary({ limit });
            const turns = ratingFilter === 'up' || ratingFilter === 'down'
                ? result.turns.filter((turn) => turn.rating === ratingFilter)
                : result.turns;
            appendLog('feedback_summary_access', {
                viewerHash: getAuditViewerHash(req, appState),
                count: turns.length
            });
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            return res.end(JSON.stringify({ ok: true, retentionDays: result.retentionDays, summary: result.summary, agents: result.agents, turns }));
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            return res.end(JSON.stringify({ ok: false, error: error?.message || 'feedback_summary_failed' }));
        }
    }

    if (pathname.startsWith('/api/transcripts/') && req.method === 'GET') {
        if (!hasTranscriptViewerAccess(req, appState)) {
            res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            return res.end(JSON.stringify({
                ok: false,
                error: 'transcript_access_denied',
                detail: 'Transcript viewing requires an authenticated user session, or local dashboard access when transcript viewing is explicitly enabled.'
            }));
        }
        const conversationId = decodeURIComponent(pathname.slice('/api/transcripts/'.length)).trim();
        if (!conversationId) {
            res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            return res.end(JSON.stringify({ ok: false, error: 'missing_conversation_id' }));
        }
        try {
            const conversation = getTranscriptConversation(conversationId);
            appendLog('transcript_detail_access', {
                viewerHash: getAuditViewerHash(req, appState),
                conversationId
            });
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            return res.end(JSON.stringify({ ok: true, conversation }));
        } catch (error) {
            const notFound = /enoent/i.test(String(error?.message || ''));
            res.writeHead(notFound ? 404 : 500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            return res.end(JSON.stringify({ ok: false, error: notFound ? 'transcript_not_found' : (error?.message || 'transcript_detail_failed') }));
        }
    }

    if (pathname === '/' || pathname === '/index.html') {
        const html = renderTemplate(['dashboard.html', 'index.html'], {
            '__ASSET_BASE__': `/${appName}/assets`,
            '__AGENT_NAME__': appConfig.agentName || 'Dashboard',
            '__CONTAINER_NAME__': appConfig.containerName || '-',
            '__RUNTIME__': appConfig.runtime || 'local',
            '__REQUIRES_AUTH__': 'true',
            '__BASE_PATH__': `/${appName}`
        });
        if (html) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            return res.end(html);
        }
    }

    if (pathname === '/run' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
            try {
                const { cmd } = JSON.parse(body);
                const args = (cmd || '').trim().split(/\s+/).filter(Boolean);
                const proc = spawn('ploinky', args, { cwd: PLOINKY_WORKSPACE_ROOT, env: { ...process.env, PLOINKY_CWD: PLOINKY_WORKSPACE_ROOT } });
                let out = ''; let err = '';
                proc.stdout.on('data', d => out += d.toString('utf8'));
                proc.stderr.on('data', d => err += d.toString('utf8'));
                proc.on('close', (code) => {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, code, stdout: out, stderr: err }));
                });
            } catch (e) {
                res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e.message }));
            }
        });
        return;
    }

    res.writeHead(404); res.end('Not Found in App');
}

export { handleDashboard };
