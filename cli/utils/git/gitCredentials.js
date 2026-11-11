import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { hasHostStateComponent } from '../../../ploinky-box/hostState/paths.mjs';
import { deriveSubkey } from '../security/masterKey.js';
import { decryptSecretsText } from '../security/secretsFileCodec.js';
import {
    AGENT_DATA_POLICY_CODE,
    ensureAgentDataDirectory,
    isPathWithin,
    projectedCanonicalPath,
} from '../runtime/agentDataPathPolicy.js';

// Workspace git credentials for Ploinky's own git operations.
//
// Ploinky owns one directory and one key. An agent that declares the
// `runtime.resources.gitCredentials` manifest resource receives both and may
// write an encrypted credentials file there; Ploinky reads it before every git
// spawn and, when it decrypts, adds an HTTP Authorization header for
// https://github.com through GIT_CONFIG_* environment entries. The token never
// reaches argv, logs or diagnostics. A missing, malformed or undecryptable
// credentials file means "no credentials": git runs exactly as it would without it.
//
// This module deliberately does not load the workspace configuration
// (config.js): host processes such as the Ploinky self-update import the git
// runners and must not have the workspace root resolved or exported for them.

export const GIT_CREDENTIALS_DIR_VAR = 'PLOINKY_GIT_CREDENTIALS_DIR';
export const GIT_CREDENTIALS_SCHEMA = 'ploinky-git-credentials-v1';
export const GIT_CREDENTIALS_ALGORITHM = 'aes-256-gcm';
export const GIT_CREDENTIALS_KEY_PURPOSE = 'git-credentials-v1';
export const GIT_CREDENTIALS_FILE = 'credentials.json';
export const GIT_CREDENTIALS_HOST = 'github.com';
export const DEFAULT_GIT_CREDENTIALS_CONTAINER_PATH = '/git-credentials';

const DEFAULT_RELATIVE_DIR = path.join('.data', '.private', '.git-credentials');
const AAD = Buffer.from(GIT_CREDENTIALS_SCHEMA, 'utf8');
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const MAX_FILE_BYTES = 64 * 1024;

function policyError(message) {
    const error = new Error(message);
    error.code = AGENT_DATA_POLICY_CODE;
    error.status = 422;
    return error;
}

function debug(message) {
    if (process.env.PLOINKY_DEBUG === '1') console.error(`[git-credentials] ${message}`);
}

// The workspace root as config.js resolves it: the exported
// PLOINKY_WORKSPACE_ROOT, else the nearest ancestor of cwd with `.ploinky`,
// else cwd.
function defaultWorkspaceRoot() {
    const explicit = String(process.env.PLOINKY_WORKSPACE_ROOT || '').trim();
    if (explicit) {
        try {
            if (fs.statSync(explicit).isDirectory()) return path.resolve(explicit);
        } catch (_) { }
    }
    const cwd = path.resolve(process.cwd());
    for (let current = cwd; ; current = path.dirname(current)) {
        try {
            if (fs.statSync(path.join(current, '.ploinky')).isDirectory()) return current;
        } catch (_) { }
        if (path.dirname(current) === current) return cwd;
    }
}

// The ploinky var from the workspace's encrypted `.secrets`, resolved through
// `$NAME` aliases like resolveVarValue. The file is only read, never created.
function readDirectoryVar(root) {
    const file = path.join(root, '.ploinky', 'data', '.secrets');
    if (!fs.existsSync(file)) return '';
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (!raw) return '';
    const secrets = decryptSecretsText(raw);
    let value = secrets[GIT_CREDENTIALS_DIR_VAR];
    const seen = new Set();
    while (typeof value === 'string' && value.startsWith('$')) {
        const ref = value.slice(1);
        if (!ref || seen.has(ref)) return '';
        seen.add(ref);
        value = secrets[ref];
    }
    return typeof value === 'string' ? value.trim() : '';
}

/**
 * The host directory that holds the credentials file. The default is
 * `<workspace>/.data/.private/.git-credentials`; the ploinky var
 * PLOINKY_GIT_CREDENTIALS_DIR may move it to another workspace-relative or
 * absolute path that stays inside the workspace and outside the controller
 * root and the Box host state. An escaping override throws a policy error.
 */
export function resolveGitCredentialsDir(workspaceRoot, { override } = {}) {
    const root = workspaceRoot ? path.resolve(String(workspaceRoot)) : defaultWorkspaceRoot();
    const configured = String(override === undefined ? readDirectoryVar(root) : override || '').trim();
    if (!configured) return path.join(root, DEFAULT_RELATIVE_DIR);

    const target = path.isAbsolute(configured) ? path.resolve(configured) : path.resolve(root, configured);
    const escapes = (candidate, parent) => !isPathWithin(candidate, parent) || candidate === parent;
    const canonicalRoot = projectedCanonicalPath(root);
    const canonicalTarget = projectedCanonicalPath(target);
    if (escapes(target, root) || escapes(canonicalTarget, canonicalRoot)) {
        throw policyError(`${GIT_CREDENTIALS_DIR_VAR} must name a directory inside the workspace '${root}'`);
    }
    const controllerRoot = path.join(root, '.ploinky');
    if (isPathWithin(target, controllerRoot)
        || isPathWithin(canonicalTarget, projectedCanonicalPath(controllerRoot))
        || hasHostStateComponent(path.relative(root, target))
        || hasHostStateComponent(path.relative(canonicalRoot, canonicalTarget))) {
        throw policyError(`${GIT_CREDENTIALS_DIR_VAR} must not point into the controller root or the Box host state`);
    }
    // Other agents' private data directories are never a valid target.
    const defaultDir = path.join(root, DEFAULT_RELATIVE_DIR);
    const privateRoot = path.join(root, '.data', '.private');
    if (target !== defaultDir && (isPathWithin(target, privateRoot)
        || isPathWithin(canonicalTarget, projectedCanonicalPath(privateRoot)))) {
        throw policyError(`${GIT_CREDENTIALS_DIR_VAR} must not point into another private data directory`);
    }
    return target;
}

export function resolveGitCredentialsFile(workspaceRoot, options = {}) {
    return path.join(resolveGitCredentialsDir(workspaceRoot, options), GIT_CREDENTIALS_FILE);
}

/** Create the credentials directory (0700) and return it. */
export function ensureGitCredentialsDir(workspaceRoot, options = {}) {
    const root = workspaceRoot ? path.resolve(String(workspaceRoot)) : defaultWorkspaceRoot();
    const dir = resolveGitCredentialsDir(root, options);
    const privateRoot = path.join(root, '.data', '.private');
    if (isPathWithin(dir, privateRoot)) {
        ensureAgentDataDirectory(privateRoot, { workspaceRoot: root, mode: 0o700 });
    } else {
        fs.mkdirSync(path.dirname(dir), { recursive: true });
    }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw policyError(`git credentials directory '${dir}' must be a real directory`);
    }
    fs.chmodSync(dir, 0o700);
    return dir;
}

/** The 32-byte credentials key, derived from the workspace master key. */
export function gitCredentialsKey() {
    return deriveSubkey(GIT_CREDENTIALS_KEY_PURPOSE, KEY_BYTES);
}

/** The credentials key as 64 lowercase hex characters, the form given to agents. */
export function gitCredentialsKeyHex() {
    return gitCredentialsKey().toString('hex');
}

function validCredentialText(value) {
    return typeof value === 'string' && value.length > 0 && !/[\0\r\n]/.test(value);
}

/** Encrypt a credentials file payload into the on-disk envelope (used by writers and tests). */
export function encryptGitCredentials(payload, key) {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(GIT_CREDENTIALS_ALGORITHM, key, iv);
    cipher.setAAD(AAD);
    const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
    return {
        schema: GIT_CREDENTIALS_SCHEMA,
        alg: GIT_CREDENTIALS_ALGORITHM,
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        data: data.toString('base64'),
    };
}

/**
 * Decrypt and validate an envelope. Returns `{ host, username, token }` or
 * null for any malformed, foreign or undecryptable input. Never throws.
 */
export function decryptGitCredentials(envelope, key) {
    try {
        if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return null;
        if (envelope.schema !== GIT_CREDENTIALS_SCHEMA || envelope.alg !== GIT_CREDENTIALS_ALGORITHM) return null;
        if (![envelope.iv, envelope.tag, envelope.data].every(value => typeof value === 'string')) return null;
        const iv = Buffer.from(envelope.iv, 'base64');
        const tag = Buffer.from(envelope.tag, 'base64');
        if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES || !Buffer.isBuffer(key) || key.length !== KEY_BYTES) return null;
        const decipher = crypto.createDecipheriv(GIT_CREDENTIALS_ALGORITHM, key, iv);
        decipher.setAAD(AAD);
        decipher.setAuthTag(tag);
        const plain = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
        const parsed = JSON.parse(plain.toString('utf8'));
        if (!parsed || typeof parsed !== 'object') return null;
        const { host, username, token } = parsed;
        if (host !== GIT_CREDENTIALS_HOST) return null;
        if (!validCredentialText(username) || username.includes(':') || !validCredentialText(token)) return null;
        return { host, username, token };
    } catch (_) {
        return null;
    }
}

/**
 * Read the workspace git credentials file. Returns `{ host, username,
 * token }` or null when the file is missing, unreadable, malformed or cannot
 * be decrypted. The key is derived only when a credentials file exists, so a
 * workspace without one never touches the master key. Never throws.
 */
export function readGitCredentials({ workspaceRoot, override, key } = {}) {
    let file;
    try {
        file = resolveGitCredentialsFile(workspaceRoot, { override });
    } catch (error) {
        debug(`credentials directory rejected: ${error?.code || 'error'}`);
        return null;
    }
    let raw;
    try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
            debug('credentials file is not a regular file of acceptable size; ignored');
            return null;
        }
        raw = fs.readFileSync(file, 'utf8');
    } catch (error) {
        if (error?.code !== 'ENOENT') debug(`credentials file unreadable (${error?.code || 'error'}); ignored`);
        return null;
    }
    let envelope;
    try {
        envelope = JSON.parse(raw);
    } catch (_) {
        debug('credentials file is not valid JSON; ignored');
        return null;
    }
    let fileKey = key;
    try {
        if (!fileKey) fileKey = gitCredentialsKey();
    } catch (error) {
        debug(`credentials key unavailable (${error?.code || 'error'}); ignored`);
        return null;
    }
    const credentials = decryptGitCredentials(envelope, fileKey);
    if (!credentials) debug('credentials file could not be decrypted or validated; ignored');
    return credentials;
}

/**
 * A copy of `env` that authenticates git to https://github.com with the
 * workspace credentials, appended after any GIT_CONFIG_* entries `env`
 * already carries. Without credentials the copy is unchanged. Pass
 * `credentials` to skip reading the credentials file (null disables injection).
 */
export function withGitCredentialEnv(env = process.env, options = {}) {
    const result = { ...env };
    const credentials = Object.prototype.hasOwnProperty.call(options, 'credentials')
        ? options.credentials
        : readGitCredentials(options);
    if (!credentials?.username || !credentials?.token) return result;
    const rawCount = Number.parseInt(result.GIT_CONFIG_COUNT || '0', 10);
    const base = Number.isFinite(rawCount) && rawCount >= 0 ? rawCount : 0;
    const basic = Buffer.from(`${credentials.username}:${credentials.token}`, 'utf8').toString('base64');
    result.GIT_CONFIG_COUNT = String(base + 1);
    result[`GIT_CONFIG_KEY_${base}`] = `http.https://${GIT_CREDENTIALS_HOST}/.extraheader`;
    result[`GIT_CONFIG_VALUE_${base}`] = `Authorization: Basic ${basic}`;
    return result;
}
