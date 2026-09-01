import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import { createSessionStore } from './sessionStore.js';
import { randomId } from './utils.js';
import { resolveVarValue } from '../../utils/security/secretVars.js';
import { getConfig as getWorkspaceConfig } from '../../utils/workspace.js';
import { resolveAgentDescriptor } from '../../utils/agentRegistry.js';
import { findAgent } from '../../utils/utils.js';
import { emitAuthenticationSessionInvalidated } from './sessionEvents.js';

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

function __dirname() {
    return path.dirname(fileURLToPath(import.meta.url));
}

function readConfigValue(names, fallback) {
    const candidates = Array.isArray(names) ? names : [names].filter(Boolean);
    for (const name of candidates) {
        if (!name) continue;
        const secret = resolveVarValue(name);
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

function resolveProviderAgentPath(providerAgentRef) {
    const descriptor = resolveAgentDescriptor(providerAgentRef);
    if (descriptor?.manifestPath) {
        return path.dirname(descriptor.manifestPath);
    }
    try {
        const resolved = findAgent(providerAgentRef);
        if (resolved?.manifestPath) return path.dirname(resolved.manifestPath);
    } catch (_) {}
    return null;
}

async function loadProviderModule(providerAgentRef) {
    const agentDir = resolveProviderAgentPath(providerAgentRef);
    if (!agentDir) {
        throw new Error(`genericAuthBridge: could not locate provider agent '${providerAgentRef}'`);
    }
    const entryPath = path.join(agentDir, 'runtime', 'index.mjs');
    if (!fs.existsSync(entryPath)) {
        throw new Error(`genericAuthBridge: provider '${providerAgentRef}' missing runtime/index.mjs at ${entryPath}`);
    }
    const moduleUrl = pathToFileURL(entryPath).href;
    const mod = await import(moduleUrl);
    if (typeof mod.createProvider !== 'function') {
        throw new Error(`genericAuthBridge: provider '${providerAgentRef}' does not export createProvider()`);
    }
    return mod;
}

function readSsoConfig() {
    let workspaceConfig;
    try { workspaceConfig = getWorkspaceConfig(); } catch (_) { workspaceConfig = {}; }
    return workspaceConfig?.sso && typeof workspaceConfig.sso === 'object' ? workspaceConfig.sso : {};
}

function resolveConfiguredSsoProvider() {
    const sso = readSsoConfig();
    if (sso.enabled !== true) return '';
    return typeof sso.providerAgent === 'string' && sso.providerAgent.trim()
        ? sso.providerAgent.trim()
        : '';
}

async function resolveProviderConfig(mod) {
    const workspaceConfig = (() => {
        try { return getWorkspaceConfig(); } catch (_) { return {}; }
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
            readValue: readConfigValue
        });
    }

    return Object.keys(providerConfig).length ? providerConfig : null;
}

export function createGenericAuthBridge(options = {}) {
    const sessionStore = createSessionStore(options.sessionOptions);
    const remoteValidationIntervalMs = Number.isFinite(options.ssoValidationIntervalMs)
        ? Math.max(0, Number(options.ssoValidationIntervalMs))
        : 30_000;
    const clock = typeof options.now === 'function' ? options.now : () => Date.now();
    const remotelyValidatedAt = new Map();
    const validationInFlight = new Map();
    let validationEpoch = 0;
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

    function fingerprintFor(config, providerAgent) {
        return JSON.stringify({
            provider: providerAgent || null,
            config: config || null,
        });
    }

    async function ensureProvider() {
        const providerAgent = resolveConfiguredSsoProvider();
        if (!providerAgent) throw new Error('SSO is not configured (no provider agent configured)');
        const mod = await loadProviderModule(providerAgent);
        const config = await resolveProviderConfig(mod);
        if (!config) throw new Error('SSO is not configured (incomplete config values)');
        const nextFingerprint = fingerprintFor(config, providerAgent);
        if (providerInstance && providerFingerprint === providerAgent && configFingerprint === nextFingerprint) {
            return { provider: providerInstance, providerAgent, config };
        }
        const provider = mod.createProvider({
            getConfig: async () => resolveProviderConfig(mod)
        });
        providerInstance = provider;
        providerFingerprint = providerAgent;
        configFingerprint = nextFingerprint;
        return { provider, providerAgent, config };
    }

    function cleanupPending() {
        const now = Date.now();
        for (const [state, entry] of pendingAuth.entries()) {
            if (now - entry.createdAt > PENDING_TTL_MS) {
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
        const { provider, config, providerAgent } = await ensureProvider();
        const redirectUri = resolveRedirectUri(baseUrl, config);
        const { authorizationUrl, providerState, expiresAt } = await provider.sso_begin_login({ redirectUri, prompt });
        const coreState = randomId(16);
        pendingAuth.set(coreState, {
            providerAgent,
            providerState,
            redirectUri,
            returnTo: returnTo || '/',
            createdAt: Date.now(),
            expiresAt: expiresAt || (Date.now() + PENDING_TTL_MS)
        });
        // Replace the `state` query param in the authorization URL with our
        // core-owned `coreState`. That way, the browser always presents the
        // core key on the callback, and the provider sees its own `state`
        // only after we consume the pending entry.
        const url = new URL(authorizationUrl);
        url.searchParams.set('state', coreState);
        return {
            redirectUrl: url.toString(),
            state: coreState
        };
    }

    async function handleCallback({ code, state, baseUrl, rawQuery }) {
        cleanupPending();
        const pending = pendingAuth.get(state);
        if (!pending) throw new Error('Invalid or expired authorization state');
        pendingAuth.delete(state);
        const { provider, config } = await ensureProvider();
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
        const session = sessionStore.getSession(sessionId);
        if (!session) throw new Error('Session not found');
        const { provider } = await ensureProvider();
        const { user, providerSession } = await provider.sso_refresh_session({
            providerSession: session.providerSession || { tokens: session.tokens }
        });
        const now = Date.now();
        const expiresAt = providerSession?.expiresAt || (now + sessionStore.sessionTtlMs);
        const refreshExpiresAt = providerSession?.refreshExpiresAt || session.refreshExpiresAt || null;
        sessionStore.updateSession(sessionId, {
            tokens: providerSession?.tokens || session.tokens,
            providerSession,
            user: user || session.user,
            expiresAt,
            refreshExpiresAt
        });
        remotelyValidatedAt.set(sessionId, clock());
        const typeKey = 'token' + 'Type';
        return {
            accessToken: providerSession?.tokens?.accessToken || session.tokens?.accessToken || null,
            expiresAt,
            scope: providerSession?.tokens?.scope || session.tokens?.scope || null,
            [typeKey]: providerSession?.tokens?.[typeKey] || session.tokens?.[typeKey] || null,
            user
        };
    }

    async function performRemoteValidation(sessionId, session, epoch) {
        try {
            const { provider } = await ensureProvider();
            const operation = typeof provider.sso_refresh_session === 'function'
                ? provider.sso_refresh_session.bind(provider)
                : provider.sso_validate_session?.bind(provider);
            if (!operation) throw new Error('provider has no response-free session validation operation');
            const outcome = await operation({
                providerSession: session.providerSession || { tokens: session.tokens },
            });
            if (epoch !== validationEpoch || !sessionStore.getSession(sessionId)) return null;
            if (!outcome || !outcome.user) {
                sessionStore.deleteSession(sessionId);
                emitAuthenticationSessionInvalidated({ mode: 'sso', sessionId, reason: 'invalid' });
                return null;
            }
            const providerSession = outcome.providerSession || session.providerSession;
            const updated = sessionStore.updateSession(sessionId, {
                user: outcome.user,
                providerSession,
                tokens: providerSession?.tokens || session.tokens,
                expiresAt: providerSession?.expiresAt || session.expiresAt,
                refreshExpiresAt: providerSession?.refreshExpiresAt ?? session.refreshExpiresAt,
            });
            if (!updated) return null;
            remotelyValidatedAt.set(sessionId, clock());
            return updated;
        } catch (_) {
            if (epoch !== validationEpoch || !sessionStore.getSession(sessionId)) return null;
            sessionStore.deleteSession(sessionId);
            remotelyValidatedAt.delete(sessionId);
            emitAuthenticationSessionInvalidated({ mode: 'sso', sessionId, reason: 'validation_failed' });
            return null;
        }
    }

    async function validateSession(sessionId, { forceRemote = false } = {}) {
        const session = sessionStore.getSession(sessionId);
        if (!session) return null;
        const lastValidatedAt = remotelyValidatedAt.get(sessionId) || 0;
        if (!forceRemote && lastValidatedAt
            && clock() - lastValidatedAt < remoteValidationIntervalMs) return session;
        const existing = validationInFlight.get(sessionId);
        if (existing) return existing;
        const epoch = validationEpoch;
        const pending = performRemoteValidation(sessionId, session, epoch);
        validationInFlight.set(sessionId, pending);
        try {
            return await pending;
        } finally {
            if (validationInFlight.get(sessionId) === pending) validationInFlight.delete(sessionId);
        }
    }

    async function logout(sessionId, { baseUrl, postLogoutRedirectUri } = {}) {
        const session = sessionStore.getSession(sessionId);
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
        if (session) {
            sessionStore.deleteSession(sessionId);
            remotelyValidatedAt.delete(sessionId);
            validationInFlight.delete(sessionId);
            emitAuthenticationSessionInvalidated({ mode: 'sso', sessionId, reason: 'logout' });
        }
        return { redirect };
    }

    function revokeSession(sessionId) {
        sessionStore.deleteSession(sessionId);
        remotelyValidatedAt.delete(sessionId);
        validationInFlight.delete(sessionId);
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
        remotelyValidatedAt.clear();
        validationInFlight.clear();
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
