import {
    admitManifestRuntimeCapabilities,
    renderContainerSecurityArgs,
    resolveEffectiveRuntimeCapabilities,
    validateManifestRuntimeCapabilities,
} from '../runtimeCapabilities.js';

export function resolveContainerSecurity(manifest, profileConfig) {
    validateManifestRuntimeCapabilities(manifest);
    if (profileConfig && Object.prototype.hasOwnProperty.call(profileConfig, 'containerSecurity')) {
        const synthetic = { ...manifest, profiles: { selected: profileConfig } };
        validateManifestRuntimeCapabilities(synthetic);
    }
    return resolveEffectiveRuntimeCapabilities(manifest, { profileConfig }).containerSecurity;
}

export function buildContainerSecurityArgs(containerSecurity) {
    // This synthetic manifest is admitted only to bind the renderer to a
    // container-mode descriptor; the image reference is never resolved or run.
    const manifest = {
        container: 'docker.io/assistos/ploinky-policy-only:admission',
        containerSecurity,
    };
    const admission = admitManifestRuntimeCapabilities(manifest, {
        manifestBytes: Buffer.from(JSON.stringify(manifest), 'utf8'),
        insideBox: false,
    });
    return renderContainerSecurityArgs(admission.descriptor);
}
