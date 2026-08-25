import { randomUUID } from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { zod } from 'mcp-sdk';
import { TaskQueue } from './TaskQueue.mjs';
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
import { describeShellFailure } from '../lib/toolError.mjs';
import {
    buildDefaultOpenAiChatResponse,
    buildDefaultStreamRejection
} from './openAiDefaultResponder.mjs';
import { buildLoopToolsFromMcp } from './mcpToolBridge.mjs';
import { importAgentLibFile } from '../lib/agentlibResolve.mjs';
const { z } = zod;
// achillesAgentLib is resolved from the one selected source through the
// explicit resolver, never from an install tree next to this file.
const { isOptOutModel, runOpenAiAgenticResponse } = await importAgentLibFile(
    'LLMAgents/openAiAgenticResponder.mjs',
);

const DEFAULT_MAX_CONCURRENT_TASKS = 10;
const DEFAULT_TASK_LOG_TAIL_BYTES = 128 * 1024;
const TASK_QUEUE_FILE = path.resolve(process.cwd(), '.tasksQueue');
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

function getStaticCacheControl(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (['.woff2', '.woff', '.ttf', '.otf'].includes(ext)) {
        return 'public, max-age=31536000, immutable';
    }
    if (['.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.webp'].includes(ext)) {
        return 'public, max-age=86400';
    }
    if (['.js', '.mjs', '.css'].includes(ext)) {
        return 'public, max-age=300';
    }
    return 'public, max-age=60';
}

async function serveStaticFile(req, res, pathname) {
    const method = String(req.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') return false;
    const filePath = await resolveStaticFile(pathname);
    if (!filePath) return false;
    const stat = await fs.promises.stat(filePath);
    res.writeHead(200, {
        'Content-Type': getStaticMimeType(filePath),
        'Content-Length': stat.size,
        'Cache-Control': getStaticCacheControl(filePath)
    });
    if (method === 'HEAD') {
        res.end();
        return true;
    }
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => {
        if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
        }
        res.end('Internal Server Error');
    });
    stream.pipe(res);
    return true;
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
    const toolsMap = buildLoopToolsFromMcp({
        tools: config?.tools,
        defaultCwd: process.env.PLOINKY_CODE_DIR || '/code',
        buildCommandSpec,
        runTool: executeShell,
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

function createLiteralUnionSchema(values) {
    if (!Array.isArray(values) || values.length === 0) {
        return null;
    }
    const unique = [...new Set(values)];
    if (unique.length === 1) {
        return z.literal(unique[0]);
    }
    return z.union(unique.map(value => z.literal(value)));
}

function buildZodObjectSchema(spec) {
    if (!spec || typeof spec !== 'object') {
        return null;
    }
    const shape = {};
    let hasFields = false;
    for (const [key, fieldSpec] of Object.entries(spec)) {
        shape[key] = createFieldSchema(fieldSpec);
        hasFields = true;
    }
    if (!hasFields) {
        return z.object({});
    }
    return z.object(shape);
}

function createFieldSchema(fieldSpec) {
    if (typeof fieldSpec === 'string') {
        fieldSpec = { type: fieldSpec };
    }
    if (!fieldSpec || typeof fieldSpec !== 'object') {
        return z.any();
    }
    const type = typeof fieldSpec.type === 'string' ? fieldSpec.type.toLowerCase() : 'string';
    let schema;
    switch (type) {
        case 'string': {
            if (Array.isArray(fieldSpec.enum) && fieldSpec.enum.every(value => typeof value === 'string')) {
                schema = createLiteralUnionSchema(fieldSpec.enum) || z.string();
            } else {
                schema = z.string();
            }
            if (typeof fieldSpec.minLength === 'number') {
                schema = schema.min(fieldSpec.minLength);
            }
            if (typeof fieldSpec.maxLength === 'number') {
                schema = schema.max(fieldSpec.maxLength);
            }
            break;
        }
        case 'number': {
            schema = z.number();
            if (typeof fieldSpec.min === 'number') {
                schema = schema.min(fieldSpec.min);
            }
            if (typeof fieldSpec.max === 'number') {
                schema = schema.max(fieldSpec.max);
            }
            if (Array.isArray(fieldSpec.enum) && fieldSpec.enum.every(value => typeof value === 'number')) {
                schema = createLiteralUnionSchema(fieldSpec.enum) || schema;
            }
            break;
        }
        case 'boolean':
            schema = z.boolean();
            break;
        case 'array': {
            const itemSchema = createFieldSchema(fieldSpec.items ?? { type: 'string' });
            schema = z.array(itemSchema);
            if (typeof fieldSpec.minItems === 'number') {
                schema = schema.min(fieldSpec.minItems);
            }
            if (typeof fieldSpec.maxItems === 'number') {
                schema = schema.max(fieldSpec.maxItems);
            }
            break;
        }
        case 'object': {
            const nested = buildZodObjectSchema(fieldSpec.properties) || z.object({});
            schema = fieldSpec.additionalProperties === true ? nested.passthrough() : nested;
            break;
        }
        default:
            schema = z.any();
            break;
    }

    if (!schema) {
        schema = z.any();
    }

    if (fieldSpec.isArray && type !== 'array') {
        let arraySchema = z.array(schema);
        if (typeof fieldSpec.minItems === 'number') {
            arraySchema = arraySchema.min(fieldSpec.minItems);
        }
        if (typeof fieldSpec.maxItems === 'number') {
            arraySchema = arraySchema.max(fieldSpec.maxItems);
        }
        schema = arraySchema;
    }

    if (Array.isArray(fieldSpec.enum) && !['string', 'number'].includes(type)) {
        const enumSchema = createLiteralUnionSchema(fieldSpec.enum);
        if (enumSchema) {
            schema = enumSchema;
        }
    }

    if (fieldSpec.nullable) {
        schema = schema.nullable();
    }
    if (fieldSpec.optional) {
        schema = schema.optional();
    }
    if (typeof fieldSpec.description === 'string' && schema.describe) {
        schema = schema.describe(fieldSpec.description);
    }
    return schema;
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

function sendOpenAiError(res, statusCode, message, type = 'server_error') {
    const payload = { error: { message, type } };
    const data = Buffer.from(JSON.stringify(payload));
    res.writeHead(statusCode, { 'Content-Type': 'application/json', 'Content-Length': data.length });
    res.end(data);
}

function writeSseError(res, message, type = 'server_error') {
    const payload = JSON.stringify({ error: { message, type } });
    res.write(`data: ${payload}\n\n`);
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
            sendOpenAiError(res, 500, describeShellFailure(result));
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
    const stderrChunks = [];
    let timeout = null;
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timeout = setTimeout(() => {
            try { child.kill('SIGTERM'); } catch (_) { }
        }, timeoutMs);
    }
    child.stdout.on('data', chunk => {
        stdoutBytes += chunk.length;
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
            if (code !== 0 && stdoutBytes === 0) {
                const stderr = Buffer.concat(stderrChunks).toString('utf8');
                const failure = describeShellFailure({ code, signal, stdout: '', stderr });
                writeSseError(res, failure);
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
            const invocation = async (...cbArgs) => {
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
                console.log(`[AgentServer/MCP] Tool '${name}' args:`, sanitizeValueForLog(args));
                console.log(`[AgentServer/MCP] Tool '${name}' context:`, sanitizeContextForLog(context));
                const payload = { tool: name, input: args, metadata: context };
                console.log(`[AgentServer/MCP] Tool '${name}' payload:`, JSON.stringify(sanitizePayloadForLog(payload)));
                if (isAsync) {
                    const enqueued = taskQueue.enqueueTask({
                        toolName: name,
                        commandSpec,
                        payload,
                        timeoutMs: asyncTimeout,
                        logRetention: taskLogRetention,
                        continuationTool,
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
                const result = await executeShell(commandSpec, payload);
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

            const registeredTool = server.registerTool(name, definition, invocation);

            let configuredSchema = null;
            if (tool.inputSchema && typeof tool.inputSchema === 'object') {
                try {
                    configuredSchema = buildZodObjectSchema(tool.inputSchema);
                } catch (err) {
                    console.error(`[AgentServer/MCP] Failed to build inputSchema for tool '${name}': ${err.message}`);
                }
            }

            if (configuredSchema) {
                registeredTool.inputSchema = configuredSchema;
                if (typeof server.sendToolListChanged === 'function') {
                    server.sendToolListChanged();
                }
            } else if (!registeredTool.inputSchema) {
                registeredTool.inputSchema = z.object({});
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

async function createServerInstance() {
    const { McpServer, ResourceTemplate, McpError, ErrorCode } = await loadSdkDeps();
    const server = new McpServer({ name: 'ploinky-agent-mcp', version: '1.0.0' });

    const configResult = getConfigResult();
    const config = configResult ? configResult.config : {};

    if (configResult) {
        console.log(`[AgentServer/MCP] Loaded config from ${configResult.source}`);
    } else {
        console.log('[AgentServer/MCP] No configuration file found; starting with an empty configuration.');
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
    // their full McpServer (plus per-tool zod schemas and closures). Sweep
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

    const serverHttp = http.createServer(async (req, res) => {
        const { method, url } = req;
        const sendJson = (code, obj, extraHeaders = {}) => {
            const data = Buffer.from(JSON.stringify(obj));
            res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': data.length, ...extraHeaders });
            res.end(data);
        };
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
                            // McpServer + per-tool zod schemas + closures.
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
    serverHttp.listen(PORT, HOST, () => {
        console.log(`[AgentServer/MCP] Streamable HTTP listening on ${HOST}:${PORT} (/mcp)`);
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main().catch(err => { console.error('[AgentServer/MCP] fatal error:', err); process.exit(1); });
}
