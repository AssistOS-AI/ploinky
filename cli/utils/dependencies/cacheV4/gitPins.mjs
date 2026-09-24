// Identity-bound Git pins for effective direct dependencies.
//
// A pin binds (source/registration binding, section, package name) to the
// normalized original spec identity and one full commit. Only the explicit
// update flow calls `discoverGitPins` (online, bounded, noninteractive
// `git ls-remote`). Lifecycle builds never query remotes: they read the pin
// state and install exact commits, or record what npm actually installed as
// `observed-at-install` provenance.
//
// Key stability: only `remote-verified` pins feed install contracts. An
// `observed-at-install` record is provenance only, so a second start without an
// intervening update reuses the first start's object instead of rebuilding it.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { cacheV4Error, canonicalDigest, canonicalJson, isFullGitSha } from './canonical.mjs';
import { lsRemoteQuery, parseGitDependencySpec, parseLsRemoteOutput, resolveRefFromLsRemote } from './gitSpec.mjs';

export const PIN_SCHEMA = 1;
export const PIN_STATE_FORMAT = 'ploinky-deps-pins';
export const PIN_SECTIONS = Object.freeze(['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']);
export const PIN_VERIFICATION = Object.freeze({ remote: 'remote-verified', observed: 'observed-at-install' });
const DEFAULT_DISCOVERY_DEADLINE_MS = 60_000;
const DEFAULT_QUERY_TIMEOUT_MS = 20_000;
const LS_REMOTE_MAX_BUFFER = 4 * 1024 * 1024;

export function normalizePinBinding(binding) {
    const scope = String(binding?.scope || '');
    if (scope === 'global') return { scope: 'global' };
    if (scope === 'registration') {
        const registration = String(binding.registration || '').trim();
        if (!registration) throw cacheV4Error('PLOINKY_DEPS_PIN_BINDING_INVALID', 'registration pin binding requires a registration id');
        return { scope, registration, packageSource: String(binding.packageSource || '') };
    }
    throw cacheV4Error('PLOINKY_DEPS_PIN_BINDING_INVALID', `unknown pin binding scope '${scope}'`);
}

export function pinIdFor(binding, section, name) {
    return canonicalDigest({ binding: normalizePinBinding(binding), section, name });
}

/**
 * Every effective direct Git declaration that reaches npm.
 * Transitive Git dependencies and nested overrides are not collected: they
 * are recorded by resolution provenance but never refreshed automatically.
 *
 * @returns {{ entries: Array<object>, unsupported: Array<object> }}
 */
export function collectGitInputs(manifest, binding) {
    const normalizedBinding = normalizePinBinding(binding);
    const entries = [];
    const unsupported = [];
    for (const section of PIN_SECTIONS) {
        for (const name of Object.keys(manifest?.[section] || {}).sort()) {
            const parsed = parseGitDependencySpec(manifest[section][name]);
            if (!parsed) continue;
            const pinId = pinIdFor(normalizedBinding, section, name);
            if (!parsed.supported) {
                unsupported.push({ pinId, binding: normalizedBinding, section, name, original: parsed.original, reason: parsed.reason });
                continue;
            }
            entries.push({ pinId, binding: normalizedBinding, section, name, spec: parsed });
        }
    }
    return { entries, unsupported };
}

function specRecord(parsed) {
    return { original: parsed.original, source: parsed.source, fetchUrl: parsed.fetchUrl, ref: { ...parsed.ref }, identity: parsed.identity };
}

export function buildPin(entry, { commit, verification, resolvedRef = null, peeled = false, recordedAt = new Date().toISOString() }) {
    if (!isFullGitSha(commit)) throw cacheV4Error('PLOINKY_DEPS_PIN_INVALID', 'a pin commit must be a full 40-character SHA');
    if (!Object.values(PIN_VERIFICATION).includes(verification)) {
        throw cacheV4Error('PLOINKY_DEPS_PIN_INVALID', `unknown pin verification '${verification}'`);
    }
    return {
        schema: PIN_SCHEMA,
        pinId: entry.pinId,
        binding: entry.binding,
        section: entry.section,
        name: entry.name,
        spec: specRecord(entry.spec),
        commit,
        verification,
        resolvedRef,
        peeled: Boolean(peeled),
        recordedAt,
    };
}

function pinMatchesEntry(pin, entry) {
    return pin?.schema === PIN_SCHEMA
        && pin.pinId === entry.pinId
        && pin.spec?.identity === entry.spec.identity
        && isFullGitSha(pin.commit);
}

/**
 * Commits the install contract must use: remote-verified pins whose original
 * spec identity is unchanged. Full-SHA specs need no pin.
 *
 * @returns {Array<{pinId, section, name, source, commit, verification}>}
 */
export function desiredPinsFor(pins, entries) {
    const desired = [];
    for (const entry of entries) {
        if (entry.spec.ref.kind === 'sha') continue;
        const pin = pins?.[entry.pinId];
        if (!pinMatchesEntry(pin, entry) || pin.verification !== PIN_VERIFICATION.remote) continue;
        desired.push({
            pinId: entry.pinId,
            section: entry.section,
            name: entry.name,
            source: entry.spec.source,
            specIdentity: entry.spec.identity,
            commit: pin.commit,
            verification: pin.verification,
        });
    }
    return desired;
}

export function gitLookupEnv(env = process.env) {
    const rawCount = Number.parseInt(env.GIT_CONFIG_COUNT || '0', 10);
    const base = Number.isFinite(rawCount) && rawCount >= 0 ? rawCount : 0;
    return {
        ...env,
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'never',
        GIT_SSH_COMMAND: env.GIT_SSH_COMMAND || 'ssh -oBatchMode=yes',
        GIT_CONFIG_COUNT: String(base + 2),
        [`GIT_CONFIG_KEY_${base}`]: 'url.https://github.com/.insteadOf',
        [`GIT_CONFIG_VALUE_${base}`]: 'ssh://git@github.com/',
        [`GIT_CONFIG_KEY_${base + 1}`]: 'url.https://github.com/.insteadOf',
        [`GIT_CONFIG_VALUE_${base + 1}`]: 'git@github.com:',
    };
}

export function defaultRunGit(argv, { env, timeoutMs }) {
    const result = spawnSync('git', argv, {
        env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: timeoutMs,
        maxBuffer: LS_REMOTE_MAX_BUFFER,
    });
    return {
        status: result.status,
        stdout: result.stdout || '',
        stderr: String(result.stderr || '').slice(-2000),
        error: result.error ? (result.error.code || result.error.message) : null,
    };
}

/**
 * Update-only moving-ref discovery. Structured argv, per-query timeout, overall
 * deadline, GIT_TERMINAL_PROMPT=0 and one query per identical (URL, patterns).
 *
 * @param {Array<object>} entries - from collectGitInputs (may span bindings)
 * @param {{ unsupported?: Array<object>, runGit?: Function, deadlineMs?: number,
 *   queryTimeoutMs?: number, now?: Function, env?: object }} [options]
 * @returns {{ results: Array<{pinId: string, status: string, commit?: string, resolvedRef?: string,
 *   peeled?: boolean, reason?: string}>, queriesRun: number }}
 */
export function discoverGitPins(entries, {
    unsupported = [],
    runGit = defaultRunGit,
    deadlineMs = DEFAULT_DISCOVERY_DEADLINE_MS,
    queryTimeoutMs = DEFAULT_QUERY_TIMEOUT_MS,
    now = Date.now,
    env = process.env,
} = {}) {
    const deadline = now() + Math.max(0, Number(deadlineMs) || 0);
    const cache = new Map();
    const results = unsupported.map((item) => ({ pinId: item.pinId, status: 'unsupported', reason: item.reason }));
    let queriesRun = 0;
    const lookupEnv = gitLookupEnv(env);
    for (const entry of entries) {
        if (entry.spec.ref.kind === 'sha') {
            results.push({ pinId: entry.pinId, status: 'fixed', commit: entry.spec.ref.sha });
            continue;
        }
        const query = lsRemoteQuery(entry.spec);
        let outcome = cache.get(query.key);
        if (!outcome) {
            const remaining = deadline - now();
            if (remaining <= 0) {
                outcome = { error: 'deadline-exceeded' };
            } else {
                queriesRun += 1;
                const run = runGit(['ls-remote', '--', query.fetchUrl, ...query.patterns], {
                    env: lookupEnv,
                    timeoutMs: Math.min(queryTimeoutMs, remaining),
                });
                if (run.error || run.status !== 0) {
                    outcome = { error: run.error === 'ETIMEDOUT' ? 'timeout' : `ls-remote failed (${run.error || `exit ${run.status}`})` };
                } else {
                    try { outcome = { refs: parseLsRemoteOutput(run.stdout) }; }
                    catch (error) { outcome = { error: error.message }; }
                }
            }
            cache.set(query.key, outcome);
        }
        if (outcome.error) {
            results.push({ pinId: entry.pinId, status: outcome.error === 'deadline-exceeded' ? 'deadline-exceeded' : 'failed', reason: outcome.error });
            continue;
        }
        const resolved = resolveRefFromLsRemote(entry.spec, outcome.refs);
        if (resolved.status === 'resolved') {
            results.push({ pinId: entry.pinId, status: 'resolved', commit: resolved.commit, resolvedRef: resolved.resolvedRef, peeled: Boolean(resolved.peeled) });
        } else if (resolved.status === 'ambiguous') {
            results.push({ pinId: entry.pinId, status: 'ambiguous', reason: `'${entry.spec.ref.name}' names both ${resolved.candidates.join(' and ')}; use an explicit refs/heads/ or refs/tags/ ref` });
        } else {
            results.push({ pinId: entry.pinId, status: 'not-found', reason: 'ref not found on the remote' });
        }
    }
    return { results, queriesRun };
}

/**
 * Merge discovery results into the pin map for the bindings discovered.
 * A resolved ref becomes a remote-verified pin. A failed, ambiguous or missing
 * lookup keeps an existing pin only when its original spec identity is
 * unchanged. Unsupported and full-SHA specs keep no pin. Pins of the discovered
 * bindings that are no longer declared are removed; other bindings are untouched.
 */
export function mergeDiscoveredPins(currentPins, entries, results, { bindings, now = () => new Date().toISOString() } = {}) {
    const pins = { ...(currentPins || {}) };
    const changes = [];
    const byId = new Map(results.map((result) => [result.pinId, result]));
    const declared = new Set(entries.map((entry) => entry.pinId));
    for (const result of results) if (result.status === 'unsupported') declared.add(result.pinId);
    const scopes = new Set((bindings || entries.map((entry) => entry.binding)).map((binding) => canonicalJson(normalizePinBinding(binding))));
    for (const [pinId, pin] of Object.entries(pins)) {
        if (!declared.has(pinId) && scopes.has(canonicalJson(pin?.binding || {}))) {
            delete pins[pinId];
            changes.push({ pinId, action: 'removed-undeclared' });
        }
    }
    for (const result of results) {
        if (result.status === 'unsupported' && pins[result.pinId]) {
            delete pins[result.pinId];
            changes.push({ pinId: result.pinId, action: 'dropped-unsupported' });
        }
    }
    for (const entry of entries) {
        const result = byId.get(entry.pinId);
        const existing = pins[entry.pinId];
        if (!result) continue;
        if (result.status === 'fixed') {
            if (existing) { delete pins[entry.pinId]; changes.push({ pinId: entry.pinId, action: 'dropped-exact-spec' }); }
            continue;
        }
        if (result.status === 'resolved') {
            const unchanged = pinMatchesEntry(existing, entry) && existing.commit === result.commit
                && existing.verification === PIN_VERIFICATION.remote;
            if (!unchanged) {
                pins[entry.pinId] = buildPin(entry, {
                    commit: result.commit,
                    verification: PIN_VERIFICATION.remote,
                    resolvedRef: result.resolvedRef,
                    peeled: result.peeled,
                    recordedAt: now(),
                });
            }
            changes.push({ pinId: entry.pinId, action: unchanged ? 'unchanged' : 'pinned', commit: result.commit, previous: existing?.commit || null });
            continue;
        }
        if (existing && pinMatchesEntry(existing, entry)) {
            changes.push({ pinId: entry.pinId, action: 'retained-after-failure', status: result.status, reason: result.reason, commit: existing.commit });
        } else {
            if (existing) delete pins[entry.pinId];
            changes.push({ pinId: entry.pinId, action: existing ? 'dropped-spec-changed' : 'unpinned', status: result.status, reason: result.reason });
        }
    }
    return { pins, changes };
}

/**
 * Record what an install actually resolved for entries without a matching
 * remote-verified pin. Missing metadata is never stamped as verified.
 */
export function recordObservedPins(currentPins, entries, observed, { now = () => new Date().toISOString() } = {}) {
    const pins = { ...(currentPins || {}) };
    const byId = new Map((observed || []).map((item) => [item.pinId, item]));
    for (const entry of entries) {
        if (entry.spec.ref.kind === 'sha') continue;
        const existing = pins[entry.pinId];
        if (pinMatchesEntry(existing, entry) && existing.verification === PIN_VERIFICATION.remote) continue;
        const item = byId.get(entry.pinId);
        if (!item || !isFullGitSha(item.commit) || item.source !== entry.spec.source) continue;
        pins[entry.pinId] = buildPin(entry, { commit: item.commit, verification: PIN_VERIFICATION.observed, recordedAt: now() });
    }
    return pins;
}

export function readPinState(filePath, { fsApi = fs } = {}) {
    let raw;
    try { raw = fsApi.readFileSync(filePath, 'utf8'); }
    catch (error) {
        if (error?.code === 'ENOENT') return { revision: 0, pins: {} };
        throw error;
    }
    let parsed;
    try { parsed = JSON.parse(raw); } catch {
        throw cacheV4Error('PLOINKY_DEPS_PIN_STATE_CORRUPT', `pin state at ${filePath} is not valid JSON`);
    }
    if (parsed?.format !== PIN_STATE_FORMAT || parsed.schema !== PIN_SCHEMA
        || !Number.isSafeInteger(parsed.revision) || !parsed.pins || typeof parsed.pins !== 'object') {
        throw cacheV4Error('PLOINKY_DEPS_PIN_STATE_CORRUPT', `pin state at ${filePath} has an unknown format`);
    }
    return { revision: parsed.revision, pins: parsed.pins };
}

export function writeFileAtomic(filePath, content, { fsApi = fs, mode = 0o644 } = {}) {
    fsApi.mkdirSync(path.dirname(filePath), { recursive: true });
    const staging = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let fd = null;
    try {
        fd = fsApi.openSync(staging, 'wx', mode);
        fsApi.writeSync(fd, content);
        fsApi.fsyncSync(fd);
        fsApi.closeSync(fd);
        fd = null;
        fsApi.renameSync(staging, filePath);
        fsyncDirectory(path.dirname(filePath), fsApi);
    } finally {
        if (fd !== null) { try { fsApi.closeSync(fd); } catch { /* already closed */ } }
        try { fsApi.rmSync(staging, { force: true }); } catch { /* renamed */ }
    }
}

export function fsyncDirectory(directory, fsApi = fs) {
    let fd = null;
    try {
        fd = fsApi.openSync(directory, 'r');
        fsApi.fsyncSync(fd);
    } catch { /* directory fsync is unsupported on some filesystems */ }
    finally { if (fd !== null) { try { fsApi.closeSync(fd); } catch { /* ignore */ } } }
}

/** Compare-and-replace the pin state. Callers hold the workspace mutation lease. */
export function commitPinState(filePath, { expectedRevision, pins }, { fsApi = fs } = {}) {
    const current = readPinState(filePath, { fsApi });
    if (current.revision !== expectedRevision) {
        throw cacheV4Error('PLOINKY_DEPS_PIN_CONFLICT',
            `pin state changed concurrently (revision ${current.revision} != expected ${expectedRevision})`);
    }
    for (const [pinId, pin] of Object.entries(pins || {})) {
        if (pin?.pinId !== pinId || !isFullGitSha(pin.commit)) {
            throw cacheV4Error('PLOINKY_DEPS_PIN_INVALID', `refusing to store malformed pin ${pinId}`);
        }
    }
    const next = { format: PIN_STATE_FORMAT, schema: PIN_SCHEMA, revision: expectedRevision + 1, pins: pins || {} };
    writeFileAtomic(filePath, `${JSON.stringify(next, null, 2)}\n`, { fsApi });
    return { revision: next.revision, pins: next.pins };
}
