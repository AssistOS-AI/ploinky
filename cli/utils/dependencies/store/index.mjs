// Public surface of the immutable dependency store for lifecycle
// integration. Runtime callers use installContract to build plans, the object
// store to resolve generations under their held workspace lease, and the
// installers for real npm runs. Only the update flow calls discoverGitPins.

export { canonicalDigest, canonicalJson } from './canonical.mjs';
export {
    buildAgentInstallPlan,
    buildProviderContract,
    buildSeedInstallPlan,
    containerToolchainIdentity,
    defaultInspectImage,
    defaultProbeHostToolchain,
    hostToolchainIdentity,
    normalizeImageId,
    readAgentPackageSource,
    seedCopyEligibility,
} from './installContract.mjs';
export { containerNpmPolicy, defaultNpmConfigSources, resolveHostNpmPolicy } from './npmPolicy.mjs';
export {
    PIN_VERIFICATION,
    collectGitInputs,
    desiredPinsFor,
    discoverGitPins,
    mergeDiscoveredPins,
    recordObservedPins,
} from './gitPins.mjs';
export { parseGitDependencySpec } from './gitSpec.mjs';
export { DEPENDENCY_STORE_DIRNAME, createCacheStore, generationIdFor } from './objectStore.mjs';
export { createContainerNpmInstaller, createHostNpmInstaller } from './installers.mjs';
export {
    currentWriterIdentity,
    defaultInspectContainer,
    defaultProveBuildQuiescent,
    defaultProveReaderQuiescent,
} from './receipts.mjs';
