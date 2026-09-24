// Explicit npm install policy for the immutable dependency cache.
//
// Host installs must not inherit ambient npm behavior silently. Inherited npm
// configuration (environment `npm_config_*`, user and global npmrc) is split
// into three classes:
//   keyed      cache-affecting settings that are represented explicitly in the
//              install contract and passed to npm through a generated config;
//   transport  credentials, TLS and proxy settings: passed to npm transiently,
//              never written to keys, stamps, manifests or logs;
//   ignored    output/UX-only settings.
// Any other key is an unrepresentable cache-affecting input and fails the
// build explicitly instead of claiming deterministic reuse.
//
// Container installs run with the image's own npm configuration only (the
// host environment is not passed into the installer container); the image is
// keyed by its immutable ID, so the container policy carries no host settings.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { cacheV4Error } from './canonical.mjs';

export const NPM_POLICY_SCHEMA = 1;
export const NPM_BASE_INSTALL_ARGS = Object.freeze(['install', '--no-package-lock', '--no-audit', '--no-fund', '--update-notifier=false']);
// The container installer runs the legacy install script, whose npm argv is
// exactly this list (asserted against the script text in tests).
export const CONTAINER_NPM_INSTALL_ARGS = Object.freeze(['install', '--no-package-lock', '--no-audit', '--no-fund']);
const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';

const KEYED = new Set([
    'registry', 'omit', 'include', 'production', 'legacy-peer-deps', 'strict-peer-deps',
    'install-strategy', 'ignore-scripts', 'engine-strict', 'before', 'global-style', 'legacy-bundling',
]);
const TRANSPORT = new Set([
    '_auth', '_authtoken', '_password', 'username', 'email', 'always-auth', 'ca', 'cafile', 'cert', 'key',
    'strict-ssl', 'proxy', 'https-proxy', 'noproxy', 'local-address', 'maxsockets', 'fetch-retries',
    'fetch-retry-factor', 'fetch-retry-mintimeout', 'fetch-retry-maxtimeout', 'fetch-timeout',
    'offline', 'prefer-offline', 'prefer-online', 'auth-type', 'otp',
]);
const IGNORED = new Set([
    'loglevel', 'progress', 'color', 'fund', 'audit', 'update-notifier', 'unicode', 'timing', 'logs-dir',
    'logs-max', 'init-module', 'init-author-name', 'init-author-email', 'init-author-url', 'init-license',
    'init-version', 'sign-git-tag', 'message', 'save', 'save-exact', 'save-prefix', 'save-dev', 'save-optional',
    'save-peer', 'save-bundle', 'package-lock', 'package-lock-only', 'user-agent', 'heading', 'editor', 'browser',
    'viewer', 'usage', 'yes', 'npm-version', 'node-version', 'prefix', 'global-prefix', 'local-prefix', 'cache',
    'userconfig', 'globalconfig', 'node-gyp', 'metrics-registry', 'send-metrics', 'foreground-scripts', 'shell',
    'git-tag-version', 'commit-hooks', 'tag-version-prefix', 'searchlimit', 'searchopts', 'searchexclude',
    'searchstaleness', 'description', 'long', 'parseable', 'json', 'depth', 'fund', 'audit-level',
]);
const CANONICAL_TRANSPORT_NAMES = Object.freeze({ _authtoken: '_authToken' });
const TRANSPORT_ENV = Object.freeze([
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'SSH_AUTH_SOCK', 'GIT_SSH_COMMAND',
]);
const BASE_ENV = Object.freeze(['HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TERM']);

function unrepresentable(key, source) {
    return cacheV4Error('PLOINKY_DEPS_NPM_POLICY_UNREPRESENTABLE',
        `npm setting '${key}' from ${source} can change installed dependencies but cannot be represented in the dependency cache key; `
        + 'remove it or run the agent in a container runtime');
}

function classify(key) {
    const lower = key.toLowerCase();
    if (lower.startsWith('//')) return 'transport';
    if (/^@[^/:]+:registry$/.test(lower)) return 'keyed-scope';
    if (KEYED.has(lower)) return 'keyed';
    if (TRANSPORT.has(lower)) return 'transport';
    if (IGNORED.has(lower)) return 'ignored';
    return 'unknown';
}

function expandEnv(value, env) {
    return String(value).replace(/(?<!\\)\$\{([^}]+)\}/g, (_, name) => env[name] ?? '');
}

/** Minimal npmrc parser: `key=value` lines, `;`/`#` comments, `key[]=value` lists. */
export function parseNpmrc(text, { source = 'npmrc', env = process.env } = {}) {
    const entries = [];
    for (const rawLine of String(text || '').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith(';') || line.startsWith('#')) continue;
        if (line.startsWith('[')) {
            throw cacheV4Error('PLOINKY_DEPS_NPM_POLICY_UNREPRESENTABLE', `ini sections in ${source} are not supported`);
        }
        const index = line.indexOf('=');
        const rawKey = (index < 0 ? line : line.slice(0, index)).trim();
        let value = index < 0 ? 'true' : line.slice(index + 1).trim();
        if (/^".*"$/.test(value)) {
            try { value = JSON.parse(value); } catch { /* keep literal */ }
        }
        const list = rawKey.endsWith('[]');
        entries.push({ key: expandEnv(list ? rawKey.slice(0, -2) : rawKey, env), value: expandEnv(value, env), list, source });
    }
    return entries;
}

function envEntries(env) {
    const entries = [];
    for (const [name, value] of Object.entries(env || {})) {
        const match = /^npm_config_(.+)$/i.exec(name);
        if (!match || value === undefined) continue;
        const rest = match[1];
        const leading = /^_+/.exec(rest)?.[0] || '';
        const key = `${leading}${rest.slice(leading.length).replace(/_/g, '-')}`;
        entries.push({ key, value: String(value), list: false, source: `environment ${name}` });
    }
    return entries;
}

function bool(value) {
    const text = String(value).trim().toLowerCase();
    return !(text === 'false' || text === '0' || text === '' || text === 'null' || text === 'undefined');
}

function splitList(value) {
    return String(value).split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
}

export function defaultNpmConfigSources({ env = process.env, npmPrefix = null, fsApi = fs } = {}) {
    const read = (file) => {
        if (!file) return null;
        try { return { path: file, text: fsApi.readFileSync(file, 'utf8') }; }
        catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
    };
    const home = env.HOME || os.homedir();
    const userconfig = env.npm_config_userconfig || env.NPM_CONFIG_USERCONFIG || path.join(home, '.npmrc');
    const prefix = env.npm_config_prefix || env.NPM_CONFIG_PREFIX || npmPrefix || path.dirname(path.dirname(process.execPath));
    const globalconfig = env.npm_config_globalconfig || env.NPM_CONFIG_GLOBALCONFIG || path.join(prefix, 'etc', 'npmrc');
    return { env, files: [read(globalconfig), read(userconfig)].filter(Boolean) };
}

/**
 * Resolve the explicit host npm policy.
 *
 * @param {{ env: object, files: Array<{path: string, text: string}> }} sources
 *   files in increasing precedence (global, then user); environment wins.
 * @returns {{ policy: object, transport: { npmrcLines: string[], env: object } }}
 *   `policy` is keyed; `transport` must never be persisted or logged.
 */
export function resolveHostNpmPolicy(sources) {
    const env = sources?.env || {};
    const values = new Map();
    const transport = new Map();
    const scoped = {};
    const entries = [
        ...(sources?.files || []).flatMap((file) => parseNpmrc(file.text, { source: file.path, env })),
        ...envEntries(env),
    ];
    for (const entry of entries) {
        const kind = classify(entry.key);
        if (kind === 'ignored') continue;
        if (kind === 'unknown') throw unrepresentable(entry.key, entry.source);
        if (kind === 'transport') {
            const name = entry.key.startsWith('//') ? entry.key : (CANONICAL_TRANSPORT_NAMES[entry.key.toLowerCase()] || entry.key.toLowerCase());
            transport.set(name, entry.value);
            continue;
        }
        if (kind === 'keyed-scope') {
            scoped[entry.key.toLowerCase().split(':')[0]] = normalizeRegistry(entry.value);
            continue;
        }
        const key = entry.key.toLowerCase();
        if (entry.list && values.has(key) && ['omit', 'include'].includes(key)) {
            values.set(key, `${values.get(key)} ${entry.value}`);
        } else {
            values.set(key, entry.value);
        }
    }
    const nodeEnv = env.NODE_ENV === undefined ? null : String(env.NODE_ENV);
    const include = values.has('include') ? splitList(values.get('include')).sort() : [];
    let omit = values.has('omit') ? splitList(values.get('omit')) : [];
    if (!values.has('omit') && ((values.has('production') && bool(values.get('production'))) || nodeEnv === 'production')) {
        omit = ['dev'];
    }
    omit = [...new Set(omit.filter((item) => !include.includes(item)))].sort();
    for (const item of [...omit, ...include]) {
        if (!['dev', 'optional', 'peer'].includes(item)) throw unrepresentable(`omit/include=${item}`, 'npm configuration');
    }
    const policy = {
        schema: NPM_POLICY_SCHEMA,
        source: 'host-explicit',
        registry: normalizeRegistry(values.get('registry') || DEFAULT_REGISTRY),
        scopedRegistries: Object.fromEntries(Object.entries(scoped).sort(([a], [b]) => a.localeCompare(b))),
        omit,
        include,
        legacyPeerDeps: values.has('legacy-peer-deps') ? bool(values.get('legacy-peer-deps')) : false,
        strictPeerDeps: values.has('strict-peer-deps') ? bool(values.get('strict-peer-deps')) : false,
        installStrategy: values.has('install-strategy') ? String(values.get('install-strategy'))
            : (values.has('global-style') && bool(values.get('global-style')) ? 'shallow'
                : (values.has('legacy-bundling') && bool(values.get('legacy-bundling')) ? 'nested' : 'hoisted')),
        ignoreScripts: values.has('ignore-scripts') ? bool(values.get('ignore-scripts')) : false,
        engineStrict: values.has('engine-strict') ? bool(values.get('engine-strict')) : false,
        before: values.has('before') ? String(values.get('before')) : null,
        nodeEnv,
        args: [...NPM_BASE_INSTALL_ARGS],
    };
    if (!['hoisted', 'nested', 'shallow', 'linked'].includes(policy.installStrategy)) {
        throw unrepresentable(`install-strategy=${policy.installStrategy}`, 'npm configuration');
    }
    const transportEnv = {};
    for (const name of TRANSPORT_ENV) if (env[name] !== undefined) transportEnv[name] = env[name];
    return {
        policy,
        transport: Object.freeze({
            npmrcLines: [...transport.entries()].map(([key, value]) => `${key}=${value}`),
            env: Object.freeze(transportEnv),
        }),
    };
}

export function containerNpmPolicy() {
    return {
        schema: NPM_POLICY_SCHEMA,
        source: 'image',
        args: [...CONTAINER_NPM_INSTALL_ARGS],
    };
}

function normalizeRegistry(value) {
    const text = String(value || '').trim();
    let url;
    try { url = new URL(text); } catch { throw unrepresentable(`registry=${text}`, 'npm configuration'); }
    if (url.username || url.password) {
        throw cacheV4Error('PLOINKY_DEPS_NPM_POLICY_UNREPRESENTABLE', 'registry URLs must not embed credentials; use an npmrc auth token');
    }
    return url.href.endsWith('/') ? url.href : `${url.href}/`;
}

/** Explicit npm configuration text for the keyed policy plus transient transport lines. */
export function renderNpmrc(policy, transport = null) {
    const lines = [`registry=${policy.registry}`];
    for (const [scope, registry] of Object.entries(policy.scopedRegistries || {})) lines.push(`${scope}:registry=${registry}`);
    for (const item of policy.omit || []) lines.push(`omit[]=${item}`);
    for (const item of policy.include || []) lines.push(`include[]=${item}`);
    lines.push(`legacy-peer-deps=${Boolean(policy.legacyPeerDeps)}`);
    lines.push(`strict-peer-deps=${Boolean(policy.strictPeerDeps)}`);
    lines.push(`install-strategy=${policy.installStrategy}`);
    lines.push(`ignore-scripts=${Boolean(policy.ignoreScripts)}`);
    lines.push(`engine-strict=${Boolean(policy.engineStrict)}`);
    if (policy.before) lines.push(`before=${policy.before}`);
    lines.push('update-notifier=false', 'fund=false', 'audit=false');
    for (const line of transport?.npmrcLines || []) lines.push(line);
    return `${lines.join('\n')}\n`;
}

/**
 * The complete environment for a host npm child: an allowlist of base and
 * transport variables, no inherited `npm_config_*`, NODE_OPTIONS or other
 * ambient inputs, and explicit isolated cache/config paths.
 */
export function buildHostNpmEnv({ env = process.env, policy, transport, nodeBinDir, cacheDir, userconfig, globalconfig, ceilingDirectories = [] }) {
    const result = {};
    for (const name of [...BASE_ENV, ...TRANSPORT_ENV]) if (env[name] !== undefined) result[name] = env[name];
    Object.assign(result, transport?.env || {});
    const pathEntries = String(env.PATH || '').split(path.delimiter).filter(Boolean);
    result.PATH = [nodeBinDir, ...pathEntries.filter((entry) => entry !== nodeBinDir)].filter(Boolean).join(path.delimiter);
    if (policy.nodeEnv !== null && policy.nodeEnv !== undefined) result.NODE_ENV = policy.nodeEnv;
    result.npm_config_cache = cacheDir;
    result.npm_config_userconfig = userconfig;
    result.npm_config_globalconfig = globalconfig;
    result.npm_config_update_notifier = 'false';
    result.GIT_TERMINAL_PROMPT = '0';
    result.GIT_CEILING_DIRECTORIES = ceilingDirectories.filter(Boolean).join(path.delimiter);
    result.GIT_CONFIG_COUNT = '2';
    result.GIT_CONFIG_KEY_0 = 'url.https://github.com/.insteadOf';
    result.GIT_CONFIG_VALUE_0 = 'ssh://git@github.com/';
    result.GIT_CONFIG_KEY_1 = 'url.https://github.com/.insteadOf';
    result.GIT_CONFIG_VALUE_1 = 'git@github.com:';
    return result;
}
