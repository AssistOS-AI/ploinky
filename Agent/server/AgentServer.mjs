import { randomUUID } from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { TaskQueue } from './TaskQueue.mjs';
import { createToolWorkerPools, shutdownToolWorkerPools } from './toolWorkerPool.mjs';
import { agentServerIdentityInputs, createAgentServerCodeIdentity, formatIdentityMeasures } from './toolCodeIdentity.mjs';
import { createAgentServerCodeIdentityThread } from './toolCodeIdentityThread.mjs';
import { preserveJsonSchemaToolListings } from './inputSchema.mjs';
import { getConfiguredToolInputSchema } from './toolInputSchemaCache.mjs';
import {
    createMemoryReplayCache
} from '../lib/jwtVerify.mjs';
import {
    hasInvocationTokenHeader,
    verifyRouterRequestFromHeaders,
    verifyOpenAiServiceAuthInfoFromHeaders,
    verifyOpenAiModelsAuthInfoFromHeaders
} from '../lib/invocationAuth.mjs';
import { computeRchTool, sha256RawBodyHash } from '../lib/requestHash.mjs';
import { describeShellFailure, describeShellFailureDetails } from '../lib/toolError.mjs';
import {
    buildDefaultOpenAiChatResponse,
    buildDefaultStreamRejection
} from './openAiDefaultResponder.mjs';
import { buildLoopToolsFromMcp } from './mcpToolBridge.mjs';
import { importAgentLibFile } from '../lib/agentlibResolve.mjs';
// achillesAgentLib is resolved from the one selected source through the
// explicit resolver, never from an install tree next to this file.
const { isOptOutModel, runOpenAiAgenticResponse } = await importAgentLibFile(
    'LLMAgents/openAiAgenticResponder.mjs',
);

const DEFAULT_MAX_CONCURRENT_TASKS = 10;
const DEFAULT_TASK_LOG_TAIL_BYTES = 128 * 1024;
// The agent code directory is read-only in production. Every supported
// runtime supplies a dedicated writable HOME for this exact agent, so durable
// restart state belongs there rather than beside the staged code.
const taskQueueHome = String(process.env.HOME || '').trim();
const TASK_QUEUE_FILE = path.join(
    taskQueueHome && path.isAbsolute(taskQueueHome) ? taskQueueHome : process.cwd(),
    '.tasksQueue',
);
const invocationReplayCache = createMemoryReplayCache({ maxSize: 4096 });
const OPENAI_CHAT_COMPLETIONS_PATH = '/v1/chat/completions';
const OPENAI_MODELS_PATH = '/v1/models';
const AGENT_CARD_PATH = '/agent-card';
const TASK_STATUS_PATHS = new Set(['/getTaskStatus', '/task']);
const TASK_CANCEL_PATH = '/task/cancel';
const TASK_CANCEL_TOOL = '__task_cancel__';
const TAG_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;

function verifyInvocationForRequest({ requestHeaders, method, path, tool, argumentsObj }) {
    // Recompute the request-content-hash from the actual request surface and
    // verify the router-minted token binds exactly this method/path/tool/rch.
    const rch = computeRchTool({ method, path, tool, arguments: argumentsObj || {} });
    return verifyRouterRequestFromHeaders(requestHeaders, {
        env: process.env,
        replayCache: invocationReplayCache,
        method,
        path,
        tool,
        rch,
    });
}

// AgentServer (MCP over HTTP): exposes tools/resources via Streamable HTTP transport on PORT (default 7000) at /mcp.

async function loadSdkDeps() {
    const { types,  streamHttp, mcp } = await import('mcp-sdk');
    return {
        McpServer: mcp.McpServer,
        ResourceTemplate: mcp.ResourceTemplate,
        StreamableHTTPServerTransport:  streamHttp.StreamableHTTPServerTransport,
        isInitializeRequest: types.isInitializeRequest,
        McpError: types.McpError,
        ErrorCode: types.ErrorCode
    };
}

function resolveConfigPaths() {
    const explicit = [
        process.env.PLOINKY_AGENT_CONFIG,
        process.env.MCP_CONFIG_FILE,
        process.env.AGENT_CONFIG_FILE
    ].filter(Boolean);
    const defaults = [
        process.env.PLOINKY_MCP_CONFIG_PATH,
        '/tmp/ploinky/mcp-config.json',
        `${process.env.PLOINKY_CODE_DIR || '/code'}/mcp-config.json`,
        path.join(process.cwd(), 'mcp-config.json')
    ];
    return [...explicit, ...defaults];
}

function loadConfig() {
    const candidates = resolveConfigPaths();
    for (const candidate of candidates) {
        if (!candidate) continue;
        try {
            const stat = fs.statSync(candidate);
            if (!stat.isFile()) continue;
            const raw = fs.readFileSync(candidate, 'utf8');
            const parsed = JSON.parse(raw);
            return { source: candidate, config: parsed };
        } catch (err) {
            if (err.code === 'ENOENT') continue;
            if (err instanceof SyntaxError) {
                console.error(`[AgentServer/MCP] Failed to parse config '${candidate}': ${err.message}`);
            } else {
                console.error(`[AgentServer/MCP] Cannot read config '${candidate}': ${err.message}`);
            }
        }
    }
    return null;
}

let cachedConfigResult = null;
function getConfigResult() {
    if (!cachedConfigResult) {
        cachedConfigResult = loadConfig();
    }
    return cachedConfigResult;
}

function resolveManifestPaths() {
    const explicit = [
        process.env.PLOINKY_AGENT_MANIFEST,
        process.env.PLOINKY_MANIFEST_FILE,
        process.env.AGENT_MANIFEST_FILE
    ].filter(Boolean);
    const defaults = [
        `${process.env.PLOINKY_CODE_DIR || '/code'}/manifest.json`,
        path.join(process.cwd(), 'manifest.json')
    ];
    return [...explicit, ...defaults];
}

function loadManifest() {
    const candidates = resolveManifestPaths();
    for (const candidate of candidates) {
        if (!candidate) continue;
        try {
            const stat = fs.statSync(candidate);
            if (!stat.isFile()) continue;
            const raw = fs.readFileSync(candidate, 'utf8');
            const parsed = JSON.parse(raw);
            return { source: candidate, manifest: parsed };
        } catch (err) {
            if (err.code === 'ENOENT') continue;
            if (err instanceof SyntaxError) {
                console.error(`[AgentServer/manifest] Failed to parse manifest '${candidate}': ${err.message}`);
            } else {
                console.error(`[AgentServer/manifest] Cannot read manifest '${candidate}': ${err.message}`);
            }
        }
    }
    return null;
}

let cachedManifestResult = null;
function getManifestResult() {
    if (!cachedManifestResult) {
        cachedManifestResult = loadManifest();
    }
    return cachedManifestResult;
}

function resolveStaticRoot() {
    return process.env.PLOINKY_CODE_DIR || '/code';
}

function sanitizeStaticRequestPath(requestPath) {
    let decoded = '';
    try {
        decoded = decodeURIComponent(String(requestPath || '/'));
    } catch (_) {
        return null;
    }
    if (decoded.includes('\0')) return null;
    if (decoded.replace(/\\/g, '/').split('/').some((part) => part === '..')) return null;
    const normalized = path.posix.normalize(`/${decoded.replace(/\\/g, '/')}`);
    if (normalized.includes('/../') || normalized === '/..') return null;
    return normalized.replace(/^\/+/, '');
}

function isPathInsideRoot(root, candidate, { allowMissing = false } = {}) {
    const resolvedRoot = path.resolve(root);
    const resolvedCandidate = allowMissing
        ? path.resolve(candidate)
        : path.resolve(candidate);
    const relative = path.relative(resolvedRoot, resolvedCandidate);
    return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

async function resolveStaticFile(requestPath) {
    const root = resolveStaticRoot();
    if (!root) return null;
    const rel = sanitizeStaticRequestPath(requestPath);
    if (rel === null) return null;
    const candidate = path.join(root, rel || 'index.html');
    if (!isPathInsideRoot(root, candidate, { allowMissing: true })) return null;
    try {
        const stat = await fs.promises.stat(candidate);
        if (stat.isDirectory()) {
            for (const name of ['index.html', 'index.htm', 'default.html']) {
                const indexPath = path.join(candidate, name);
                try {
                    const indexStat = await fs.promises.stat(indexPath);
                    if (indexStat.isFile() && isPathInsideRoot(root, indexPath)) {
                        return indexPath;
                    }
                } catch (_) {
                    continue;
                }
            }
            return null;
        }
        if (stat.isFile() && isPathInsideRoot(root, candidate)) return candidate;
    } catch (_) {
        return null;
    }
    return null;
}

function getStaticMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const types = {
        '.html': 'text/html; charset=utf-8',
        '.htm': 'text/html; charset=utf-8',
        '.js': 'application/javascript',
        '.mjs': 'application/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.ico': 'image/x-icon',
        '.webp': 'image/webp',
        '.woff2': 'font/woff2',
        '.woff': 'font/woff',
        '.ttf': 'font/ttf',
        '.otf': 'font/otf',
        '.pdf': 'application/pdf'
    };
    return types[ext] || 'application/octet-stream';
}

function isStaticHtml(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return ext === '.html' || ext === '.htm';
}

// Mirror of the router rule (cli/server/static): a GET/HEAD whose
// Sec-Fetch-Dest is exactly `empty` is a fetched template. Anything else,
// including a repeated header, fails safe to the navigation class.
function isFetchedTemplateRequest(req) {
    const method = String(req?.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') return false;
    const dest = req?.headers?.['sec-fetch-dest'];
    if (typeof dest !== 'string') return false;
    return dest.trim().toLowerCase() === 'empty';
}

function getStaticCacheControl(filePath, { fetchedTemplate = false } = {}) {
    const ext = path.extname(filePath).toLowerCase();
    // HTML documents are application entry points; never store them (matches
    // the router document policy in cli/server/static). Fetched templates are
    // stored privately but must be revalidated. Agent static is only reachable
    // through the authenticated router.
    if (ext === '.html' || ext === '.htm') {
        return fetchedTemplate ? 'private, no-cache' : 'no-store';
    }
    // Agent static is only reachable through the authenticated router, so a
    // shared cache must never keep it.
    if (['.woff2', '.woff', '.ttf', '.otf'].includes(ext)) {
        return 'private, max-age=31536000, immutable';
    }
    if (['.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.webp'].includes(ext)) {
        return 'private, max-age=86400';
    }
    if (['.js', '.mjs', '.css'].includes(ext)) {
        return 'private, max-age=300';
    }
    return 'private, max-age=60';
}

function staticEntityTag(stat) {
    return `W/"${stat.size}-${Math.floor(stat.mtimeMs)}-${stat.ino}"`;
}

function normalizeStaticEntityTag(tag) {
    return tag.startsWith('W/') ? tag.slice(2) : tag;
}

function staticIfNoneMatchMatches(headerValue, etag) {
    const raw = Array.isArray(headerValue) ? headerValue.join(',') : headerValue;
    if (typeof raw !== 'string' || !raw.trim()) return false;
    const current = normalizeStaticEntityTag(etag);
    return raw.split(',').map((part) => part.trim()).some((part) => (
        part === '*' || normalizeStaticEntityTag(part) === current
    ));
}

// `htmlVariant`: agent-static HTML. Navigations ignore validators (always 200);
// fetched templates revalidate. `nowMs` is injected for the current-second rule.
function staticNotModified(req, etag, stat, { htmlVariant = false, template = false, nowMs = Date.now() } = {}) {
    if (htmlVariant && !template) return false;
    const ifNoneMatch = req.headers?.['if-none-match'];
    if (typeof ifNoneMatch === 'string' || Array.isArray(ifNoneMatch)) {
        return staticIfNoneMatchMatches(ifNoneMatch, etag);
    }
    const since = Date.parse(String(req.headers?.['if-modified-since'] || ''));
    if (!Number.isFinite(since)) return false;
    if (template) {
        // Template class: no future dates, no mtime inside the current second.
        if (since > nowMs) return false;
        if (Math.floor(stat.mtimeMs / 1000) >= Math.floor(nowMs / 1000)) return false;
    }
    return Math.floor(stat.mtimeMs / 1000) * 1000 <= since;
}

async function serveStaticFile(req, res, pathname) {
    const method = String(req.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') return false;
    const filePath = await resolveStaticFile(pathname);
    if (!filePath) return false;
    // Open once: validators come from the open handle and the body streams from
    // that same handle, so headers and body describe the same file.
    let handle;
    try {
        handle = await fs.promises.open(filePath, 'r');
    } catch (_) {
        return false;
    }
    let streamStarted = false;
    try {
        const stat = await handle.stat();
        if (!stat.isFile()) return false;
        const nowMs = Date.now();
        const htmlVariant = isStaticHtml(filePath);
        const template = htmlVariant && isFetchedTemplateRequest(req);
        const etag = staticEntityTag(stat);
        const lastModified = new Date(stat.mtimeMs).toUTCString();
        const cacheControl = getStaticCacheControl(filePath, { fetchedTemplate: template });
        const advertiseLastModified = !template
            || Math.floor(stat.mtimeMs / 1000) < Math.floor(nowMs / 1000);
        const validators = {
            ETag: etag,
            ...(advertiseLastModified ? { 'Last-Modified': lastModified } : {}),
            ...(htmlVariant ? { Vary: 'Sec-Fetch-Dest' } : {}),
        };
        if (staticNotModified(req, etag, stat, { htmlVariant, template, nowMs })) {
            res.writeHead(304, { 'Cache-Control': cacheControl, ...validators });
            res.end();
            return true;
        }
        const size = stat.size;
        res.writeHead(200, {
            'Content-Type': getStaticMimeType(filePath),
            'Content-Length': size,
            'Cache-Control': cacheControl,
            ...validators
        });
        if (method === 'HEAD' || size === 0) {
            res.end();
            return true;
        }
        // `end` caps the body at the fstat size so it cannot exceed Content-Length.
        const stream = handle.createReadStream({ start: 0, end: size - 1, autoClose: true });
        streamStarted = true;
        stream.on('error', () => {
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
            }
            res.end('Internal Server Error');
        });
        res.on('close', () => stream.destroy());
        stream.pipe(res);
        return true;
    } finally {
        if (!streamStarted) await handle.close().catch(() => { });
    }
}

function resolveMaxConcurrent(config) {
    if (config && config.maxParallelTasks) {
        const candidate = Number(config.maxParallelTasks);
        if (Number.isFinite(candidate) && candidate > 0) {
            return Math.floor(candidate);
        }
    }
    return DEFAULT_MAX_CONCURRENT_TASKS;
}

function resolveTaskLogTailBytes(config) {
    const configValue = Number(config?.taskLogTailBytes);
    if (Number.isFinite(configValue) && configValue > 0) {
        return Math.floor(configValue);
    }
    const envValue = Number(process.env.PLOINKY_MCP_TASK_LOG_TAIL_BYTES);
    if (Number.isFinite(envValue) && envValue > 0) {
        return Math.floor(envValue);
    }
    return DEFAULT_TASK_LOG_TAIL_BYTES;
}

function buildCommandSpec(entry, defaultCwd) {
    const commandValue = typeof entry?.command === 'string' ? entry.command.trim() : null;
    if (!commandValue) return null;
    const needsResolution = commandValue.includes('/') || commandValue.includes('\\');
    const command = path.isAbsolute(commandValue)
        ? commandValue
        : (needsResolution ? path.resolve(defaultCwd, commandValue) : commandValue);
    const args = Array.isArray(entry?.args)
        ? entry.args
            .map((value) => (typeof value === 'string' ? value : String(value ?? '')))
            .filter((value) => value.length > 0)
        : [];
    if (entry.cwd === "workspace") {
        defaultCwd = process.cwd();
    } else {
        defaultCwd = entry.cwd
    }
    const cwd = defaultCwd;
    const env = entry?.env && typeof entry.env === 'object' ? entry.env : {};
    const timeoutMs = Number.isFinite(entry?.timeoutMs) ? entry.timeoutMs : undefined;
    return { command, args, cwd, env, timeoutMs };
}

function normalizeTagList(value) {
    const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,\s]+/) : [];
    const seen = new Set();
    const tags = [];
    for (const entry of raw) {
        if (typeof entry !== 'string') continue;
        const normalized = entry.trim().replace(/^@+/, '').toLowerCase();
        if (!TAG_NAME_RE.test(normalized)) continue;
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        tags.push(normalized);
    }
    return tags;
}

function normalizeCapabilities(value) {
    if (!value || typeof value !== 'object') return null;
    const capabilities = { ...value };
    if ('tags' in capabilities) {
        const normalizedTags = normalizeTagList(capabilities.tags);
        if (normalizedTags.length) {
            capabilities.tags = normalizedTags;
        } else {
            delete capabilities.tags;
        }
    }
    const maybeStrings = ['summary', 'description', 'whenToUse', 'whenNotToUse', 'inputConventions', 'outputConventions'];
    for (const field of maybeStrings) {
        if (typeof capabilities[field] === 'string') {
            const trimmed = capabilities[field].trim();
            if (trimmed) {
                capabilities[field] = trimmed;
            } else {
                delete capabilities[field];
            }
        }
    }
    if (Object.keys(capabilities).length === 0) return null;
    return capabilities;
}

function resolveOpenAiChatKind(manifest) {
    const chat = manifest && typeof manifest === 'object' && manifest.endpoints && typeof manifest.endpoints === 'object'
        ? manifest.endpoints.chatCompletions
        : null;
    if (chat && typeof chat === 'object' && typeof chat.command === 'string' && chat.command.trim()) {
        const commandSpec = buildCommandSpec(chat, process.env.PLOINKY_CODE_DIR || '/code');
        if (commandSpec) {
            return { kind: 'command', commandSpec, supportsStream: chat.supportsStream === true || chat.stream === true };
        }
    }
    const model = chat && typeof chat === 'object' && typeof chat.model === 'string' ? chat.model.trim() : null;
    if (model && isOptOutModel(model)) {
        return { kind: 'inert' };
    }
    return { kind: 'llm', model: model || null };
}

export { resolveOpenAiChatKind };

function resolveOpenAiModelsKind(manifest) {
    const models = manifest && typeof manifest === 'object' && manifest.endpoints && typeof manifest.endpoints === 'object'
        ? manifest.endpoints.models
        : null;
    if (models && typeof models === 'object' && typeof models.command === 'string' && models.command.trim()) {
        const commandSpec = buildCommandSpec(models, process.env.PLOINKY_CODE_DIR || '/code');
        if (commandSpec) {
            return { kind: 'command', commandSpec };
        }
    }
    return { kind: 'fallback' };
}

export { resolveOpenAiModelsKind };

// Testable core: build the OpenAI completion via the agentic loop. `runResponder`
// is injectable for tests; production passes runOpenAiAgenticResponse.
export async function __buildAgenticCompletion({ body, manifest, config, agentId, runResponder = runOpenAiAgenticResponse }) {
    const defaultCwd = process.env.PLOINKY_CODE_DIR || '/code';
    // The loop's tool map is keyed by name (the last entry wins), so the
    // routing is too.
    const poolsByToolName = new Map();
    for (const tool of Array.isArray(config?.tools) ? config.tools : []) {
        if (!tool || typeof tool !== 'object' || typeof tool.name !== 'string') continue;
        const pool = resolveToolWorkerPool(tool, buildCommandSpec(tool, defaultCwd));
        if (pool) poolsByToolName.set(tool.name, pool);
        else poolsByToolName.delete(tool.name);
    }
    const toolsMap = buildLoopToolsFromMcp({
        tools: config?.tools,
        defaultCwd,
        buildCommandSpec,
        runTool: (commandSpec, payload) => {
            const pool = poolsByToolName.get(payload?.tool);
            return runSyncTool(pool, commandSpec, payload);
        },
    });
    return runResponder({
        toolsMap,
        messages: Array.isArray(body.messages) ? body.messages : [],
        model: typeof body.model === 'string' && body.model.trim() ? body.model.trim() : (manifest?.endpoints?.chatCompletions?.model || null),
        agentId,
    });
}

export function sendEmulatedSseCompletion(res, completion) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
    });
    const choice = completion.choices?.[0] || {};
    const chunk = {
        id: completion.id,
        object: 'chat.completion.chunk',
        created: completion.created,
        model: completion.model,
        choices: [{ index: 0, delta: { role: 'assistant', content: choice.message?.content || '' }, finish_reason: 'stop' }],
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
}

function collectMcpToolNames() {
    const configResult = getConfigResult();
    const config = configResult ? configResult.config : null;
    if (!config || !Array.isArray(config.tools)) return [];
    const names = [];
    for (const tool of config.tools) {
        if (tool && typeof tool.name === 'string' && tool.name.trim()) {
            names.push(tool.name.trim());
        }
    }
    return names;
}

function parseAuthInfoHeader(requestHeaders) {
    if (!requestHeaders || typeof requestHeaders !== 'object') return null;
    const raw = requestHeaders['x-ploinky-auth-info'];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (!value || typeof value !== 'string') return null;
    try {
        return JSON.parse(value);
    } catch (_) {
        return null;
    }
}

function executeShell(spec, payload, options = {}) {
    return new Promise((resolve, reject) => {
        const { command, args = [], cwd, env, timeoutMs } = spec;
        const child = spawn(command, args, {
            cwd,
            env: { ...process.env, ...env },
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: timeoutMs,
            detached: options.detached === true,
        });
        if (typeof options.onSpawn === 'function') {
            try {
                options.onSpawn(child);
            } catch (err) {
                console.warn('[AgentServer/MCP] onSpawn hook failed:', err);
            }
        }
        const stdout = [];
        const stderr = [];
        child.stdout.on('data', chunk => {
            stdout.push(chunk);
            if (typeof options.onStdoutChunk === 'function') {
                try {
                    options.onStdoutChunk(chunk);
                } catch (err) {
                    console.warn('[AgentServer/MCP] onStdoutChunk hook failed:', err);
                }
            }
        });
        child.stderr.on('data', chunk => {
            stderr.push(chunk);
            if (typeof options.onStderrChunk === 'function') {
                try {
                    options.onStderrChunk(chunk);
                } catch (err) {
                    console.warn('[AgentServer/MCP] onStderrChunk hook failed:', err);
                }
            }
        });
        child.on('error', reject);
        child.stdin.on('error', err => {
            if (err?.code === 'EPIPE') {
                return;
            }
            reject(err);
        });
        child.on('close', (code, signal) => {
            resolve({
                code,
                signal,
                stdout: Buffer.concat(stdout).toString('utf8'),
                stderr: Buffer.concat(stderr).toString('utf8')
            });
        });
        try {
            child.stdin.end(JSON.stringify(payload ?? {}) + '\n');
        } catch (_) {
            // ignore broken pipes
        }
    });
}

function readJsonBody(req) {
    return new Promise((resolve) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            if (!chunks.length) {
                resolve({ ok: true, body: {} });
                return;
            }
            const raw = Buffer.concat(chunks).toString('utf8');
            try {
                resolve({ ok: true, body: JSON.parse(raw) });
            } catch (error) {
                resolve({ ok: false, error });
            }
        });
        req.on('error', (error) => resolve({ ok: false, error }));
    });
}

// Buffer the raw request bytes ONCE and also parse them as JSON. The OpenAI
// chat-completions path needs the exact raw bytes (for sha256RawBodyHash, to
// rebind the router-minted token) AND the parsed body (for the handler). Parsing
// the SAME buffer guarantees the hash matches what the router signed.
function readRawAndJsonBody(req) {
    return new Promise((resolve) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            const rawBody = Buffer.concat(chunks);
            if (!rawBody.length) {
                resolve({ ok: true, rawBody, body: {} });
                return;
            }
            try {
                resolve({ ok: true, rawBody, body: JSON.parse(rawBody.toString('utf8')) });
            } catch (error) {
                resolve({ ok: false, rawBody, error });
            }
        });
        req.on('error', (error) => resolve({ ok: false, rawBody: Buffer.alloc(0), error }));
    });
}

// When the router proxies a verified agent-to-agent OpenAI call it carries a
// Router Request token in `x-ploinky-auth-info`. The plan is "verify when one is
// present": if the header is absent, preserve the existing behavior (Task 5
// default responder / configured handler). When present, the token MUST verify
// against this agent's own secret, the fixed OpenAI surface, and the EXACT raw
// body bytes — any mismatch (method/path/tool/audience/expiry/replay/body-hash)
// is a 401 BEFORE the handler runs. Returns true when the request was rejected.
function rejectInvalidOpenAiRouterToken(req, res, rawBody) {
    const raw = req.headers ? req.headers['x-ploinky-auth-info'] : undefined;
    const present = (Array.isArray(raw) ? raw[0] : raw);
    if (!present || typeof present !== 'string' || !present.trim()) {
        return false;
    }
    const verified = verifyOpenAiServiceAuthInfoFromHeaders(req.headers, {
        env: process.env,
        replayCache: invocationReplayCache,
        body: rawBody,
        bodyHash: sha256RawBodyHash(rawBody),
    });
    if (!verified.ok) {
        sendOpenAiError(res, 401, 'invocation_rejected', 'invalid_request_error');
        return true;
    }
    return false;
}

function rejectInvalidOpenAiModelsRouterToken(req, res) {
    const raw = req.headers ? req.headers['x-ploinky-auth-info'] : undefined;
    const present = (Array.isArray(raw) ? raw[0] : raw);
    if (!present || typeof present !== 'string' || !present.trim()) {
        return false;
    }
    const verified = verifyOpenAiModelsAuthInfoFromHeaders(req.headers, {
        env: process.env,
        replayCache: invocationReplayCache,
    });
    if (!verified.ok) {
        sendOpenAiError(res, 401, 'invocation_rejected', 'invalid_request_error');
        return true;
    }
    return false;
}

function sendOpenAiError(res, statusCode, message, type = 'server_error', extraHeaders = {}) {
    const payload = { error: { message, type } };
    const data = Buffer.from(JSON.stringify(payload));
    res.writeHead(statusCode, { 'Content-Type': 'application/json', 'Content-Length': data.length, ...extraHeaders });
    res.end(data);
}

// Once the SSE headers are out, HTTP 200 is already committed, so the status a
// handler chose for its failure can only travel inside the error frame.
function writeSseError(res, message, type = 'server_error', status = null) {
    const error = Number.isInteger(status) ? { message, type, status } : { message, type };
    res.write(`data: ${JSON.stringify({ error })}\n\n`);
    res.write('data: [DONE]\n\n');
}

async function handleOpenAiChatCompletions(req, res, body) {
    if (!body || typeof body !== 'object') {
        sendOpenAiError(res, 400, 'Invalid request body', 'invalid_request_error');
        return;
    }
    const manifestResult = getManifestResult();
    const manifest = manifestResult ? manifestResult.manifest : null;
    const chatKind = resolveOpenAiChatKind(manifest);

    if (chatKind.kind === 'inert') {
        if (body.stream === true) {
            const rejection = buildDefaultStreamRejection();
            sendOpenAiError(res, rejection.statusCode, rejection.message, rejection.type);
            return;
        }
        const response = buildDefaultOpenAiChatResponse({
            requestBody: body,
            manifest,
            toolNames: collectMcpToolNames(),
            agentId: process.env.PLOINKY_AGENT_ID
        });
        const data = Buffer.from(JSON.stringify(response));
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': data.length });
        res.end(data);
        return;
    }

    if (chatKind.kind === 'llm') {
        const configResult = getConfigResult();
        let completion;
        try {
            completion = await __buildAgenticCompletion({
                body,
                manifest,
                config: configResult ? configResult.config : null,
                agentId: process.env.PLOINKY_AGENT_ID,
            });
        } catch (error) {
            sendOpenAiError(res, 502, `Default LLM responder failed: ${error.message}`, 'server_error');
            return;
        }
        if (body.stream === true) {
            sendEmulatedSseCompletion(res, completion);
        } else {
            const data = Buffer.from(JSON.stringify(completion));
            res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': data.length });
            res.end(data);
        }
        return;
    }

    // kind === 'command' → existing custom-handler path
    const openAiConfig = { commandSpec: chatKind.commandSpec, supportsStream: chatKind.supportsStream };
    const wantsStream = body.stream === true;
    if (wantsStream && !openAiConfig.supportsStream) {
        sendOpenAiError(res, 400, 'Streaming is not enabled for this agent', 'invalid_request_error');
        return;
    }

    const payload = {
        endpoint: 'openai.chat.completions',
        request: body,
        metadata: {
            agent: process.env.AGENT_NAME || '',
            authInfo: parseAuthInfoHeader(req.headers)
        }
    };

    if (!wantsStream) {
        const result = await executeShell(openAiConfig.commandSpec, payload);
        if (result.code !== 0) {
            // A failure envelope may choose the status, error type and
            // Retry-After of its own failure; the default stays 500.
            const failure = describeShellFailureDetails(result);
            sendOpenAiError(
                res,
                failure.status || 500,
                failure.message,
                failure.type || 'server_error',
                failure.retryAfterSeconds ? { 'Retry-After': String(failure.retryAfterSeconds) } : {}
            );
            return;
        }
        let parsed;
        try {
            parsed = JSON.parse(result.stdout || '{}');
        } catch (error) {
            sendOpenAiError(res, 502, 'Chat completions handler did not return valid JSON');
            return;
        }
        const data = Buffer.from(JSON.stringify(parsed));
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': data.length });
        res.end(data);
        return;
    }

    const headers = {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
    };
    res.writeHead(200, headers);
    if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
    }

    const { command, args = [], cwd, env, timeoutMs } = openAiConfig.commandSpec;
    const child = spawn(command, args, {
        cwd,
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdoutBytes = 0;
    // The last bytes the handler wrote, enough to tell whether it already
    // terminated its own stream.
    let stdoutTail = '';
    const stderrChunks = [];
    let timeout = null;
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timeout = setTimeout(() => {
            try { child.kill('SIGTERM'); } catch (_) { }
        }, timeoutMs);
    }
    child.stdout.on('data', chunk => {
        stdoutBytes += chunk.length;
        stdoutTail = (stdoutTail + chunk.toString('latin1')).slice(-64);
        res.write(chunk);
    });
    child.stderr.on('data', chunk => {
        stderrChunks.push(chunk);
    });
    child.on('error', err => {
        if (!res.writableEnded) {
            if (stdoutBytes === 0) {
                writeSseError(res, `Stream handler error: ${err.message}`);
            }
            res.end();
        }
    });
    child.on('close', (code, signal) => {
        if (timeout) clearTimeout(timeout);
        if (!res.writableEnded) {
            // A stream the handler terminated itself is complete for the
            // caller, whatever the exit code; nothing may follow its [DONE].
            const terminated = /data:[ \t]*\[DONE\]\s*$/.test(stdoutTail);
            if (code !== 0 && !terminated && !res.destroyed) {
                const stderr = Buffer.concat(stderrChunks).toString('utf8');
                const failure = describeShellFailureDetails({ code, signal, stdout: '', stderr });
                // A handler that dies after partial output must not look like
                // a completed answer: close any half-written event, then say so.
                if (stdoutBytes > 0) res.write('\n\n');
                writeSseError(res, failure.message, failure.type || 'server_error', failure.status);
            }
            res.end();
        }
    });
    req.on('aborted', () => {
        try { child.kill('SIGTERM'); } catch (_) { }
    });
    child.stdin.on('error', err => {
        if (err?.code === 'EPIPE') return;
        if (!res.writableEnded) {
            if (stdoutBytes === 0) {
                writeSseError(res, `Stream handler error: ${err.message}`);
            }
            res.end();
        }
    });
    try {
        child.stdin.end(JSON.stringify(payload ?? {}) + '\n');
    } catch (_) {
        // ignore broken pipes
    }
}

function buildFallbackModelsResponse(manifest) {
    const agentName = process.env.AGENT_NAME || manifest?.name || process.env.PLOINKY_AGENT_ID || 'agent';
    const declaredTags = normalizeTagList(manifest?.capabilities?.tags);
    const tags = declaredTags.length > 0 ? declaredTags : ['generic-agent'];
    const supportsStreaming = manifest?.endpoints?.chatCompletions?.stream === true
        || manifest?.endpoints?.chatCompletions?.supportsStream === true
        || !manifest?.endpoints?.chatCompletions?.command;
    return {
        object: 'list',
        data: [
            {
                id: 'default',
                object: 'model',
                modelId: 'default',
                displayName: agentName,
                supportsTools: true,
                supportsStreaming,
                supportsVision: false,
                tags,
                capabilities: {
                    supportsTools: true,
                    supportsStreaming,
                    supportsVision: false,
                },
                metadata: {
                    fallback: true,
                    agent: process.env.PLOINKY_AGENT_ID || null,
                },
            },
        ],
    };
}

async function handleOpenAiModels(req, res) {
    const manifestResult = getManifestResult();
    const manifest = manifestResult ? manifestResult.manifest : null;
    const modelsKind = resolveOpenAiModelsKind(manifest);

    if (modelsKind.kind === 'fallback') {
        const response = buildFallbackModelsResponse(manifest);
        const data = Buffer.from(JSON.stringify(response));
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': data.length });
        res.end(data);
        return;
    }

    const payload = {
        endpoint: 'openai.models',
        metadata: {
            agent: process.env.AGENT_NAME || '',
            authInfo: parseAuthInfoHeader(req.headers),
        },
    };
    const result = await executeShell(modelsKind.commandSpec, payload);
    if (result.code !== 0) {
        sendOpenAiError(res, 500, describeShellFailure(result));
        return;
    }
    let parsed;
    try {
        parsed = JSON.parse(result.stdout || '{}');
    } catch (_) {
        sendOpenAiError(res, 502, 'Models handler did not return valid JSON');
        return;
    }
    const data = Buffer.from(JSON.stringify(parsed));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': data.length });
    res.end(data);
}

function sanitizeAuthInfoForLog(authInfo = null) {
    if (!authInfo || typeof authInfo !== 'object') return null;
    const github = authInfo.github && typeof authInfo.github === 'object'
        ? {
            provider: authInfo.github.provider || '',
            tokenType: authInfo.github.tokenType || '',
            scope: authInfo.github.scope || '',
            hasAccessToken: Boolean(authInfo.github.accessToken),
            user: authInfo.github.user || null
        }
        : null;
    return {
        ...authInfo,
        github
    };
}

function sanitizeInvocationForLog(invocation = null) {
    if (!invocation || typeof invocation !== 'object') return null;
    return {
        iss: invocation.iss,
        sub: invocation.sub,
        aud: invocation.aud,
        tool: invocation.tool,
        scope: invocation.scope,
        workspace_id: invocation.workspace_id,
        iat: invocation.iat,
        exp: invocation.exp,
        hasUserClaims: Boolean(invocation.user)
    };
}

function shouldRedactLogField(key) {
    return /authorization|cookie|jwt|token|secret|password|credential|access[_-]?key|api[_-]?key|^value$|^task$|prompt|messages?|resources?|content|base64|stdin|payload/i.test(String(key || ''));
}

function sanitizeValueForLog(value, key = '') {
    if (value == null) return value;
    if (shouldRedactLogField(key)) return '[redacted]';
    if (Array.isArray(value)) {
        return value.map((entry) => sanitizeValueForLog(entry));
    }
    if (typeof value === 'object') {
        const out = {};
        for (const [entryKey, entryValue] of Object.entries(value)) {
            out[entryKey] = sanitizeValueForLog(entryValue, entryKey);
        }
        return out;
    }
    return value;
}

function sanitizeContextForLog(context = {}) {
    if (!context || typeof context !== 'object') return context;
    const sanitized = sanitizeValueForLog(context);
    return {
        ...sanitized,
        requestInfo: sanitizeValueForLog(context.requestInfo || null),
        invocationToken: context.invocationToken ? '[redacted]' : context.invocationToken,
        authInfo: sanitizeAuthInfoForLog(context.authInfo || null),
        invocation: sanitizeInvocationForLog(context.invocation || null)
    };
}

function rejectInvocation(helpers, reason) {
    const ErrorCtor = helpers?.McpError || Error;
    const code = helpers?.ErrorCode?.InvalidRequest ?? -32600;
    throw new ErrorCtor(code, `Invocation rejected: ${reason}`);
}

function requireVerifiedInvocation({ requestHeaders, method, path, tool, argumentsObj, context = {}, helpers }) {
    const invocationResult = hasInvocationTokenHeader(requestHeaders)
        ? verifyInvocationForRequest({ requestHeaders, method, path, tool, argumentsObj })
        : { ok: false, reason: 'missing secure wire headers' };
    if (!invocationResult.ok) {
        rejectInvocation(helpers, invocationResult.reason);
    }
    return {
        ...context,
        invocation: invocationResult.payload,
        invocationToken: invocationResult.rawToken
    };
}

function sanitizePayloadForLog(payload = {}) {
    if (!payload || typeof payload !== 'object') return payload;
    return {
        ...payload,
        input: sanitizeValueForLog(payload.input || {}),
        metadata: sanitizeContextForLog(payload.metadata || {})
    };
}

const initialConfigResult = getConfigResult();
const initialConfig = initialConfigResult ? initialConfigResult.config : {};
const taskQueue = new TaskQueue({
    maxConcurrent: resolveMaxConcurrent(initialConfig),
    maxLogTailBytes: resolveTaskLogTailBytes(initialConfig),
    storagePath: TASK_QUEUE_FILE,
    executor: executeShell
});

// Warm tool workers (opt-in through `toolWorkers` in the MCP config, see
// toolWorkerPool.mjs). Pools are built once from the startup config, never per
// MCP session. A pool needs a code identity source: workers are replaced when
// the identity changes, so they never run code older than a fresh process
// would load. The source is the tree stamp of toolCodeIdentity.mjs, walked on
// a worker thread (PLOINKY_TOOL_IDENTITY_MODE=thread, the default) or on the
// main thread (PLOINKY_TOOL_IDENTITY_MODE=sync); tests can inject their own
// through the global symbol below. Without a source, every tool keeps running
// as a fresh process.
const TOOL_CODE_IDENTITY_OVERRIDE = Symbol.for('ploinky.agentServer.toolCodeIdentity');
let toolCodeIdentityThread = null;

function toolCodeIdentityMode() {
    const mode = String(process.env.PLOINKY_TOOL_IDENTITY_MODE ?? '').trim().toLowerCase();
    if (mode && mode !== 'sync' && mode !== 'thread') {
        console.warn(`[AgentServer/MCP] unknown PLOINKY_TOOL_IDENTITY_MODE '${mode}'; using thread`);
    }
    return mode === 'sync' ? 'sync' : 'thread';
}

function resolveToolCodeIdentity() {
    const override = globalThis[TOOL_CODE_IDENTITY_OVERRIDE];
    if (typeof override === 'function') return override;
    try {
        const inputs = {
            codeDir: process.env.PLOINKY_CODE_DIR || '/code',
            configPath: initialConfigResult?.source || null,
            manifestPath: getManifestResult()?.source || null,
        };
        if (toolCodeIdentityMode() === 'thread') {
            toolCodeIdentityThread = createAgentServerCodeIdentityThread({
                ...inputs,
                // Resolved on this thread for every request: the pools exist by then.
                poolCommand: (poolName) => toolWorkerPools.get(poolName)?.command,
            });
            toolCodeIdentityThread.start();
            return toolCodeIdentityThread.codeIdentity;
        }
        const { labels } = agentServerIdentityInputs(inputs);
        let measures = [];
        const identity = createAgentServerCodeIdentity({
            ...inputs,
            // Read at call time: the pools exist by then.
            poolCommand: (poolName) => toolWorkerPools.get(poolName)?.command,
            onMeasure: (measure) => measures.push(measure),
        });
        return (poolName) => {
            measures = [];
            const value = identity(poolName);
            return { identity: value, roots: formatIdentityMeasures(measures, labels) };
        };
    } catch (error) {
        console.warn(`[AgentServer/MCP] cannot create the tool code identity (${error?.message || error})`);
        return null;
    }
}

async function stopToolCodeIdentityThread() {
    const thread = toolCodeIdentityThread;
    toolCodeIdentityThread = null;
    await thread?.terminate();
}

function toolWorkersDisabled() {
    return String(process.env.PLOINKY_TOOL_WORKERS ?? '').trim() === '0';
}

function buildToolWorkerPools(config) {
    const declarations = config && typeof config === 'object' ? config.toolWorkers : null;
    if (!declarations || typeof declarations !== 'object' || Array.isArray(declarations)
        || Object.keys(declarations).length === 0) {
        return new Map();
    }
    if (toolWorkersDisabled()) {
        console.warn('[AgentServer/MCP] PLOINKY_TOOL_WORKERS=0: tool workers are disabled; every tool runs as a fresh process');
        return new Map();
    }
    const codeIdentity = resolveToolCodeIdentity();
    if (!codeIdentity) {
        console.warn('[AgentServer/MCP] toolWorkers are declared but no tool code identity source is available; every tool runs as a fresh process');
        return new Map();
    }
    try {
        const pools = createToolWorkerPools(config, {
            buildCommandSpec,
            defaultCwd: process.env.PLOINKY_CODE_DIR || '/code',
            log: (line) => console.warn(line),
            codeIdentity,
        });
        if (pools.size === 0) void stopToolCodeIdentityThread();
        return pools;
    } catch (error) {
        console.warn(`[AgentServer/MCP] cannot build tool worker pools (${error?.message || error}); every tool runs as a fresh process`);
        void stopToolCodeIdentityThread();
        return new Map();
    }
}

const toolWorkerPools = buildToolWorkerPools(initialConfig);
const loggedToolRouteWarnings = new Set();

// The routing rule: a tool runs in a pool only if its `worker` names an
// available pool, it is not async, its command cwd equals the pool's cwd and
// PLOINKY_TOOL_WORKERS is not 0. Any other tool that names a worker logs one
// warning and keeps running as a fresh process.
function resolveToolWorkerPool(tool, commandSpec) {
    if (!tool || typeof tool !== 'object' || tool.worker === undefined || tool.worker === null) return null;
    if (toolWorkersDisabled()) return null;
    const poolName = typeof tool.worker === 'string' ? tool.worker.trim() : '';
    const pool = poolName ? toolWorkerPools.get(poolName) : null;
    let reason = null;
    if (!poolName) reason = 'its worker field does not name a pool';
    else if (!pool) reason = `tool worker pool '${poolName}' is not available`;
    else if (tool.async === true) reason = 'async tools run through the task queue';
    else if (!commandSpec || commandSpec.cwd !== pool.cwd) reason = `its cwd differs from the cwd of tool worker pool '${poolName}'`;
    if (!reason) return pool;
    const name = typeof tool.name === 'string' ? tool.name : '';
    const key = `${name}\u0000${reason}`;
    if (!loggedToolRouteWarnings.has(key)) {
        loggedToolRouteWarnings.add(key);
        console.warn(`[AgentServer/MCP] tool '${name}' runs as a fresh process: ${reason}`);
    }
    return null;
}

// Report routing problems once at startup rather than at the first session.
for (const tool of Array.isArray(initialConfig?.tools) ? initialConfig.tools : []) {
    if (tool && typeof tool === 'object') {
        resolveToolWorkerPool(tool, buildCommandSpec(tool, process.env.PLOINKY_CODE_DIR || '/code'));
    }
}

// Optional `maxParallelSyncCalls`: bounds sync tool calls that run as a fresh
// process. Absent (or invalid) means unlimited, as before.
function resolveMaxParallelSyncCalls(config) {
    const value = config && typeof config === 'object' ? config.maxParallelSyncCalls : undefined;
    if (value === undefined || value === null) return null;
    if (Number.isInteger(value) && value > 0) return value;
    console.warn('[AgentServer/MCP] ignoring maxParallelSyncCalls: it must be a positive integer');
    return null;
}

function createSpawnLimiter(limit) {
    if (!limit) return { run: (fn) => fn() };
    let active = 0;
    const waiting = [];
    const release = () => {
        active -= 1;
        const next = waiting.shift();
        if (next) next();
    };
    return {
        run(fn) {
            return new Promise((resolve, reject) => {
                const start = () => {
                    active += 1;
                    Promise.resolve().then(fn).then(resolve, reject).finally(release);
                };
                if (active < limit) start();
                else waiting.push(start);
            });
        },
    };
}

const syncSpawnLimiter = createSpawnLimiter(resolveMaxParallelSyncCalls(initialConfig));

function callToolWorker(pool, commandSpec, payload, fallback) {
    return pool.call({
        toolName: typeof payload?.tool === 'string' ? payload.tool : '',
        toolEnv: commandSpec.env,
        payload,
        timeoutMs: commandSpec.timeoutMs,
        fallback,
    });
}

// Runs one sync tool call in its pool or as a fresh process. `trace.mode`
// records where it actually ran (a pool can hand a call to the spawn fallback).
function runSyncTool(pool, commandSpec, payload, trace = {}) {
    const spawnCall = () => {
        trace.mode = 'spawn';
        return syncSpawnLimiter.run(() => executeShell(commandSpec, payload));
    };
    if (!pool) return spawnCall();
    trace.mode = `worker:${pool.name}`;
    return callToolWorker(pool, commandSpec, payload, spawnCall);
}

function extractTemplateParams(template) {
    const params = {};
    const regex = /\{([^}]+)\}/g;
    let match;
    while ((match = regex.exec(template)) !== null) {
        params[match[1]] = undefined;
    }
    return params;
}

async function registerFromConfig(server, config, helpers) {
    if (!config || typeof config !== 'object') return;
    const { ResourceTemplate, McpError, ErrorCode } = helpers;
    const defaultCwd = process.env.PLOINKY_CODE_DIR || '/code';
    const jsonSchemas = new Map();
    preserveJsonSchemaToolListings(server, jsonSchemas);

    if (Array.isArray(config.tools)) {
        for (const tool of config.tools) {
            if (!tool || typeof tool !== 'object') continue;
            const name = typeof tool.name === 'string' ? tool.name : null;
            if (!name) continue;
            const commandSpec = buildCommandSpec(tool, defaultCwd);
            if (!commandSpec) {
                console.warn(`[AgentServer/MCP] Skipping tool '${name}' - missing command`);
                continue;
            }
            const definition = {
                title: tool.title,
                description: tool.description
            };

            const isAsync = tool.async === true;
            const asyncTimeout = Number.isFinite(tool.timeoutMs)
                ? tool.timeoutMs
                : (Number.isFinite(tool.timeout) ? tool.timeout : undefined);
            const taskLogRetention = tool.taskLogRetention === 'full' ? 'full' : 'bounded';
            const continuationTool = typeof tool.continuationTool === 'string'
                ? tool.continuationTool.trim()
                : '';
            const toolWorkerPool = resolveToolWorkerPool(tool, commandSpec);
            const runInvocation = async (trace, ...cbArgs) => {
                let args = cbArgs[0] ?? {};
                let context = cbArgs[1] ?? {};
                if (cbArgs.length === 1 && typeof args === 'object' && args !== null && args.requestId) {
                    context = args;
                    args = {};
                }
                const requestHeaders = context?.requestInfo?.headers || null;

                // Secure wire: verify router-minted invocation token before
                // exposing any caller context. On success, attach the verified
                // grant to the metadata so tools can rely on it.
                context = requireVerifiedInvocation({
                    requestHeaders,
                    method: 'POST',
                    path: '/mcp',
                    tool: name,
                    argumentsObj: args || {},
                    context,
                    helpers
                });
                const debugToolLogs = process.env.PLOINKY_AGENT_TOOL_DEBUG_LOGS === '1';
                if (debugToolLogs) {
                    console.log(`[AgentServer/MCP] Tool '${name}' args:`, sanitizeValueForLog(args));
                    console.log(`[AgentServer/MCP] Tool '${name}' context:`, sanitizeContextForLog(context));
                }
                const payload = { tool: name, input: args, metadata: context };
                if (debugToolLogs) {
                    console.log(`[AgentServer/MCP] Tool '${name}' payload:`, JSON.stringify(sanitizePayloadForLog(payload)));
                }
                if (isAsync) {
                    const enqueued = taskQueue.enqueueTask({
                        toolName: name,
                        commandSpec,
                        payload,
                        timeoutMs: asyncTimeout,
                        logRetention: taskLogRetention,
                        continuationTool,
                        taskMessageTool: tool.taskMessageTool,
                    });
                    return {
                        content: [{ type: 'text', text: `Task '${name}' queued with id ${enqueued.id}` }],
                        metadata: {
                            agent: process.env.AGENT_NAME || name,
                            taskId: enqueued.id,
                            toolName: enqueued.toolName,
                            status: enqueued.status,
                            createdAt: enqueued.createdAt,
                            updatedAt: enqueued.updatedAt,
                            logRetention: enqueued.logRetention,
                            ...(enqueued.continuationCapability
                                ? { continuationCapability: enqueued.continuationCapability }
                                : {}),
                        }
                    };
                }
                const result = await runSyncTool(toolWorkerPool, commandSpec, payload, trace);
                if (result.code !== 0) {
                    const message = describeShellFailure(result);
                    if (helpers && helpers.McpError && helpers.ErrorCode) {
                        throw new helpers.McpError(helpers.ErrorCode.InternalError, message);
                    }
                    throw new Error(message);
                }
                const textOut = result.stdout?.length ? result.stdout : '(no output)';
                const content = [{ type: 'text', text: textOut }];
                if (result.stderr && result.stderr.trim()) {
                    content.push({ type: 'text', text: `stderr:\n${result.stderr}` });
                }
                return { content, metadata: { agent: process.env.AGENT_NAME || name } };
            };

            const invocation = async (...cbArgs) => {
                const startedAt = Date.now();
                const trace = { mode: 'spawn' };
                let outcome = 'ok';
                try {
                    return await runInvocation(trace, ...cbArgs);
                } catch (error) {
                    outcome = 'error';
                    throw error;
                } finally {
                    console.log(`[AgentServer/MCP] tool=${name} mode=${trace.mode} ms=${Date.now() - startedAt} outcome=${outcome}`);
                }
            };

            const compiled = getConfiguredToolInputSchema(config, tool);
            if (compiled.jsonSchema) jsonSchemas.set(name, compiled.jsonSchema);
            const registeredTool = server.registerTool(name, definition, invocation);

            if (compiled.configured) {
                registeredTool.inputSchema = compiled.schema;
                if (typeof server.sendToolListChanged === 'function') {
                    server.sendToolListChanged();
                }
            } else if (!registeredTool.inputSchema) {
                registeredTool.inputSchema = compiled.schema;
            }
        }
    }

    if (Array.isArray(config.resources)) {
        for (const resource of config.resources) {
            if (!resource || typeof resource !== 'object') continue;
            const name = typeof resource.name === 'string' ? resource.name : null;
            if (!name) continue;
            const commandSpec = buildCommandSpec(resource, defaultCwd);
            if (!commandSpec) {
                console.warn(`[AgentServer/MCP] Skipping resource '${name}' - missing command`);
                continue;
            }
            const metadata = {
                title: resource.title || name,
                description: resource.description || '',
                mimeType: resource.mimeType || 'text/plain'
            };
            if (resource.template && typeof resource.template === 'string') {
                const template = new ResourceTemplate(resource.template, extractTemplateParams(resource.template));
                server.registerResource(name, template, metadata, async (uri, params = {}, extra = {}) => {
                    requireVerifiedInvocation({
                        requestHeaders: extra?.requestInfo?.headers || null,
                        method: 'POST',
                        path: '/mcp',
                        tool: 'resources/read',
                        argumentsObj: { uri: uri.href },
                        context: extra,
                        helpers
                    });
                    const payload = { resource: name, uri: uri.href, params };
                    const result = await executeShell(commandSpec, payload);
                    if (result.code !== 0) {
                        throw new McpError(ErrorCode.InternalError, describeShellFailure(result));
                    }
                    return {
                        contents: [{ uri: uri.href, text: result.stdout, mimeType: metadata.mimeType }]
                    };
                });
            } else if (resource.uri && typeof resource.uri === 'string') {
                server.registerResource(name, resource.uri, metadata, async (uri, extra = {}) => {
                    requireVerifiedInvocation({
                        requestHeaders: extra?.requestInfo?.headers || null,
                        method: 'POST',
                        path: '/mcp',
                        tool: 'resources/read',
                        argumentsObj: { uri: uri.href },
                        context: extra,
                        helpers
                    });
                    const payload = { resource: name, uri: uri.href };
                    const result = await executeShell(commandSpec, payload);
                    if (result.code !== 0) {
                        throw new McpError(ErrorCode.InternalError, describeShellFailure(result));
                    }
                    return {
                        contents: [{ uri: uri.href, text: result.stdout, mimeType: metadata.mimeType }]
                    };
                });
            } else {
                console.warn(`[AgentServer/MCP] Skipping resource '${name}' - missing uri/template definition`);
            }
        }
    }

    if (Array.isArray(config.prompts)) {
        for (const prompt of config.prompts) {
            if (!prompt || typeof prompt !== 'object') continue;
            const name = typeof prompt.name === 'string' ? prompt.name : null;
            if (!name) continue;
            if (!Array.isArray(prompt.messages) || !prompt.messages.length) {
                console.warn(`[AgentServer/MCP] Skipping prompt '${name}' - missing messages`);
                continue;
            }
            server.registerPrompt(name, {
                description: prompt.description,
                messages: prompt.messages
            });
        }
    }
}

let configLoadLogged = false;

async function createServerInstance() {
    const { McpServer, ResourceTemplate, McpError, ErrorCode } = await loadSdkDeps();
    const server = new McpServer({ name: 'ploinky-agent-mcp', version: '1.0.0' });

    const configResult = getConfigResult();
    const config = configResult ? configResult.config : {};

    if (!configLoadLogged) {
        configLoadLogged = true;
        if (configResult) {
            console.log(`[AgentServer/MCP] Loaded config from ${configResult.source}`);
        } else {
            console.log('[AgentServer/MCP] No configuration file found; starting with an empty configuration.');
        }
    }
    await registerFromConfig(server, config, { ResourceTemplate, McpError, ErrorCode });

    // Ensure core MCP request handlers are in place so the server responds with empty lists
    // instead of "method not found" when no configuration entries exist.
    if (typeof server.setToolRequestHandlers === 'function') {
        server.setToolRequestHandlers();
    }
    if (typeof server.setResourceRequestHandlers === 'function') {
        server.setResourceRequestHandlers();
    }
    if (typeof server.setPromptRequestHandlers === 'function') {
        server.setPromptRequestHandlers();
    }

    return server;
}

async function main() {
    const { StreamableHTTPServerTransport, isInitializeRequest } = await loadSdkDeps();
    taskQueue.initialize();
    const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 7000;
    const sessions = {};
    const parsePositiveInt = (value, fallback) => {
        const parsed = Number.parseInt(String(value || ''), 10);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    };

    // Idle-session GC: MCP clients that initialize but never send DELETE leak
    // their full McpServer and per-tool callbacks. Sweep
    // periodically and close idle transports; the SDK-wrapped onclose then
    // removes the dict entry and lets V8 collect the rest.
    const SESSION_IDLE_TIMEOUT_MS = parsePositiveInt(process.env.MCP_SESSION_IDLE_TIMEOUT_MS, 5 * 60 * 1000);
    const SESSION_GC_INTERVAL_MS = parsePositiveInt(process.env.MCP_SESSION_GC_INTERVAL_MS, 60 * 1000);
    const sessionGcTimer = setInterval(() => {
        const now = Date.now();
        for (const sid of Object.keys(sessions)) {
            const entry = sessions[sid];
            if (entry?.transport && entry.activeRequests === 0 && entry.lastAccess && now - entry.lastAccess > SESSION_IDLE_TIMEOUT_MS) {
                Promise.resolve(entry.transport.close()).catch(() => {});
            }
        }
    }, SESSION_GC_INTERVAL_MS);
    sessionGcTimer.unref?.();

    const markSessionRequestActive = (entry, res) => {
        if (!entry) return () => {};
        entry.activeRequests = (entry.activeRequests || 0) + 1;
        entry.lastAccess = Date.now();
        let finished = false;
        const finish = () => {
            if (finished) return;
            finished = true;
            entry.activeRequests = Math.max(0, (entry.activeRequests || 0) - 1);
            entry.lastAccess = Date.now();
        };
        res.once('finish', finish);
        res.once('close', finish);
        return finish;
    };

    let shuttingDown = false;
    const serverHttp = http.createServer(async (req, res) => {
        const { method, url } = req;
        const sendJson = (code, obj, extraHeaders = {}) => {
            const data = Buffer.from(JSON.stringify(obj));
            res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': data.length, ...extraHeaders });
            res.end(data);
        };
        if (shuttingDown) {
            sendJson(503, { error: 'agent_server_shutting_down' }, { Connection: 'close' });
            return;
        }
        try {
            const u = new URL(url || '/', 'http://localhost');
            if (method === 'GET' && u.pathname === '/health') {
                return sendJson(200, { ok: true, server: 'ploinky-agent-mcp' });
            }
            if (method === 'GET' && u.pathname === AGENT_CARD_PATH) {
                const manifestResult = getManifestResult();
                const manifest = manifestResult ? manifestResult.manifest : null;
                const agentCard = normalizeCapabilities(manifest?.endpoints?.['agent-card']);
                if (!agentCard) {
                    return sendJson(404, { error: 'agent-card not configured' });
                }
                return sendJson(200, {
                    agent: process.env.AGENT_NAME || manifest?.name || 'unknown-agent',
                    about: typeof manifest?.about === 'string' ? manifest.about : '',
                    'agent-card': agentCard
                });
            }
            if (method === 'GET' && TASK_STATUS_PATHS.has(u.pathname)) {
                const taskId = u.searchParams.get('taskId');
                if (!taskId) {
                    return sendJson(400, { error: 'missing taskId' });
                }
                const invocationResult = hasInvocationTokenHeader(req.headers)
                    ? verifyInvocationForRequest({
                        requestHeaders: req.headers,
                        method: 'GET',
                        path: u.pathname,
                        tool: '__task_status__',
                        argumentsObj: { taskId },
                    })
                    : { ok: false, reason: 'missing secure wire headers' };
                if (!invocationResult.ok) {
                    return sendJson(401, { error: 'invocation_rejected', reason: invocationResult.reason });
                }
                const task = taskQueue.getTask(taskId);
                if (!task) {
                    return sendJson(404, { error: 'task not found' });
                }
                return sendJson(200, { task });
            }
            if (method === 'POST' && u.pathname === TASK_CANCEL_PATH) {
                const parsedBody = await readJsonBody(req);
                if (!parsedBody.ok || !parsedBody.body || typeof parsedBody.body !== 'object') {
                    return sendJson(400, { error: 'invalid_json' });
                }
                const taskId = typeof parsedBody.body.taskId === 'string'
                    ? parsedBody.body.taskId.trim()
                    : '';
                if (!taskId) {
                    return sendJson(400, { error: 'missing taskId' });
                }
                const invocationResult = hasInvocationTokenHeader(req.headers)
                    ? verifyInvocationForRequest({
                        requestHeaders: req.headers,
                        method: 'POST',
                        path: TASK_CANCEL_PATH,
                        tool: TASK_CANCEL_TOOL,
                        argumentsObj: { taskId },
                    })
                    : { ok: false, reason: 'missing secure wire headers' };
                if (!invocationResult.ok) {
                    return sendJson(401, { error: 'invocation_rejected', reason: invocationResult.reason });
                }
                const task = taskQueue.cancelTask(taskId);
                if (!task) {
                    return sendJson(404, { error: 'task not found' });
                }
                return sendJson(200, { task });
            }
            if ((method === 'GET' || method === 'DELETE') && u.pathname === '/mcp') {
                const sessionId = req.headers['mcp-session-id'];
                const entry = sessionId && sessions[sessionId] ? sessions[sessionId] : null;
                if (!entry?.transport) {
                    const status = sessionId ? 404 : 400;
                    const message = sessionId ? 'Session not found' : 'Bad Request: Mcp-Session-Id header is required';
                    const code = sessionId ? -32001 : -32000;
                    return sendJson(status, { jsonrpc: '2.0', error: { code, message }, id: null });
                }
                markSessionRequestActive(entry, res);
                try {
                    await entry.transport.handleRequest(req, res);
                } catch (err) {
                    console.error('[AgentServer/MCP] error:', err);
                    if (!res.headersSent) return sendJson(500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
                }
                return;
            }
            if (method === 'POST' && u.pathname === '/mcp') {
                const chunks = [];
                req.on('data', c => chunks.push(c));
                req.on('end', async () => {
                    let body = {};
                    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (_) { body = {}; }
                    const sessionId = req.headers['mcp-session-id'];
                    let entry = sessionId && sessions[sessionId] ? sessions[sessionId] : null;
                    try {
                        if (!entry) {
                            if (!isInitializeRequest(body)) {
                                return sendJson(400, { jsonrpc: '2.0', error: { code: -32000, message: 'Missing session; send initialize first' }, id: null });
                            }
                            // Build the per-session record outside the transport closures so
                            // its `server` field is the *only* strong reference to the McpServer.
                            // Deleting sessions[sid] is then sufficient for V8 to collect the
                            // McpServer and per-tool callbacks. Compiled schemas remain
                            // independently owned by the loaded configuration.
                            const sessionRecord = { transport: null, server: null, lastAccess: Date.now(), activeRequests: 0 };
                            const transport = new StreamableHTTPServerTransport({
                                sessionIdGenerator: () => randomUUID(),
                                enableJsonResponse: true,
                                onsessioninitialized: (sid) => { sessions[sid] = sessionRecord; }
                            });
                            // Set onclose BEFORE server.connect so the SDK wraps (not overwrites)
                            // our handler. Protocol._onclose() must run to clear
                            // _responseHandlers, _progressHandlers, and null _transport.
                            transport.onclose = () => {
                                const sid = transport.sessionId;
                                if (sid && sessions[sid]) delete sessions[sid];
                                sessionRecord.transport = null;
                                sessionRecord.server = null;
                            };
                            sessionRecord.transport = transport;
                            const server = await createServerInstance();
                            sessionRecord.server = server;
                            await server.connect(transport);
                            markSessionRequestActive(sessionRecord, res);
                            await transport.handleRequest(req, res, body);
                            return; // handled
                        }
                        markSessionRequestActive(entry, res);
                        await entry.transport.handleRequest(req, res, body);
                    } catch (err) {
                        console.error('[AgentServer/MCP] error:', err);
                        if (!res.headersSent) return sendJson(500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
                    }
                });
                return;
            }
            if (method === 'POST' && u.pathname === OPENAI_CHAT_COMPLETIONS_PATH) {
                readRawAndJsonBody(req)
                    .then(result => {
                        // Verify the router-minted token (if present) against the
                        // EXACT raw bytes BEFORE parsing/handling. A bad token is a
                        // 401 even when the JSON itself is well-formed.
                        if (rejectInvalidOpenAiRouterToken(req, res, result.rawBody)) {
                            return;
                        }
                        if (!result.ok) {
                            sendOpenAiError(res, 400, 'Invalid JSON body', 'invalid_request_error');
                            return;
                        }
                        return handleOpenAiChatCompletions(req, res, result.body);
                    })
                    .catch(err => {
                        console.error('[AgentServer/OpenAI] request error:', err);
                        if (!res.headersSent) {
                            sendOpenAiError(res, 500, 'Internal server error');
                        } else if (!res.writableEnded) {
                            res.end();
                        }
                });
                return;
            }
            if (method === 'GET' && u.pathname === OPENAI_MODELS_PATH) {
                if (rejectInvalidOpenAiModelsRouterToken(req, res)) {
                    return;
                }
                return handleOpenAiModels(req, res);
            }
            if (await serveStaticFile(req, res, u.pathname)) {
                return;
            }
            // Not found
            res.statusCode = 404; res.end('Not Found');
        } catch (err) {
            console.error('[AgentServer/MCP] http error:', err);
            if (!res.headersSent) return sendJson(500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
        }
    });

    const isContainerRuntime = Boolean(process.env.PLOINKY_CONTAINER_ID || process.env.PLOINKY_CONTAINER_NAME);
    const HOST = process.env.PLOINKY_AGENT_BIND_HOST || (isContainerRuntime ? '0.0.0.0' : '127.0.0.1');
    let shutdownPromise = null;
    const shutdown = (signal) => {
        if (shutdownPromise) return shutdownPromise;
        shutdownPromise = (async () => {
            shuttingDown = true;
            clearInterval(sessionGcTimer);

            // Stop accepting new work first. Existing MCP transports are then
            // closed through their application API; serverHttp.close() does not
            // acknowledge until every remaining HTTP connection has drained.
            const listenerClosed = new Promise((resolve, reject) => {
                serverHttp.close((error) => {
                    if (error) reject(error);
                    else resolve();
                });
            });
            serverHttp.closeIdleConnections?.();
            const transports = [...new Set(Object.values(sessions)
                .map((entry) => entry?.transport)
                .filter(Boolean))];
            const transportResults = await Promise.allSettled(
                transports.map((transport) => Promise.resolve(transport.close())),
            );
            const rejectedTransport = transportResults.find((result) => result.status === 'rejected');
            if (rejectedTransport) throw rejectedTransport.reason;
            // Fails queued and in-flight worker calls and kills every worker
            // process group before the task queue drains.
            const workerShutdown = await shutdownToolWorkerPools({ timeoutMs: 20_000, pools: toolWorkerPools });
            await stopToolCodeIdentityThread();
            await taskQueue.shutdown({ timeoutMs: 20_000, pollMs: 10 });
            await listenerClosed;
            // Exit zero acknowledges the complete drain to targeted lifecycle
            // consumers. Preserve worker failure after the other drains finish.
            if (!workerShutdown.clean) {
                throw new Error('Tool worker processes were still present when the shutdown wait ended');
            }
            process.exitCode = 0;
        })().catch((error) => {
            process.exitCode = 1;
            console.error(`[AgentServer/MCP] graceful ${signal} shutdown failed:`, error);
        });
        return shutdownPromise;
    };
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
        process.once(signal, () => { void shutdown(signal); });
    }
    serverHttp.listen(PORT, HOST, () => {
        console.log(`[AgentServer/MCP] Streamable HTTP listening on ${HOST}:${PORT} (/mcp)`);
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main().catch(err => { console.error('[AgentServer/MCP] fatal error:', err); process.exit(1); });
}
