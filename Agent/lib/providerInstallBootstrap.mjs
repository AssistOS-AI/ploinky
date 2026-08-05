import { createHash } from 'node:crypto';
import fs from 'node:fs';

import { assertAgentCredentialContext } from './agentCredentialContext.mjs';
import { runProviderSandboxInstall } from './providerSandbox.mjs';

export const PROVIDER_INSTALL_MANIFEST_PATH = '/code/manifest.json';
const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_MANIFEST_BYTES = 1024 * 1024;

function installError(code, message, cause) {
    const error = new Error(message, cause ? { cause } : undefined);
    error.code = code;
    return error;
}

function rawManifestDigest(bytes) {
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function readManifestSnapshot(manifestPath, readFileSync) {
    let bytes;
    try {
        bytes = Buffer.from(readFileSync(manifestPath));
    } catch (cause) {
        throw installError(
            'PLOINKY_PROVIDER_INSTALL_MANIFEST_INVALID',
            'the admitted provider manifest is unavailable',
            cause,
        );
    }
    if (bytes.length === 0 || bytes.length > MAX_MANIFEST_BYTES) {
        throw installError(
            'PLOINKY_PROVIDER_INSTALL_MANIFEST_INVALID',
            'the admitted provider manifest size is invalid',
        );
    }
    let manifest;
    try {
        manifest = JSON.parse(bytes.toString('utf8'));
    } catch (cause) {
        throw installError(
            'PLOINKY_PROVIDER_INSTALL_MANIFEST_INVALID',
            'the admitted provider manifest is not valid JSON',
            cause,
        );
    }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
        throw installError(
            'PLOINKY_PROVIDER_INSTALL_MANIFEST_INVALID',
            'the admitted provider manifest must be an object',
        );
    }
    return Object.freeze({ bytes, digest: rawManifestDigest(bytes), manifest });
}

export function resolveAdmittedProviderInstall(manifest, profileName = 'default') {
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
        || typeof profileName !== 'string' || !PROFILE_RE.test(profileName)) {
        throw installError(
            'PLOINKY_PROVIDER_INSTALL_PROFILE_INVALID',
            'the provider install profile is invalid',
        );
    }
    let profile = null;
    if (manifest.profiles !== undefined) {
        if (!manifest.profiles || typeof manifest.profiles !== 'object'
            || Array.isArray(manifest.profiles)
            || !Object.prototype.hasOwnProperty.call(manifest.profiles, profileName)
            || !manifest.profiles[profileName]
            || typeof manifest.profiles[profileName] !== 'object'
            || Array.isArray(manifest.profiles[profileName])) {
            throw installError(
                'PLOINKY_PROVIDER_INSTALL_PROFILE_INVALID',
                'the admitted provider install profile is unavailable',
            );
        }
        profile = manifest.profiles[profileName];
    }
    const hook = profile?.install ?? manifest.install;
    if (hook === undefined || hook === null) {
        return Object.freeze({ profileName, hook: null });
    }
    if (typeof hook !== 'string' || !hook.trim() || hook.includes('\0')
        || Buffer.byteLength(hook) > 16 * 1024) {
        throw installError(
            'PLOINKY_PROVIDER_INSTALL_HOOK_INVALID',
            'the admitted provider install hook is invalid',
        );
    }
    return Object.freeze({ profileName, hook });
}

export async function runProviderInstallBootstrap({
    provider,
    credentialContext,
    profileName = process.env.PLOINKY_PROFILE || 'default',
    manifestPath = PROVIDER_INSTALL_MANIFEST_PATH,
    timeoutMs,
    leaseRoot,
    signal,
    dependencyOverrides = {},
} = {}) {
    const context = assertAgentCredentialContext(credentialContext);
    context.assertActive();
    if (context.runtime.runtimeKind !== 'bwrap'
        || context.source !== 'bwrap-credential-v1') {
        throw installError(
            'PLOINKY_PROVIDER_INSTALL_RUNTIME_INVALID',
            'provider bootstrap installation is restricted to the admitted Bubblewrap runtime',
        );
    }
    if (typeof manifestPath !== 'string' || !manifestPath || manifestPath.includes('\0')) {
        throw installError(
            'PLOINKY_PROVIDER_INSTALL_MANIFEST_INVALID',
            'the provider install manifest path is invalid',
        );
    }
    const readFileSync = dependencyOverrides.readFileSync ?? fs.readFileSync;
    const runInstall = dependencyOverrides.runProviderSandboxInstall
        ?? runProviderSandboxInstall;
    if (typeof readFileSync !== 'function' || typeof runInstall !== 'function') {
        throw installError(
            'PLOINKY_PROVIDER_INSTALL_DEPENDENCY_INVALID',
            'provider install dependencies are invalid',
        );
    }
    const admitted = readManifestSnapshot(manifestPath, readFileSync);
    if (admitted.digest !== context.attestation.manifestDigest) {
        throw installError(
            'PLOINKY_PROVIDER_INSTALL_MANIFEST_MISMATCH',
            'provider install manifest no longer matches credential admission',
        );
    }
    const resolved = resolveAdmittedProviderInstall(admitted.manifest, profileName);
    if (resolved.hook === null) {
        return Object.freeze({ provider, profileName: resolved.profileName, installed: false });
    }
    await runInstall({
        provider,
        credentialContext: context,
        installHook: resolved.hook,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(leaseRoot === undefined ? {} : { leaseRoot }),
        ...(signal === undefined ? {} : { signal }),
        async validateAfterLease() {
            context.assertActive();
            const current = readManifestSnapshot(manifestPath, readFileSync);
            const currentResolved = resolveAdmittedProviderInstall(current.manifest, profileName);
            if (current.digest !== admitted.digest
                || current.digest !== context.attestation.manifestDigest
                || currentResolved.profileName !== resolved.profileName
                || currentResolved.hook !== resolved.hook) {
                throw installError(
                    'PLOINKY_PROVIDER_INSTALL_MANIFEST_MISMATCH',
                    'provider install admission changed while acquiring HOME ownership',
                );
            }
        },
    });
    return Object.freeze({ provider, profileName: resolved.profileName, installed: true });
}
