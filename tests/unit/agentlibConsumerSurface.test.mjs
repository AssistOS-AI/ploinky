// The library surface Ploinky actually consumes, and the check that keeps its
// declarations in step with the code.
//
// Ploinky loads a handful of AgentLib modules and MCP SDK exports by name. The
// image that supplies those libraries proves the same surface in its own smoke,
// so a new consumer has to be added to both repositories in one coordinated
// change. This test scans the real call sites: a consumer that is not declared
// here, a declaration nobody uses, or a required AgentLib entry missing from
// `AGENTLIB_REQUIRED_ENTRYPOINTS` fails it. It then checks the listed exports
// against the deliberate local test sources.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { AGENTLIB_REQUIRED_ENTRYPOINTS } from '../../agentlib/contract.mjs';
import { resolveAgentLibPath } from '../../agentlib/runtime.mjs';
import { resolveTestAgentLibSource } from '../helpers/agentlibTestContract.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCANNED_DIRECTORIES = ['Agent', 'agentlib', 'cli', 'ploinky-box'];

/**
 * AgentLib subpaths passed to `importAgentLibFile`, `importAgentLib` or
 * `resolveAgentLibPath`. `entry` is the file the subpath resolves to.
 * `required: false` marks a consumer that tolerates the file being absent.
 */
const AGENTLIB_CONSUMERS = Object.freeze([
    {
        subpath: 'LLMAgents/openAiAgenticResponder.mjs',
        entry: 'LLMAgents/openAiAgenticResponder.mjs',
        exports: { isOptOutModel: 'function', runOpenAiAgenticResponse: 'function' },
        consumer: 'Agent/server/AgentServer.mjs',
    },
    {
        subpath: 'LLMAgents',
        entry: 'LLMAgents/index.mjs',
        exports: {},
        consumer: 'cli/commands/cli.js',
    },
    {
        subpath: 'utils/LLMClient.mjs',
        entry: 'utils/LLMClient.mjs',
        exports: { defaultLLMInvokerStrategy: 'function', getPrioritizedModels: 'function' },
        consumer: 'cli/commands/llmSystemCommands.js, cli/shell.js',
    },
    {
        subpath: 'jwt/jwtSign.mjs',
        entry: 'jwt/jwtSign.mjs',
        exports: { signHmacJwt: 'function', bodyHashForRequest: 'function', canonicalJson: 'function' },
        consumer: 'Agent/lib/jwtSign.mjs',
    },
    {
        subpath: 'jwt/jwtVerify.mjs',
        entry: 'jwt/jwtVerify.mjs',
        exports: {
            verifyJws: 'function',
            verifyInvocationToken: 'function',
            createMemoryReplayCache: 'function',
            canonicalJson: 'function',
            bodyHashForRequest: 'function',
            MAX_TTL_SECONDS: 'finite-number',
            DEFAULT_CLOCK_SKEW_SECONDS: 'finite-number',
        },
        consumer: 'Agent/lib/jwtVerify.mjs',
    },
    {
        // The consumer tolerates a missing or unparsable file and falls back to
        // an empty key list, so it is deliberately not a required entry point.
        subpath: 'LLMConfig.json',
        entry: 'LLMConfig.json',
        required: false,
        exports: {},
        consumer: 'cli/commands/llmProviderUtils.js',
    },
]);

/** MCP SDK members imported by name, with the members each must expose. */
const MCP_SDK_CONSUMERS = Object.freeze({
    zod: {
        members: ['z'],
        zodMembers: ['object', 'array', 'string', 'number', 'boolean', 'null', 'literal', 'union', 'any', 'unknown'],
        consumer: 'Agent/server/inputSchema.mjs, Agent/server/toolInputSchemaCache.mjs',
    },
    types: { members: ['isInitializeRequest', 'McpError', 'ErrorCode'], consumer: 'Agent/server/AgentServer.mjs' },
    streamHttp: { members: ['StreamableHTTPServerTransport'], consumer: 'Agent/server/AgentServer.mjs' },
    mcp: { members: ['McpServer', 'ResourceTemplate'], consumer: 'Agent/server/AgentServer.mjs' },
    client: { members: ['Client'], consumer: 'cli/server/AgentClient.js' },
    StreamableHTTPClientTransport: { members: [], isConstructor: true, consumer: 'cli/server/AgentClient.js' },
});

function sourceFiles(directory) {
    const found = [];
    const walk = (current) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
            const absolute = path.join(current, entry.name);
            if (entry.isDirectory()) walk(absolute);
            else if (/\.(?:mjs|js)$/.test(entry.name)) found.push(absolute);
        }
    };
    walk(path.join(repoRoot, directory));
    return found;
}

const allSources = SCANNED_DIRECTORIES.flatMap(sourceFiles)
    .map((file) => ({ file: path.relative(repoRoot, file), text: fs.readFileSync(file, 'utf8') }));

function scannedAgentLibSubpaths() {
    const found = new Map();
    const call = /\b(importAgentLibFile|importAgentLib|resolveAgentLibPath)\(\s*(['"])([^'"]+)\2/g;
    for (const { file, text } of allSources) {
        for (const match of text.matchAll(call)) {
            if (!found.has(match[3])) found.set(match[3], new Set());
            found.get(match[3]).add(file);
        }
    }
    return found;
}

function scannedMcpSdkMembers() {
    const found = new Set();
    for (const { text } of allSources) {
        for (const match of text.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]mcp-sdk['"]/g)) {
            for (const part of match[1].split(',')) {
                const name = part.trim().split(/\s+as\s+/)[0].trim();
                if (name) found.add(name);
            }
        }
        for (const match of text.matchAll(/const\s*\{([^}]+)\}\s*=\s*await\s+import\(\s*['"]mcp-sdk['"]\s*\)/g)) {
            for (const part of match[1].split(',')) {
                const name = part.trim().split(':')[0].trim();
                if (name) found.add(name);
            }
        }
    }
    return found;
}

function kindOf(value) {
    if (typeof value === 'function') return 'function';
    if (typeof value === 'number' && Number.isFinite(value)) return 'finite-number';
    return typeof value;
}

test('every AgentLib subpath a Ploinky call site loads is declared, and every declaration is used', () => {
    const scanned = scannedAgentLibSubpaths();
    const declared = new Set(AGENTLIB_CONSUMERS.map((row) => row.subpath));
    assert.deepEqual(
        [...scanned.keys()].filter((subpath) => !declared.has(subpath)).sort(),
        [],
        'an AgentLib subpath is loaded by Ploinky but missing from the consumer table; add it here and to the image smoke together',
    );
    assert.deepEqual(
        [...declared].filter((subpath) => !scanned.has(subpath)).sort(),
        [],
        'a declared AgentLib subpath has no call site any more; remove it here and from the image smoke together',
    );
});

test('every required AgentLib consumer is a required entry point, and nothing extra is required', () => {
    const requiredEntries = new Set(AGENTLIB_CONSUMERS.filter((row) => row.required !== false).map((row) => row.entry));
    for (const entry of requiredEntries) {
        assert.ok(AGENTLIB_REQUIRED_ENTRYPOINTS.includes(entry), `${entry} is consumed but not in AGENTLIB_REQUIRED_ENTRYPOINTS`);
    }
    const extra = AGENTLIB_REQUIRED_ENTRYPOINTS.filter((entry) => entry !== 'package.json' && !requiredEntries.has(entry));
    assert.deepEqual(extra, [], 'AGENTLIB_REQUIRED_ENTRYPOINTS lists an entry no consumer loads');
    assert.ok(AGENTLIB_REQUIRED_ENTRYPOINTS.includes('LLMAgents/openAiAgenticResponder.mjs'),
        'the module AgentServer imports at startup must be a required entry point');
    assert.equal(AGENTLIB_REQUIRED_ENTRYPOINTS.includes('LLMConfig.json'), false,
        'LLMConfig.json is optional: its consumer falls back to an empty key list');
});

test('the optional LLMConfig.json consumer really tolerates a missing file', () => {
    const text = fs.readFileSync(path.join(repoRoot, 'cli/commands/llmProviderUtils.js'), 'utf8');
    assert.match(text, /resolveAgentLibPath\('LLMConfig\.json'\)/);
    assert.match(text, /catch/, 'the LLMConfig.json reader must keep its fallback for a missing or unparsable file');
});

test('the listed AgentLib exports exist with the listed kinds in the deliberate test source', async () => {
    const root = resolveTestAgentLibSource();
    for (const row of AGENTLIB_CONSUMERS.filter((candidate) => candidate.required !== false)) {
        const file = resolveAgentLibPath(row.subpath, { root });
        assert.ok(file.endsWith(row.entry), `${row.subpath} resolves to ${file}, not ${row.entry}`);
        const module = await import(pathToFileURL(file).href);
        for (const [name, kind] of Object.entries(row.exports)) {
            assert.equal(kindOf(module[name]), kind, `${row.subpath}: export ${name} must be a ${kind}`);
        }
    }
});

test('every MCP SDK export a Ploinky import names is declared', () => {
    const scanned = scannedMcpSdkMembers();
    const declared = new Set(Object.keys(MCP_SDK_CONSUMERS));
    assert.deepEqual([...scanned].filter((name) => !declared.has(name)).sort(), [],
        'an mcp-sdk export is imported but missing from the consumer table; add it here and to the image smoke together');
    assert.deepEqual([...declared].filter((name) => !scanned.has(name)).sort(), [],
        'a declared mcp-sdk export is no longer imported; remove it here and from the image smoke together');
});

test('the listed MCP SDK exports and members exist in the deliberate test source', async () => {
    const sdk = await import('mcp-sdk');
    for (const [name, spec] of Object.entries(MCP_SDK_CONSUMERS)) {
        assert.ok(sdk[name], `mcp-sdk must export ${name}`);
        if (spec.isConstructor) assert.equal(typeof sdk[name], 'function', `${name} must be a constructor`);
        for (const member of spec.members) {
            assert.ok(sdk[name][member], `mcp-sdk ${name} must expose ${member}`);
        }
    }
    for (const member of MCP_SDK_CONSUMERS.zod.zodMembers) {
        assert.equal(typeof sdk.zod.z[member], 'function', `mcp-sdk zod.z must expose ${member}()`);
    }
});
