import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { bootstrapAgentCredentialContext } from '../lib/agentCredentialBootstrap.mjs';
import { runProviderServerBootstrap } from '../lib/providerInstallBootstrap.mjs';
import {
    createMemoryReplayCache
} from '../lib/jwtVerify.mjs';
import {
    PROVIDER_SANDBOX_MODES,
} from '../lib/providerSandbox.mjs';
import {
    normalizeProviderSandboxConfig,
    PROVIDER_NAME_RE,
} from '../lib/providerSandboxConfig.mjs';
import { createProviderOperationSessionRegistry } from '../lib/providerOperationSessions.mjs';
import { createProviderTaskRuntime } from '../lib/providerTaskRuntime.mjs';
import { startScopedSoulBrokerRegistry } from '../lib/scopedSoulBroker.mjs';
import {
    hasInvocationTokenHeader,
    MCP_READINESS_PROBE_HEADER,
    MCP_READINESS_PROBE_PATH,
    MCP_READINESS_PROBE_TOOL,
    MCP_READINESS_PROBE_VALUE,
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

// Credential validation is the first runtime bootstrap operation. In the
// bwrap path it reads the pipe-materialized descriptor exactly once and fails
// before SDK loading, queue construction, timers, or socket creation.
const agentCredentialContext = bootstrapAgentCredentialContext();
const agentPrincipalId = agentCredentialContext.identity.principalId;
const agentRouteKey = agentCredentialContext.runtime.routeKey;
const [{ zod }, { TaskQueue }] = await Promise.all([
    import('mcp-sdk'),
    import('./TaskQueue.mjs'),
]);
const { z } = zod;
const require = createRequire(import.meta.url);
const achillesAgentLibRoot = path.dirname(require.resolve('achillesAgentLib/package.json'));
const { isOptOutModel, runOpenAiAgenticResponse } = await import(pathToFileURL(path.join(achillesAgentLibRoot, 'LLMAgents/openAiAgenticResponder.mjs')).href);

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
const PROVIDER_EXPORT_RE = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/;
const PROVIDER_LOGIN_OPERATIONS = new Set([
    'login_start',
    'login_status',
    'login_respond',
    'login_cancel',
]);
const PROVIDER_LOGIN_CONTROL_OPERATIONS = new Set([
    'login_status',
    'login_respond',
    'login_cancel',
]);

let scopedSoulBrokerRegistryPromise = null;
const providerOperationSessionRegistry = createProviderOperationSessionRegistry();

function providerPolicyError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

async function ensureScopedSoulBrokerRegistry() {
    if (!scopedSoulBrokerRegistryPromise) {
        scopedSoulBrokerRegistryPromise = startScopedSoulBrokerRegistry({
            credentialContext: agentCredentialContext,
        });
    }
    return scopedSoulBrokerRegistryPromise;
}

export async function __closeProviderInfrastructure({
    taskQueueInstance,
    operationSessionRegistry = providerOperationSessionRegistry,
    brokerRegistryPromise = scopedSoulBrokerRegistryPromise,
} = {}) {
    if (!taskQueueInstance || typeof taskQueueInstance.close !== 'function'
        || !operationSessionRegistry || typeof operationSessionRegistry.close !== 'function') {
        throw providerPolicyError(
            'PLOINKY_PROVIDER_SHUTDOWN_INVALID',
            'provider shutdown requires the task queue and operation session registry',
        );
    }
    let taskQueueFailure = null;
    let operationSessionFailure = null;
    try {
        await taskQueueInstance.close();
    } catch (error) {
        taskQueueFailure = error;
    }
    try {
        await operationSessionRegistry.close();
    } catch (error) {
        operationSessionFailure = error;
    }
    if (taskQueueFailure && operationSessionFailure) {
        const error = new AggregateError(
            [taskQueueFailure, operationSessionFailure],
            'provider shutdown could not prove task and retained-session cleanup',
            { cause: taskQueueFailure },
        );
        error.code = 'PLOINKY_PROVIDER_SHUTDOWN_CLEANUP_UNPROVEN';
        throw error;
    }
    if (taskQueueFailure) throw taskQueueFailure;
    if (operationSessionFailure) throw operationSessionFailure;
    if (brokerRegistryPromise) {
        const brokerRegistry = await brokerRegistryPromise;
        if (!brokerRegistry || typeof brokerRegistry.close !== 'function') {
            throw providerPolicyError(
                'PLOINKY_PROVIDER_SHUTDOWN_INVALID',
                'provider shutdown requires the scoped broker registry',
            );
        }
        await brokerRegistry.close();
    }
}

export async function __shutdownAgentServerRuntime({
    taskQueueInstance,
    operationSessionRegistry = providerOperationSessionRegistry,
    brokerRegistryPromise = scopedSoulBrokerRegistryPromise,
    sessions: activeSessions,
    serverHttp,
    maxProviderCleanupAttempts = 3,
    retryDelayMs = 100,
    transportCloseTimeoutMs = 5_000,
    delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
    if (!serverHttp || typeof serverHttp.close !== 'function'
        || typeof serverHttp.closeAllConnections !== 'function'
        || !activeSessions || typeof activeSessions !== 'object'
        || !Number.isSafeInteger(maxProviderCleanupAttempts)
        || maxProviderCleanupAttempts < 1 || maxProviderCleanupAttempts > 10
        || !Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 10_000
        || !Number.isSafeInteger(transportCloseTimeoutMs)
        || transportCloseTimeoutMs < 1 || transportCloseTimeoutMs > 60_000
        || typeof delay !== 'function') {
        throw providerPolicyError(
            'PLOINKY_PROVIDER_SHUTDOWN_INVALID',
            'AgentServer shutdown dependencies are invalid',
        );
    }
    const httpClosed = new Promise((resolve, reject) => {
        try {
            serverHttp.close((error) => {
                if (!error || error.code === 'ERR_SERVER_NOT_RUNNING') {
                    resolve();
                } else {
                    reject(error);
                }
            });
        } catch (error) {
            reject(error);
        }
    });
    let providerCleanupFailure = null;
    for (let attempt = 1; attempt <= maxProviderCleanupAttempts; attempt += 1) {
        try {
            await __closeProviderInfrastructure({
                taskQueueInstance,
                operationSessionRegistry,
                brokerRegistryPromise,
            });
            providerCleanupFailure = null;
            break;
        } catch (error) {
            providerCleanupFailure = error;
            if (attempt < maxProviderCleanupAttempts && retryDelayMs > 0) {
                await delay(retryDelayMs);
            }
        }
    }
    if (providerCleanupFailure) throw providerCleanupFailure;

    const transportResultsPromise = Promise.allSettled(Object.values(activeSessions).map((entry) => {
        if (!entry?.transport) return Promise.resolve();
        try {
            return Promise.resolve(entry.transport.close());
        } catch (error) {
            return Promise.reject(error);
        }
    }));
    let closeAllFailure = null;
    try {
        serverHttp.closeAllConnections();
    } catch (error) {
        closeAllFailure = error;
    }
    let timeout = null;
    const timedOut = Symbol('agent-server-transport-close-timeout');
    const containment = await Promise.race([
        Promise.all([
            transportResultsPromise,
            Promise.allSettled([httpClosed]),
        ]),
        new Promise((resolve) => {
            timeout = setTimeout(() => resolve(timedOut), transportCloseTimeoutMs);
        }),
    ]);
    if (timeout) clearTimeout(timeout);
    if (containment === timedOut) {
        const error = providerPolicyError(
            'PLOINKY_AGENT_SERVER_SHUTDOWN_TIMEOUT',
            'AgentServer transport and HTTP cleanup exceeded the fixed shutdown deadline',
        );
        error.evidence = Object.freeze({
            transportCount: Object.keys(activeSessions).length,
            timeoutMs: transportCloseTimeoutMs,
        });
        throw error;
    }
    const [transportResults, httpResults] = containment;
    const transportFailures = transportResults
        .filter((result) => result.status === 'rejected')
        .map((result) => result.reason);
    const containmentFailures = [
        ...transportFailures,
        ...httpResults.filter((result) => result.status === 'rejected').map((result) => result.reason),
        ...(closeAllFailure ? [closeAllFailure] : []),
    ];
    if (containmentFailures.length === 1) throw containmentFailures[0];
    if (containmentFailures.length > 1) {
        const error = new AggregateError(
            containmentFailures,
            'AgentServer shutdown could not close all MCP transports and HTTP connections',
            { cause: containmentFailures[0] },
        );
        error.code = 'PLOINKY_AGENT_SERVER_TRANSPORT_CLEANUP_FAILED';
        throw error;
    }
}

function resolveAgentDisplayName(manifest, fallback = 'agent') {
    const manifestName = typeof manifest?.name === 'string' ? manifest.name.trim() : '';
    return manifestName || agentRouteKey || agentPrincipalId || fallback;
}

function verifyInvocationForRequest({ requestHeaders, method, path, tool, argumentsObj }) {
    // Recompute the request-content-hash from the actual request surface and
    // verify the router-minted token binds exactly this method/path/tool/rch.
    const rch = computeRchTool({ method, path, tool, arguments: argumentsObj || {} });
    return verifyRouterRequestFromHeaders(requestHeaders, {
        credentialContext: agentCredentialContext,
        replayCache: invocationReplayCache,
        method,
        path,
        tool,
        rch,
    });
}

function isAuthenticatedReadinessInitialize(requestHeaders) {
    const value = requestHeaders?.[MCP_READINESS_PROBE_HEADER];
    return typeof value === 'string' && value === MCP_READINESS_PROBE_VALUE;
}

function verifyReadinessInitialize({ requestHeaders, params }) {
    return verifyInvocationForRequest({
        requestHeaders,
        method: 'POST',
        path: MCP_READINESS_PROBE_PATH,
        tool: MCP_READINESS_PROBE_TOOL,
        argumentsObj: params,
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

function buildCommandSpec(entry, defaultCwd, providerCapability = null) {
    if (entry?.providerExecution !== undefined) {
        const execution = entry.providerExecution;
        if (!execution || typeof execution !== 'object' || Array.isArray(execution)) {
            throw providerPolicyError('PLOINKY_PROVIDER_EXECUTION_INVALID', 'providerExecution must be an object');
        }
        const keys = Object.keys(execution);
        if (!providerCapability || execution.provider !== providerCapability.provider
            || keys.some((key) => !['provider', 'mode', 'module', 'export'].includes(key))
            || !PROVIDER_NAME_RE.test(String(execution.provider || ''))
            || (execution.mode !== PROVIDER_SANDBOX_MODES.TASK
                && execution.mode !== PROVIDER_SANDBOX_MODES.OPERATION)
            || typeof execution.module !== 'string'
            || !execution.module.startsWith('/code/')
            || !execution.module.endsWith('.mjs')
            || path.normalize(execution.module) !== execution.module
            || !PROVIDER_EXPORT_RE.test(String(execution.export || ''))
            || entry.command !== undefined || entry.args !== undefined || entry.cwd !== undefined
            || entry.env !== undefined) {
            throw providerPolicyError(
                'PLOINKY_PROVIDER_EXECUTION_INVALID',
                'providerExecution must be an exact /code module export with no shell fallback',
            );
        }
        return Object.freeze({
            kind: 'provider-module',
            provider: execution.provider,
            sandboxMode: execution.mode,
            module: execution.module,
            exportName: execution.export,
            timeoutMs: Number.isFinite(entry?.timeoutMs) ? entry.timeoutMs : undefined,
        });
    }
    const hasShellFields = entry && typeof entry === 'object'
        && ['command', 'args', 'cwd', 'env'].some((key) => Object.hasOwn(entry, key));
    if (providerCapability && hasShellFields) {
        throw providerPolicyError(
            'PLOINKY_PROVIDER_EXECUTION_INVALID',
            'provider-capable AgentServer entries cannot use generic shell execution',
        );
    }
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
    return { kind: 'shell', command, args, cwd, env, timeoutMs };
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

function resolveOpenAiChatKind(manifest, providerConfig = initialConfig) {
    const providerCapability = normalizeProviderSandboxConfig(providerConfig);
    const chat = manifest && typeof manifest === 'object' && manifest.endpoints && typeof manifest.endpoints === 'object'
        ? manifest.endpoints.chatCompletions
        : null;
    if (chat && typeof chat === 'object'
        && (providerCapability
            || chat.providerExecution !== undefined
            || (typeof chat.command === 'string' && chat.command.trim()))) {
        const commandSpec = buildCommandSpec(
            chat,
            process.env.PLOINKY_CODE_DIR || '/code',
            providerCapability,
        );
        if (commandSpec) {
            if (commandSpec.kind === 'provider-module'
                && (chat.supportsStream === true || chat.stream === true)) {
                throw providerPolicyError(
                    'PLOINKY_PROVIDER_EXECUTION_INVALID',
                    'provider chat execution does not support direct stream passthrough',
                );
            }
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

function resolveOpenAiModelsKind(manifest, providerConfig = initialConfig) {
    const providerCapability = normalizeProviderSandboxConfig(providerConfig);
    const models = manifest && typeof manifest === 'object' && manifest.endpoints && typeof manifest.endpoints === 'object'
        ? manifest.endpoints.models
        : null;
    if (models && typeof models === 'object'
        && (providerCapability
            || models.providerExecution !== undefined
            || (typeof models.command === 'string' && models.command.trim()))) {
        const commandSpec = buildCommandSpec(
            models,
            process.env.PLOINKY_CODE_DIR || '/code',
            providerCapability,
        );
        if (commandSpec) {
            return { kind: 'command', commandSpec };
        }
    }
    return { kind: 'fallback' };
}

export { resolveOpenAiModelsKind };

export function validateAgentServerManifestExecution(manifest, providerConfig = initialConfig) {
    resolveOpenAiChatKind(manifest, providerConfig);
    resolveOpenAiModelsKind(manifest, providerConfig);
    return true;
}

// Testable core: build the OpenAI completion via the agentic loop. `runResponder`
// is injectable for tests; production passes runOpenAiAgenticResponse.
export async function __buildAgenticCompletion({ body, manifest, config, agentId, runResponder = runOpenAiAgenticResponse }) {
    const providerCapability = normalizeProviderSandboxConfig(config);
    const toolsMap = buildLoopToolsFromMcp({
        tools: config?.tools,
        defaultCwd: process.env.PLOINKY_CODE_DIR || '/code',
        buildCommandSpec: (entry, defaultCwd) => buildCommandSpec(
            entry,
            defaultCwd,
            providerCapability,
        ),
        runTool: executeCommand,
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

export function __executeShell(spec, payload, options = {}) {
    return new Promise((resolve, reject) => {
        const { command, args = [], cwd, env, timeoutMs } = spec;
        const child = spawn(command, args, {
            cwd,
            env: { ...process.env, ...env },
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: timeoutMs,
            detached: options.detached === true,
        });
        const stdout = [];
        const stderr = [];
        let settled = false;
        let spawnHookError = null;
        const settleReject = (error) => {
            if (settled) return;
            settled = true;
            reject(error);
        };
        const settleResolve = (result) => {
            if (settled) return;
            settled = true;
            resolve(result);
        };
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
        child.on('error', (error) => settleReject(spawnHookError ?? error));
        child.stdin.on('error', err => {
            if (err?.code === 'EPIPE') {
                return;
            }
            settleReject(spawnHookError ?? err);
        });
        child.on('close', (code, signal) => {
            if (spawnHookError) {
                settleReject(spawnHookError);
                return;
            }
            settleResolve({
                code,
                signal,
                stdout: Buffer.concat(stdout).toString('utf8'),
                stderr: Buffer.concat(stderr).toString('utf8')
            });
        });
        if (typeof options.onSpawn === 'function') {
            try {
                options.onSpawn(child);
            } catch (error) {
                spawnHookError = error;
                child.stdin.destroy();
                return;
            }
        }
        try {
            child.stdin.end(JSON.stringify(payload ?? {}) + '\n');
        } catch (_) {
            // ignore broken pipes
        }
    });
}

export function __resolveProviderInvocationIdentity(payload, createId = randomUUID) {
    const suppliedTaskId = typeof payload?.taskId === 'string' ? payload.taskId.trim() : '';
    const operation = typeof payload?.tool === 'string' && payload.tool.trim()
        ? payload.tool.trim()
        : (typeof payload?.endpoint === 'string' ? payload.endpoint.trim() : '');
    if (!operation || operation.length > 128 || !/^[a-z][a-z0-9._-]*$/.test(operation)) {
        throw providerPolicyError(
            'PLOINKY_PROVIDER_EXECUTION_INVALID',
            'provider execution requires a named tool or endpoint operation',
        );
    }
    const taskId = suppliedTaskId || `operation-${createId()}`;
    if (taskId.length > 255 || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/.test(taskId)) {
        throw providerPolicyError(
            'PLOINKY_PROVIDER_EXECUTION_INVALID',
            'provider execution task identity is invalid',
        );
    }
    return Object.freeze({ taskId, operation });
}

export function __resolveProviderOperationSession(payload) {
    const operation = payload?.input?.operation;
    return typeof operation === 'string' && PROVIDER_LOGIN_OPERATIONS.has(operation)
        ? operation
        : null;
}

function exactOwnerClaim(value, label) {
    if (typeof value !== 'string' || !value || value !== value.trim()
        || Buffer.byteLength(value, 'utf8') > 2048 || value.includes('\0')) {
        throw providerPolicyError(
            'PLOINKY_PROVIDER_LOGIN_OWNER_INVALID',
            `provider login ${label} is invalid`,
        );
    }
    return value;
}

export function __deriveProviderOperationOwner(payload, credentialContext = agentCredentialContext) {
    const invocation = payload?.metadata?.invocation;
    const tool = exactOwnerClaim(payload?.tool, 'tool');
    if (!invocation || typeof invocation !== 'object' || Array.isArray(invocation)
        || exactOwnerClaim(invocation.tool, 'invocation tool') !== tool) {
        throw providerPolicyError(
            'PLOINKY_PROVIDER_LOGIN_OWNER_INVALID',
            'provider login requires a verified caller identity',
        );
    }
    const caller = invocation.caller && typeof invocation.caller === 'object'
        ? `${exactOwnerClaim(invocation.caller.kind, 'caller kind')}:${exactOwnerClaim(invocation.caller.id, 'caller id')}`
        : (typeof invocation.caller === 'string' && invocation.caller
            ? exactOwnerClaim(invocation.caller, 'caller')
            : 'none');
    const actor = invocation.actor && typeof invocation.actor === 'object'
        ? `${exactOwnerClaim(invocation.actor.kind, 'actor kind')}:${exactOwnerClaim(invocation.actor.id, 'actor id')}`
        : 'none';
    const binding = [
        'provider-login-owner-v1',
        exactOwnerClaim(credentialContext?.identity?.principalId, 'agent principal'),
        exactOwnerClaim(credentialContext?.identity?.instanceId, 'agent instance'),
        exactOwnerClaim(credentialContext?.identity?.enableGeneration, 'agent generation'),
        exactOwnerClaim(credentialContext?.runtime?.runtimeKey, 'runtime key'),
        exactOwnerClaim(invocation.iss, 'issuer'),
        exactOwnerClaim(invocation.sub, 'subject'),
        exactOwnerClaim(invocation.workspace_id, 'workspace'),
        caller,
        actor,
        tool,
    ];
    return createHash('sha256').update(JSON.stringify(binding)).digest('hex');
}

export function __parseProviderEndpointResponse(result, commandSpec) {
    let parsed;
    try { parsed = JSON.parse(result?.stdout || '{}'); } catch (cause) {
        throw providerPolicyError(
            'PLOINKY_PROVIDER_ENDPOINT_RESPONSE_INVALID',
            'provider endpoint did not return valid JSON',
        );
    }
    if (commandSpec?.kind !== 'provider-module') return parsed;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
        || parsed.ok !== true || !parsed.response
        || typeof parsed.response !== 'object' || Array.isArray(parsed.response)
        || Object.keys(parsed).some((key) => key !== 'ok' && key !== 'response')) {
        throw providerPolicyError(
            'PLOINKY_PROVIDER_ENDPOINT_RESPONSE_INVALID',
            'provider endpoint module must return the exact response envelope',
        );
    }
    return parsed.response;
}

export async function __executeProviderModuleWithRuntime({
    execute,
    payload,
    provider,
    providerRuntime,
    operationSessionRegistry,
    sessionOperation = __resolveProviderOperationSession(payload),
    ownerBinding,
    signal,
    onStdoutChunk,
    registerRetainedCleanup,
} = {}) {
    if (typeof execute !== 'function' || !PROVIDER_NAME_RE.test(String(provider || ''))
        || !providerRuntime || typeof providerRuntime !== 'object'
        || typeof providerRuntime.assertBoundaryUsed !== 'function'
        || typeof providerRuntime.assertBoundaryUnused !== 'function'
        || typeof providerRuntime.close !== 'function'
        || (registerRetainedCleanup !== undefined
            && typeof registerRetainedCleanup !== 'function')
        || (sessionOperation !== null && !PROVIDER_LOGIN_OPERATIONS.has(sessionOperation))
        || (sessionOperation !== null
            && (!operationSessionRegistry
                || typeof operationSessionRegistry.createInvocation !== 'function'))) {
        throw providerPolicyError(
            'PLOINKY_PROVIDER_EXECUTION_INVALID',
            'provider module execution dependencies are invalid',
        );
    }
    let operationSessionInvocation = null;
    let runtimeOwnedByRegistry = false;
    let abortListener = null;
    let abortCleanupPromise = null;
    try {
        operationSessionInvocation = sessionOperation === null
            ? null
            : operationSessionRegistry.createInvocation({
                provider,
                operation: sessionOperation,
                ownerBinding: ownerBinding ?? __deriveProviderOperationOwner(payload),
                providerRuntime,
            });
        const operationSessions = operationSessionInvocation?.providerApi ?? null;
        const executePromise = Promise.resolve().then(() => execute(payload, Object.freeze({
            providerRuntime,
            operationSessions,
            signal,
        })));
        let result;
        if (sessionOperation === 'login_start' && signal) {
            const abortError = providerPolicyError(
                'PLOINKY_PROVIDER_LOGIN_START_ABORTED',
                'provider login start was aborted before registry commit',
            );
            const abortPromise = new Promise((_, reject) => {
                abortListener = () => {
                    operationSessionInvocation?.revoke?.();
                    if (!abortCleanupPromise) {
                        abortCleanupPromise = (async () => {
                            const current = operationSessionInvocation?.disposition();
                            if (current === 'staged' || current === 'retained') {
                                await operationSessionInvocation.rollback();
                            }
                        })();
                    }
                    abortCleanupPromise.then(
                        () => reject(abortError),
                        (cleanupError) => reject(cleanupError),
                    );
                };
                signal.addEventListener('abort', abortListener, { once: true });
                if (signal.aborted) abortListener();
            });
            result = await Promise.race([executePromise, abortPromise]);
        } else {
            result = await executePromise;
        }
        const disposition = operationSessionInvocation?.disposition() ?? 'unused';
        let controlResult = null;
        if (PROVIDER_LOGIN_CONTROL_OPERATIONS.has(sessionOperation)) {
            controlResult = await operationSessionInvocation.requireControlResult();
            if (operationSessionInvocation.disposition() !== 'control') {
                throw providerPolicyError(
                    'PLOINKY_PROVIDER_LOGIN_CONTROL_REQUIRED',
                    'provider login control must use the AgentServer-owned session registry',
                );
            }
            providerRuntime.assertBoundaryUnused();
        } else if (disposition === 'staged') {
            // Serialize and validate the exact start response before committing
            // the retained runtime to process-wide registry ownership.
        } else if (disposition === 'retained') {
            throw providerPolicyError(
                'PLOINKY_PROVIDER_LOGIN_RETAIN_INVALID',
                'provider module cannot commit its own retained runtime',
            );
        } else if (disposition === 'control') {
            throw providerPolicyError(
                'PLOINKY_PROVIDER_LOGIN_CONTROL_UNEXPECTED',
                'provider execution used a login control session for the wrong operation',
            );
        } else {
            providerRuntime.assertBoundaryUsed();
        }
        const normalized = result && typeof result === 'object'
            ? result
            : { ok: false, error: 'provider module returned an invalid result' };
        const stdout = `${JSON.stringify(normalized)}\n`;
        let exactResponse = null;
        if ((disposition === 'staged' || PROVIDER_LOGIN_CONTROL_OPERATIONS.has(sessionOperation))
            && normalized.ok === true) {
            exactResponse = __parseProviderEndpointResponse(
                { stdout },
                { kind: 'provider-module' },
            );
        }
        if (PROVIDER_LOGIN_CONTROL_OPERATIONS.has(sessionOperation)) {
            if (normalized.ok !== true
                || JSON.stringify(exactResponse) !== JSON.stringify(controlResult)) {
                throw providerPolicyError(
                    'PLOINKY_PROVIDER_LOGIN_CONTROL_RESPONSE_INVALID',
                    'provider login control response does not match the registry result',
                );
            }
        }
        if (disposition === 'staged') {
            if (signal?.aborted) {
                if (abortCleanupPromise) await abortCleanupPromise;
                await operationSessionInvocation.rollback();
                throw providerPolicyError(
                    'PLOINKY_PROVIDER_LOGIN_START_ABORTED',
                    'provider login start was aborted before registry commit',
                );
            }
            if (normalized.ok !== true || !normalized.response) {
                await operationSessionInvocation.rollback();
            } else {
                operationSessionInvocation.commitRetainedOperation(exactResponse);
                runtimeOwnedByRegistry = true;
            }
        }
        if (typeof onStdoutChunk === 'function') onStdoutChunk(Buffer.from(stdout));
        return {
            code: normalized.ok === true ? 0 : 1,
            signal: null,
            stdout,
            stderr: '',
        };
    } catch (error) {
        if (operationSessionInvocation
            && (operationSessionInvocation.disposition() === 'staged'
                || operationSessionInvocation.disposition() === 'retained')) {
            try {
                await operationSessionInvocation.rollback();
                runtimeOwnedByRegistry = false;
            } catch (cleanupError) {
                // Cleanup proof is the authoritative failure. Do not mutate a
                // possibly frozen error object or attach provider-controlled
                // publication details to the surfaced cleanup error.
                throw cleanupError;
            }
        }
        throw error;
    } finally {
        if (signal && abortListener) signal.removeEventListener('abort', abortListener);
        if (!runtimeOwnedByRegistry) {
            try {
                await providerRuntime.close();
            } catch (error) {
                if (error?.ownershipRetained === true && registerRetainedCleanup) {
                    registerRetainedCleanup(() => providerRuntime.close());
                }
                throw error;
            }
        }
    }
}

async function executeProviderModule(spec, payload, options = {}) {
    const providerConfig = normalizeProviderSandboxConfig(initialConfig);
    if (!providerConfig || providerConfig.provider !== spec.provider) {
        throw providerPolicyError(
            'PLOINKY_PROVIDER_EXECUTION_INVALID',
            'provider execution does not match the admitted AgentServer provider',
        );
    }
    const { taskId, operation } = __resolveProviderInvocationIdentity(payload);
    const sessionOperation = __resolveProviderOperationSession(payload);
    // Import and validate provider code before allocating a scoped broker lease.
    // A failed import must not leave an otherwise-unreachable task runtime open.
    const imported = await import(pathToFileURL(spec.module).href);
    const execute = imported?.[spec.exportName];
    if (typeof execute !== 'function') {
        throw providerPolicyError(
            'PLOINKY_PROVIDER_EXECUTION_INVALID',
            'provider module does not export the admitted execution function',
        );
    }
    const brokerRegistry = await ensureScopedSoulBrokerRegistry();
    const providerRuntime = createProviderTaskRuntime({
        credentialContext: agentCredentialContext,
        brokerRegistry,
        mode: spec.sandboxMode,
        provider: spec.provider,
        taskId,
        audience: `${agentPrincipalId}/${operation}`,
        // A retained login runtime is owned by the AgentServer registry after
        // the request ends. The request signal still reaches the provider
        // module during admission, but cannot later terminate the retained
        // canonical helper behind the registry's ownership boundary.
        signal: sessionOperation === 'login_start' ? undefined : options.signal,
        onSpawn: options.onSpawn,
    });
    return __executeProviderModuleWithRuntime({
        execute,
        payload,
        provider: spec.provider,
        providerRuntime,
        operationSessionRegistry: providerOperationSessionRegistry,
        sessionOperation,
        ownerBinding: sessionOperation === null ? undefined : __deriveProviderOperationOwner(payload),
        signal: options.signal,
        onStdoutChunk: options.onStdoutChunk,
        registerRetainedCleanup: options.onRetainedCleanup,
    });
}

function executeCommand(spec, payload, options = {}) {
    if (spec?.kind === 'provider-module') return executeProviderModule(spec, payload, options);
    if (spec?.kind === 'shell') return __executeShell(spec, payload, options);
    throw providerPolicyError('PLOINKY_COMMAND_SPEC_INVALID', 'command specification kind is invalid');
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
        credentialContext: agentCredentialContext,
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
        credentialContext: agentCredentialContext,
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
            agentId: agentPrincipalId,
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
                agentId: agentPrincipalId,
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
            agent: agentPrincipalId,
            authInfo: parseAuthInfoHeader(req.headers)
        }
    };

    if (!wantsStream) {
        const cancellation = new AbortController();
        const abort = () => cancellation.abort();
        req.once('aborted', abort);
        res.once('close', abort);
        let result;
        try {
            result = await executeCommand(openAiConfig.commandSpec, payload, {
                signal: cancellation.signal,
            });
        } finally {
            req.removeListener('aborted', abort);
            res.removeListener('close', abort);
        }
        if (result.code !== 0) {
            sendOpenAiError(res, 500, describeShellFailure(result));
            return;
        }
        let parsed;
        try {
            parsed = __parseProviderEndpointResponse(result, openAiConfig.commandSpec);
        } catch (_) {
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
    const agentName = resolveAgentDisplayName(manifest);
    const declaredTags = normalizeTagList(manifest?.capabilities?.tags);
    const tags = declaredTags.length > 0 ? declaredTags : ['generic-agent'];
    const chatEndpoint = manifest?.endpoints?.chatCompletions;
    const hasCustomChatHandler = Boolean(chatEndpoint?.command || chatEndpoint?.providerExecution);
    const supportsStreaming = chatEndpoint?.stream === true
        || chatEndpoint?.supportsStream === true
        || !hasCustomChatHandler;
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
                    agent: agentPrincipalId,
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
            agent: agentPrincipalId,
            authInfo: parseAuthInfoHeader(req.headers),
        },
    };
    const cancellation = new AbortController();
    const abort = () => cancellation.abort();
    req.once('aborted', abort);
    res.once('close', abort);
    let result;
    try {
        result = await executeCommand(modelsKind.commandSpec, payload, {
            signal: cancellation.signal,
        });
    } finally {
        req.removeListener('aborted', abort);
        res.removeListener('close', abort);
    }
    if (result.code !== 0) {
        sendOpenAiError(res, 500, describeShellFailure(result));
        return;
    }
    let parsed;
    try {
        parsed = __parseProviderEndpointResponse(result, modelsKind.commandSpec);
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
    return /authorization|cookie|jwt|token|secret|password|credential|access[_-]?key|api[_-]?key|continuation[_-]?handle|^response$|^value$|^task$|prompt|messages?|resources?|content|base64|stdin|payload/i.test(String(key || ''));
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

export function __sanitizeProviderLogValue(value) {
    return sanitizeValueForLog(value);
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
    executor: executeCommand
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
    const providerCapability = normalizeProviderSandboxConfig(config);

    if (Array.isArray(config.tools)) {
        for (const tool of config.tools) {
            if (!tool || typeof tool !== 'object') continue;
            const name = typeof tool.name === 'string' ? tool.name : null;
            if (!name) continue;
            const commandSpec = buildCommandSpec(tool, defaultCwd, providerCapability);
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
                            agent: agentPrincipalId,
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
                const result = await executeCommand(commandSpec, payload, {
                    signal: context?.signal instanceof AbortSignal ? context.signal : undefined,
                });
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
                return { content, metadata: { agent: agentPrincipalId } };
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
            const commandSpec = buildCommandSpec(resource, defaultCwd, providerCapability);
            if (!commandSpec) {
                console.warn(`[AgentServer/MCP] Skipping resource '${name}' - missing command`);
                continue;
            }
            if (commandSpec.kind === 'provider-module') {
                throw providerPolicyError(
                    'PLOINKY_PROVIDER_EXECUTION_INVALID',
                    `provider resource ${name} is unsupported; use a named tool or endpoint operation`,
                );
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
                    const result = await __executeShell(commandSpec, payload);
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
                    const result = await __executeShell(commandSpec, payload);
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
    const bootstrapAbort = new AbortController();
    const abortBootstrap = () => {
        const error = providerPolicyError(
            'PLOINKY_AGENT_BOOTSTRAP_ABORTED',
            'AgentServer bootstrap was interrupted',
        );
        bootstrapAbort.abort(error);
    };
    process.once('SIGTERM', abortBootstrap);
    process.once('SIGINT', abortBootstrap);
    let providerConfig;
    try {
        providerConfig = normalizeProviderSandboxConfig(initialConfig);
        validateAgentServerManifestExecution(getManifestResult()?.manifest ?? {}, initialConfig);
        if (providerConfig) {
            // Installation and readiness are admitted inside the selected
            // provider sandbox before any broker, queue, or HTTP listener can
            // exist. Both share the frozen credential context and HOME owner.
            await runProviderServerBootstrap({
                providerConfig,
                credentialContext: agentCredentialContext,
                signal: bootstrapAbort.signal,
                dependencies: { ensureScopedSoulBrokerRegistry },
            });
        }
    } catch (error) {
        process.removeListener('SIGTERM', abortBootstrap);
        process.removeListener('SIGINT', abortBootstrap);
        throw error;
    }
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
                    agent: resolveAgentDisplayName(manifest, 'unknown-agent'),
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
                            if (isAuthenticatedReadinessInitialize(req.headers)) {
                                const readinessAuth = verifyReadinessInitialize({
                                    requestHeaders: req.headers,
                                    params: body.params,
                                });
                                if (!readinessAuth.ok) {
                                    return sendJson(401, {
                                        error: 'invocation_rejected',
                                        reason: readinessAuth.reason,
                                    });
                                }
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

    let shutdownPromise = null;
    let sessionGcStopped = false;
    const shutdown = async (signal) => {
        if (shutdownPromise) return shutdownPromise;
        if (!sessionGcStopped) {
            clearInterval(sessionGcTimer);
            sessionGcStopped = true;
        }
        const attempt = __shutdownAgentServerRuntime({
            taskQueueInstance: taskQueue,
            sessions,
            serverHttp,
        });
        shutdownPromise = attempt;
        try {
            await attempt;
            process.exitCode = 0;
        } catch (error) {
            console.error(`[AgentServer/MCP] ${signal} shutdown failed safely:`, error);
            serverHttp.closeAllConnections?.();
            process.exitCode = 1;
            if (shutdownPromise === attempt) shutdownPromise = null;
            throw error;
        }
    };
    const handleSigterm = () => { shutdown('SIGTERM').catch(() => {}); };
    const handleSigint = () => { shutdown('SIGINT').catch(() => {}); };
    process.on('SIGTERM', handleSigterm);
    process.on('SIGINT', handleSigint);
    process.removeListener('SIGTERM', abortBootstrap);
    process.removeListener('SIGINT', abortBootstrap);
    if (bootstrapAbort.signal.aborted) {
        await shutdown('bootstrap-interrupt');
        return;
    }

    const isContainerRuntime = Boolean(process.env.PLOINKY_CONTAINER_ID || process.env.PLOINKY_CONTAINER_NAME);
    const HOST = process.env.PLOINKY_AGENT_BIND_HOST || (isContainerRuntime ? '0.0.0.0' : '127.0.0.1');
    serverHttp.listen(PORT, HOST, () => {
        console.log(`[AgentServer/MCP] Streamable HTTP listening on ${HOST}:${PORT} (/mcp)`);
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main().catch(err => { console.error('[AgentServer/MCP] fatal error:', err); process.exit(1); });
}
