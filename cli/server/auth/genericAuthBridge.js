import fs from 'fs';
import path from 'path';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'url';

import { createSessionStore } from './sessionStore.js';
import { randomId } from './utils.js';
import { resolveVarValue } from '../../utils/security/secretVars.js';
import { getConfigSnapshot } from '../../utils/workspace.js';
import { resolveAgentManifestLocation } from '../../utils/agentRegistry.js';
import { findAgent } from '../../utils/utils.js';
import { emitAuthenticationSessionInvalidated } from './sessionEvents.js';
import { createProviderConfigReader, tryLoadActiveSnapshot } from './providerConfigValues.js';
import { createProviderConfigInputs } from './providerConfigInputs.js';
import { validateCanonicalLoginOrigin } from './canonicalLoginOrigin.mjs';
import { ssoProviderUnavailableError } from './ssoAdmission.js';

/**
 * genericAuthBridge.js
 *
 * Provider-neutral SSO bridge. Core:
 *   - keeps cookie issuance, workspace session store, dev-only web-token
 *     auth, local auth fallback, and browser pending-auth state;
 *   - delegates OIDC-specific work (auth URL, callback exchange, JWT verify,
 *     refresh, logout, claim extraction) to the configured SSO provider agent.
 *
 * The bridge never parses provider-specific claim or URL shapes. The provider
 * returns a `providerSession` blob and a normalized `user` — core treats both
 * as opaque.
 */

// Upper bound for one provider validation dispatch. It matches the Router's
// existing 5 s bound for control-plane agent requests (MCP request timeout,
// agent redirect readiness) and exceeds the Router's fast 503 replies while a
// provider agent restarts, so an outage is reported instead of awaited.
export const SSO_VALIDATION_DEADLINE_MS = 5000;

const DENIED = Object.freeze({ session: null, unavailable: false });
const UNAVAILABLE = Object.freeze({ session: null, unavailable: true });

function __dirname() {
    return path.dirname(fileURLToPath(import.meta.url));
}

// Explicit provider values: workspace secrets, then the process environment
// (read live on every call), then the caller's fallback. `inputs` supplies the
// current decrypted secrets through its validated memo.
function createConfigValueReader(inputs) {
    return (names, fallback) => readConfigValue(names, fallback, inputs);
}

function readConfigValue(names, fallback, inputs) {
    const candidates = Array.isArray(names) ? names : [names].filter(Boolean);
    let secrets;
    for (const name of candidates) {
        if (!name) continue;
        if (inputs && secrets === undefined) secrets = inputs.readSecrets();
        const secret = inputs ? resolveVarValue(name, secrets) : resolveVarValue(name);
        if (secret && String(secret).trim()) return String(secret).trim();
    }
    for (const name of candidates) {
        if (!name) continue;
        const env = process.env[name];
        if (env && String(env).trim()) return String(env).trim();
    }
    if (fallback && String(fallback).trim()) return String(fallback).trim();
    return '';
}

function resolveProviderAgentPath(providerAgentRef, snapshot) {
    // One provider manifest, under the active route's hostPath when the
    // generation routes the provider; no installed-repository scan. Only its
    // location is needed here; the config reader parses it.
    const located = resolveAgentManifestLocation(providerAgentRef, { snapshot });
    if (located?.manifestPath) {
        return path.dirname(located.manifestPath);
    }
    try {
        const resolved = findAgent(providerAgentRef);
        if (resolved?.manifestPath) return path.dirname(resolved.manifestPath);
    } catch (_) {}
    return null;
}

// `modules` maps an entry URL to its namespace. import() never re-evaluates a
// URL it has loaded, so this returns the namespace import() would return,
// while the entry file's existence is still checked on every call.
async function loadProviderModule(providerAgentRef, { snapshot, modules } = {}) {
    const agentDir = resolveProviderAgentPath(providerAgentRef, snapshot);
    if (!agentDir) {
        throw new Error(`genericAuthBridge: could not locate provider agent '${providerAgentRef}'`);
    }
    const entryPath = path.join(agentDir, 'runtime', 'index.mjs');
    if (!fs.existsSync(entryPath)) {
        throw new Error(`genericAuthBridge: provider '${providerAgentRef}' missing runtime/index.mjs at ${entryPath}`);
    }
    const moduleUrl = pathToFileURL(entryPath).href;
    const mod = modules?.get(moduleUrl) || await import(moduleUrl);
    if (typeof mod.createProvider !== 'function') {
        throw new Error(`genericAuthBridge: provider '${providerAgentRef}' does not export createProvider()`);
    }
    modules?.set(moduleUrl, mod);
    return mod;
}

function readSsoConfig() {
    let workspaceConfig;
    try { workspaceConfig = getConfigSnapshot(); } catch (_) { workspaceConfig = {}; }
    return workspaceConfig?.sso && typeof workspaceConfig.sso === 'object' ? workspaceConfig.sso : {};
}

function resolveConfiguredSsoProvider() {
    const sso = readSsoConfig();
    if (sso.enabled !== true) return '';
    return typeof sso.providerAgent === 'string' && sso.providerAgent.trim()
        ? sso.providerAgent.trim()
        : '';
}

// Resolves the provider configuration from the current workspace inputs. The
// provider's own resolveProviderConfig() runs on every call (it may read
// anything, including the process environment); only file inputs are memoized,
// by `inputs`, and each is revalidated on every read.
async function resolveProviderConfig(mod, { inputs: memo, snapshot } = {}) {
    // One scope per resolution: a single master-seed resolution for its reads.
    const inputs = memo ? memo.scope() : null;
    const workspaceConfig = (() => {
        // A private copy: providers may mutate what they receive.
        try { return structuredClone(getConfigSnapshot()); } catch (_) { return {}; }
    })();
    const sso = workspaceConfig?.sso && typeof workspaceConfig.sso === 'object' ? workspaceConfig.sso : {};
    if (sso.enabled !== true) return null;

    const providerConfig = sso.providerConfig && typeof sso.providerConfig === 'object'
        ? { ...sso.providerConfig }
        : {};

    if (typeof mod.resolveProviderConfig === 'function') {
        return await mod.resolveProviderConfig({
            workspaceConfig,
            providerConfig,
            readValue: createProviderConfigReader(sso.providerAgent, createConfigValueReader(inputs), {
                snapshot: snapshot === undefined ? tryLoadActiveSnapshot() : snapshot,
                inputs,
            }),
        });
    }

    return Object.keys(providerConfig).length ? providerConfig : null;
}

export function createGenericAuthBridge(options = {}) {
    const sessionStore = createSessionStore(options.sessionOptions);
    const clock = typeof options.now === 'function' ? options.now : () => Date.now();
    const validationLanes = new Map();
    let validationEpoch = 0;
    const validationDeadlineMs = Number.isSafeInteger(options.validationDeadlineMs) && options.validationDeadlineMs > 0
        ? options.validationDeadlineMs
        : SSO_VALIDATION_DEADLINE_MS;
    // Pending browser-auth state stays in core, keyed by the random `state`
    // the browser will present on the callback. Per the plan, core holds:
    //   - provider agent name
    //   - opaque provider state
    //   - returnTo
    //   - created-at / expiry
    const pendingAuth = new Map();
    const PENDING_TTL_MS = 5 * 60 * 1000;

    let providerInstance = null;
    let providerFingerprint = null;
    let configFingerprint = null;
    // Validated memo of configuration inputs (files and key material), never
    // of provider answers. Cleared with the provider on reloadConfig().
    const configInputs = options.configInputs || createProviderConfigInputs();
    const providerModules = new Map();

    function fingerprintFor(config, providerAgent) {
        return JSON.stringify({
            provider: providerAgent || null,
            config: config || null,
        });
    }

    async function ensureProvider() {
        const providerAgent = resolveConfiguredSsoProvider();
        if (!providerAgent) throw new Error('SSO is not configured (no provider agent configured)');
        // One active-generation read serves both the module and the config reader.
        const snapshot = tryLoadActiveSnapshot();
        const mod = await loadProviderModule(providerAgent, { snapshot, modules: providerModules });
        const config = await resolveProviderConfig(mod, { inputs: configInputs, snapshot });
        if (!config) throw new Error('SSO is not configured (incomplete config values)');
        const nextFingerprint = fingerprintFor(config, providerAgent);
        if (providerInstance && providerFingerprint === providerAgent && configFingerprint === nextFingerprint) {
            return { provider: providerInstance, providerAgent, config };
        }
        const provider = mod.createProvider({
            getConfig: async () => resolveProviderConfig(mod, { inputs: configInputs })
        });
        providerInstance = provider;
        providerFingerprint = providerAgent;
        configFingerprint = nextFingerprint;
        return { provider, providerAgent, config };
    }

    function cleanupPending() {
        const now = clock();
        for (const [state, entry] of pendingAuth.entries()) {
            if (now >= entry.expiresAt) {
                pendingAuth.delete(state);
            }
        }
    }

    function resolveRedirectUri(baseUrl, config) {
        if (config?.redirectUri) return config.redirectUri;
        if (!baseUrl) throw new Error('Redirect URI missing');
        return `${baseUrl.replace(/\/$/, '')}/auth/callback`;
    }

    function resolvePostLogoutUri(baseUrl, override, config) {
        const overrideValue = typeof override === 'string' ? override.trim() : '';
        if (overrideValue) {
            if (/^https?:\/\//i.test(overrideValue)) return overrideValue;
            if (baseUrl && overrideValue.startsWith('/')) {
                return new URL(overrideValue, `${baseUrl.replace(/\/$/, '')}/`).toString();
            }
            return overrideValue;
        }
        if (config?.postLogoutRedirectUri) return config.postLogoutRedirectUri;
        if (!baseUrl) return undefined;
        return `${baseUrl.replace(/\/$/, '')}/`;
    }

    async function beginLogin({ baseUrl, returnTo = '/', prompt } = {}) {
        cleanupPending();
        const epoch = validationEpoch;
        const { provider, config, providerAgent } = await ensureProvider();
        const redirectUri = resolveRedirectUri(baseUrl, config);
        // `returnTo` is informational for the provider (for example a Start again
        // link back to /auth/login); the Router alone decides the final redirect.
        const result = await provider.sso_begin_login({
            redirectUri, prompt, returnTo: returnTo || '/', supportsCanonicalLoginOrigin: true,
        });
        if (epoch !== validationEpoch) throw new Error('Authorization configuration changed');
        if (Object.hasOwn(result, 'canonicalLoginOrigin')) {
            if (Object.hasOwn(result, 'authorizationUrl') || Object.hasOwn(result, 'providerState')) {
                throw new Error('Invalid canonical login origin');
            }
            const canonicalLoginOrigin = validateCanonicalLoginOrigin({
                canonicalLoginOrigin: result.canonicalLoginOrigin, baseUrl, redirectUri,
            });
            return { restartLogin: true, canonicalLoginOrigin };
        }
        const { authorizationUrl, providerState, expiresAt } = result;
        const coreState = randomId(16);
        const browserBinding = randomId(32);
        const providerExpiresAt = typeof expiresAt === 'string' ? Date.parse(expiresAt) : expiresAt;
        const pendingExpiresAt = Math.min(
            clock() + PENDING_TTL_MS,
            Number.isFinite(providerExpiresAt) ? providerExpiresAt : Infinity,
        );
        pendingAuth.set(coreState, {
            providerAgent,
            configFingerprint: fingerprintFor(config, providerAgent),
            epoch,
            browserBinding,
            providerState,
            redirectUri,
            returnTo: returnTo || '/',
            expiresAt: pendingExpiresAt,
        });
        // Replace the `state` query param in the authorization URL with our
        // core-owned `coreState`. That way, the browser always presents the
        // core key on the callback, and the provider sees its own `state`
        // only after we consume the pending entry.
        const url = new URL(authorizationUrl);
        url.searchParams.set('state', coreState);
        return {
            redirectUrl: url.toString(),
            state: coreState,
            browserBinding,
            expiresAt: pendingExpiresAt,
        };
    }

    async function handleCallback({ code, state, browserBinding, baseUrl, rawQuery }) {
        cleanupPending();
        const pending = pendingAuth.get(state);
        if (!pending) throw new Error('Invalid or expired authorization state');
        // The proof travels only in a host-only HttpOnly cookie, never in the
        // provider URL. A copied callback must not consume another browser's login.
        if (typeof browserBinding !== 'string'
            || Buffer.byteLength(browserBinding) !== Buffer.byteLength(pending.browserBinding)
            || !timingSafeEqual(Buffer.from(browserBinding), Buffer.from(pending.browserBinding))) {
            throw new Error('Invalid authorization browser binding');
        }
        pendingAuth.delete(state);
        const { provider, config, providerAgent } = await ensureProvider();
        if (pending.epoch !== validationEpoch
            || pending.configFingerprint !== fingerprintFor(config, providerAgent)) {
            throw new Error('Authorization configuration changed');
        }
        const query = { code };
        if (rawQuery && typeof rawQuery === 'object') {
            for (const [k, v] of Object.entries(rawQuery)) {
                if (k === 'state') continue;
                query[k] = v;
            }
        }
        const { user, providerSession } = await provider.sso_handle_callback({
            redirectUri: pending.redirectUri,
            query,
            providerState: pending.providerState
        });
        if (pending.epoch !== validationEpoch) throw new Error('Authorization configuration changed');
        const now = Date.now();
        const expiresAt = providerSession?.expiresAt || (now + sessionStore.sessionTtlMs);
        const refreshExpiresAt = providerSession?.refreshExpiresAt || null;
        const { id: sessionId } = sessionStore.createSession({
            user,
            tokens: providerSession?.tokens || {},
            providerSession,
            expiresAt,
            refreshExpiresAt
        });
        const redirectTo = pending.returnTo || '/';
        const postLogoutRedirectUri = resolvePostLogoutUri(baseUrl, null, config);
        return {
            sessionId,
            user,
            redirectTo,
            postLogoutRedirectUri,
            tokens: {
                accessToken: providerSession?.tokens?.accessToken || null,
                expiresAt
            }
        };
    }

    function getSession(sessionId) {
        return sessionStore.getSession(sessionId);
    }

    async function refreshSession(sessionId) {
        const epoch = validationEpoch;
        const original = sessionStore.getSession(sessionId);
        const session = await validateSession(sessionId);
        if (!session || epoch !== validationEpoch || sessionStore.getSession(sessionId) !== original) {
            throw new Error('Session validation failed');
        }
        const typeKey = 'token' + 'Type';
        return {
            accessToken: session.tokens?.accessToken || null,
            expiresAt: session.expiresAt,
            scope: session.tokens?.scope || null,
            [typeKey]: session.tokens?.[typeKey] || null,
            user: session.user,
        };
    }

    // One provider attempt. `isAbandoned` turns true once the deadline settled
    // the cohort; every later continuation then neither publishes nor deletes.
    async function attemptRemoteValidation(sessionId, session, epoch, { signal, isAbandoned }) {
        const current = () => !isAbandoned() && epoch === validationEpoch && sessionStore.getSession(sessionId) === session;
        const refuse = () => {
            if (!current()) return DENIED;
            sessionStore.deleteSession(sessionId);
            cancelValidation(sessionId);
            emitAuthenticationSessionInvalidated({ mode: 'sso', sessionId, reason: 'validation_failed' });
            return DENIED;
        };
        let context;
        try {
            context = await ensureProvider();
        } catch (_) {
            // Provider resolution or configuration read failed: no decision.
            return UNAVAILABLE;
        }
        if (!current()) return DENIED;
        let outcome;
        let provider;
        let fingerprint;
        let userId;
        try {
            provider = context.provider;
            fingerprint = fingerprintFor(context.config, context.providerAgent);
            userId = session.user?.id;
            const operation = typeof provider.sso_refresh_session === 'function'
                ? provider.sso_refresh_session.bind(provider)
                : provider.sso_validate_session?.bind(provider);
            if (!operation) throw new Error('provider has no response-free session validation operation');
            outcome = await operation({
                providerSession: structuredClone(session.providerSession || { tokens: session.tokens }),
                signal,
            });
        } catch (error) {
            if (!current()) return DENIED;
            return error?.providerUnavailable === true ? UNAVAILABLE : refuse();
        }
        if (!current()) return DENIED;
        let latest;
        try {
            latest = await ensureProvider();
        } catch (_) {
            return UNAVAILABLE;
        }
        if (!current()) return DENIED;
        // The configuration changed while the provider answered: the answer
        // belongs to the old configuration, but the session itself was not refused.
        if (latest.provider !== provider
            || fingerprintFor(latest.config, latest.providerAgent) !== fingerprint) return UNAVAILABLE;
        try {
            if (typeof userId !== 'string' || !userId || outcome?.user?.id !== userId
                || !outcome.providerSession || typeof outcome.providerSession !== 'object'
                || Array.isArray(outcome.providerSession)) {
                throw new Error('invalid provider session outcome');
            }
            const { user, providerSession } = structuredClone(outcome);
            const tokens = providerSession.tokens || {};
            if (typeof tokens !== 'object' || Array.isArray(tokens)) throw new Error('invalid provider tokens');
            const updated = sessionStore.updateSession(sessionId, {
                user,
                providerSession,
                tokens,
                expiresAt: providerSession?.expiresAt || session.expiresAt,
                refreshExpiresAt: providerSession?.refreshExpiresAt ?? session.refreshExpiresAt,
            });
            if (!updated) return DENIED;
            // The general store merges tokens; an admission replaces the entire
            // provider projection so removed metadata cannot survive refresh.
            updated.tokens = tokens;
            return Object.freeze({ session: structuredClone(updated), unavailable: false });
        } catch (_) {
            return refuse();
        }
    }

    // Bounds one provider dispatch. On expiry the cohort is denied without
    // deleting the session, the provider signal is aborted, and the lane moves
    // on so later callers dispatch a fresh operation.
    async function performRemoteValidation(sessionId, session, epoch, lane) {
        const controller = new AbortController();
        let abandoned = false;
        let timer = null;
        const deadline = new Promise((resolve) => {
            timer = setTimeout(() => {
                abandoned = true;
                resolve(UNAVAILABLE);
                try { controller.abort(new Error('SSO provider validation deadline exceeded')); } catch (_) { }
            }, validationDeadlineMs);
            timer.unref?.();
        });
        lane.abort = () => {
            try { controller.abort(new Error('SSO validation cancelled')); } catch (_) { }
        };
        try {
            return await Promise.race([
                attemptRemoteValidation(sessionId, session, epoch, {
                    signal: controller.signal,
                    isAbandoned: () => abandoned,
                }),
                deadline,
            ]);
        } finally {
            abandoned = true;
            clearTimeout(timer);
            lane.abort = null;
        }
    }

    function cancelValidation(sessionId) {
        const lane = validationLanes.get(sessionId);
        if (!lane) return;
        for (const caller of [...lane.active, ...lane.queued]) caller.resolve(DENIED);
        lane.queued = [];
        // Release a provider call nobody is waiting for; the deadline still
        // bounds providers that ignore the signal.
        lane.abort?.();
    }

    async function drainValidationLane(sessionId, lane) {
        try {
            while (lane.queued.length) {
                // Close the cohort before dispatch. Later admissions wait for a
                // new provider operation, serialized to preserve token rotation.
                const cohort = lane.queued.splice(0);
                lane.active = cohort;
                const { session, epoch } = cohort[0];
                const result = epoch === validationEpoch && sessionStore.getSession(sessionId) === session
                    ? await performRemoteValidation(sessionId, session, epoch, lane)
                    : DENIED;
                for (const caller of cohort) caller.resolve(result);
                lane.active = [];
            }
        } finally {
            for (const caller of [...lane.active, ...lane.queued]) caller.resolve(DENIED);
            if (validationLanes.get(sessionId) === lane) validationLanes.delete(sessionId);
        }
    }

    async function admitSession(sessionId) {
        const session = sessionStore.getSession(sessionId);
        if (!session) return DENIED;
        const epoch = validationEpoch;
        let lane = validationLanes.get(sessionId);
        if (!lane) {
            lane = { queued: [], active: [], abort: null };
            validationLanes.set(sessionId, lane);
            queueMicrotask(() => { void drainValidationLane(sessionId, lane); });
        }
        const result = await new Promise(resolve => lane.queued.push({ session, epoch, resolve }));
        // A deleted or replaced record is a refusal; a configuration change
        // while the session record survives is retryable.
        if (sessionStore.getSession(sessionId) !== session) return DENIED;
        if (epoch !== validationEpoch) return UNAVAILABLE;
        return result;
    }

    async function validateSession(sessionId, { reportUnavailable = false } = {}) {
        const outcome = await admitSession(sessionId);
        if (outcome.session) return outcome.session;
        if (reportUnavailable === true && outcome.unavailable) throw ssoProviderUnavailableError();
        return null;
    }

    // Captures the live record and epoch at the moment of a completed
    // admission. Logout, revocation, refusal or a configuration reload turns it
    // false; it never extends authority beyond the record the bridge still holds.
    function admissionFence(sessionId) {
        const epoch = validationEpoch;
        const record = sessionStore.getSession(sessionId);
        if (!record) return () => false;
        return () => epoch === validationEpoch && sessionStore.getSession(sessionId) === record;
    }

    async function logout(sessionId, { baseUrl, postLogoutRedirectUri } = {}) {
        const session = sessionStore.getSession(sessionId);
        if (session) {
            sessionStore.deleteSession(sessionId);
            cancelValidation(sessionId);
            emitAuthenticationSessionInvalidated({ mode: 'sso', sessionId, reason: 'logout' });
        }
        let redirect;
        try {
            const { provider, config } = await ensureProvider();
            const resolvedPostLogoutUri = resolvePostLogoutUri(baseUrl, postLogoutRedirectUri, config);
            const providerSession = session?.providerSession || (session ? { tokens: session.tokens } : null);
            if (providerSession) {
                const result = await provider.sso_logout({ providerSession, postLogoutRedirectUri: resolvedPostLogoutUri });
                redirect = result?.redirectUrl || resolvedPostLogoutUri;
            } else {
                redirect = resolvedPostLogoutUri;
            }
        } catch (err) {
            redirect = postLogoutRedirectUri;
        }
        return { redirect };
    }

    function revokeSession(sessionId) {
        sessionStore.deleteSession(sessionId);
        cancelValidation(sessionId);
        emitAuthenticationSessionInvalidated({ mode: 'sso', sessionId, reason: 'revoked' });
    }

    function isConfigured() {
        return Boolean(resolveConfiguredSsoProvider());
    }

    function getSessionCookieMaxAge() {
        return Math.floor(sessionStore.sessionTtlMs / 1000);
    }

    function reloadConfig() {
        providerInstance = null;
        providerFingerprint = null;
        configFingerprint = null;
        validationEpoch += 1;
        configInputs.clear();
        providerModules.clear();
        pendingAuth.clear();
        for (const sessionId of validationLanes.keys()) cancelValidation(sessionId);
    }

    async function authenticateAgent(clientId, clientSecret) {
        throw new Error('authenticateAgent via client_credentials is not supported by the generic bridge. Use caller-assertion signed requests instead.');
    }

    async function runProviderAdminOperation(operationName, payload = {}) {
        const { provider } = await ensureProvider();
        const operation = provider?.[operationName];
        if (typeof operation !== 'function') {
            const error = new Error('provider_user_admin_unsupported');
            error.code = 'provider_user_admin_unsupported';
            throw error;
        }
        return operation.call(provider, payload);
    }

    async function listUsers(payload = {}) {
        return runProviderAdminOperation('sso_admin_list_users', payload);
    }

    async function createUser(payload = {}) {
        return runProviderAdminOperation('sso_admin_create_user', payload);
    }

    async function updateUser(payload = {}) {
        return runProviderAdminOperation('sso_admin_update_user', payload);
    }

    async function deleteUser(payload = {}) {
        return runProviderAdminOperation('sso_admin_delete_user', payload);
    }

    return {
        isConfigured,
        reloadConfig,
        beginLogin,
        handleCallback,
        getSession,
        validateSession,
        admissionFence,
        refreshSession,
        logout,
        revokeSession,
        getSessionCookieMaxAge,
        authenticateAgent,
        listUsers,
        createUser,
        updateUser,
        deleteUser
    };
}
