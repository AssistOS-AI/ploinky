// Canonical install contracts and input keys for the immutable dependency cache.
//
// seedInputKey  = SHA-256(canonical seed contract): schema/installer policy,
//                 runtime family/key/engine, immutable image ID or host
//                 toolchain identity, explicit npm policy, effective global
//                 manifest + remote-verified pins, SDK bundle identity and the
//                 full AgentLib install identity (fingerprint, adapter schema,
//                 actual link and install targets). No agent package or
//                 rebuild token.
// agentInputKey = the same provider fields plus the canonical effective merged
//                 manifest actually passed to npm (after reserved-provider
//                 validation and in-Box SDK removal, with current merge
//                 semantics), its pins, the exact package source/`code/`
//                 selection and the logical registration's rebuild token.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { mergePackageJson } from '../dependencyInstaller.js';
import { assertNoReservedAgentLibDependency, agentLibLinkTarget } from '../agentLibLink.js';
import { AGENTLIB_ADAPTER_SCHEMA } from '../agentLibPackages.mjs';
import { parseRuntimeKey } from '../dependencyRuntimeKey.js';
import { AGENTLIB_STABLE_MOUNT_PATH } from '../../../../agentlib/contract.mjs';
import { boxMcpSdkStampSection, needsNpmInstall, withoutBoxMcpSdk } from '../../../../ploinky-box/agent-dependencies/mcp-sdk.mjs';
import { dependencyStoreError, canonicalDigest, canonicalValue, sha256Hex } from './canonical.mjs';
import { collectGitInputs, desiredPinsFor, PIN_SECTIONS } from './gitPins.mjs';
import { parseGitDependencySpec, rewriteSpecToCommit } from './gitSpec.mjs';
import { containerNpmPolicy } from './npmPolicy.mjs';

export const CONTRACT_SCHEMA = 1;
// Bump when the build procedure changes in a way that can change bytes.
export const INSTALLER_POLICY_VERSION = 1;
const IMAGE_ID_PATTERN = /^(?:sha256:)?([0-9a-f]{64})$/;
const INSTALL_SECTIONS = Object.freeze([
    'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta',
    'overrides', 'bundleDependencies', 'bundledDependencies', 'scripts',
]);

/** Accept only an immutable content ID (podman prints bare hex, docker prefixes sha256:). */
export function normalizeImageId(raw) {
    const match = IMAGE_ID_PATTERN.exec(String(raw || '').trim().toLowerCase());
    if (!match) {
        throw dependencyStoreError('PLOINKY_DEPS_IMAGE_IDENTITY_REQUIRED',
            `container dependency caches require an immutable image ID; '${String(raw || '').slice(0, 80)}' is not one`);
    }
    return `sha256:${match[1]}`;
}

export function defaultInspectImage({ runtime, image }) {
    const result = spawnSync(runtime, ['image', 'inspect', '--format', '{{.Id}}', image], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
    });
    if (result.error || result.status !== 0) {
        throw dependencyStoreError('PLOINKY_DEPS_IMAGE_IDENTITY_REQUIRED',
            `could not inspect the immutable ID of image '${image}' (${result.error?.code || `exit ${result.status}`})`);
    }
    return String(result.stdout || '').trim().split('\n')[0];
}

/** Container toolchain identity: engine plus inspected immutable image ID. A tag is diagnostic only. */
export function containerToolchainIdentity({ runtime, image, inspectImage = defaultInspectImage }) {
    const engine = String(runtime || '').trim();
    if (!['podman', 'docker'].includes(engine)) {
        throw dependencyStoreError('PLOINKY_DEPS_ENGINE_UNSUPPORTED', `unsupported container engine '${engine}'`);
    }
    const reference = String(image || '').trim();
    if (!reference) throw dependencyStoreError('PLOINKY_DEPS_IMAGE_IDENTITY_REQUIRED', 'container dependency caches require an image');
    const imageId = normalizeImageId(inspectImage({ runtime: engine, image: reference }));
    return { identity: { kind: 'container', engine, imageId }, diagnostics: { imageReference: reference } };
}

function findOnPath(command, env, fsApi) {
    for (const directory of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
        const candidate = path.join(directory, command);
        try {
            const stat = fsApi.statSync(candidate);
            if (stat.isFile() && (stat.mode & 0o111)) return candidate;
        } catch { /* keep searching */ }
    }
    return null;
}

function executableIdentity(file, fsApi, { hashContent = false } = {}) {
    if (!file) return null;
    const realpath = fsApi.realpathSync(file);
    const stat = fsApi.statSync(realpath);
    return {
        realpath,
        size: stat.size,
        mtimeMs: Math.trunc(stat.mtimeMs),
        ...(hashContent ? { sha256: sha256Hex(fsApi.readFileSync(realpath)) } : {}),
    };
}

const NODE_PROBE = [
    'const r=typeof process.report?.getReport==="function"?process.report.getReport():null;',
    'const h=r&&r.header?r.header:{};',
    'process.stdout.write(JSON.stringify({execPath:process.execPath,version:process.versions.node,',
    'modules:process.versions.modules,napi:process.versions.napi||"",v8:process.versions.v8,',
    'platform:process.platform,arch:process.arch,',
    'libc:process.platform==="linux"?(h.glibcVersionRuntime?"glibc":"musl"):"",',
    'glibc:h.glibcVersionRuntime||""}));',
].join('');

/**
 * Probe the host toolchain that `npm` on PATH will actually use. Executables
 * are identified by realpath/size/mtime (npm's entry script also by content);
 * build tools reachable by lifecycle scripts are recorded when present.
 */
export function defaultProbeHostToolchain({ env = process.env, fsApi = fs, spawn = spawnSync } = {}) {
    const npmPath = findOnPath('npm', env, fsApi);
    const nodePath = findOnPath('node', env, fsApi);
    if (!npmPath || !nodePath) {
        throw dependencyStoreError('PLOINKY_DEPS_HOST_TOOLCHAIN_MISSING', 'host dependency caches require node and npm on PATH');
    }
    const node = spawn(nodePath, ['-e', NODE_PROBE], { encoding: 'utf8', timeout: 15_000, env: { PATH: env.PATH || '' } });
    const npm = spawn(npmPath, ['--version'], { encoding: 'utf8', timeout: 30_000, env: { PATH: env.PATH || '', HOME: env.HOME || '' } });
    if (node.status !== 0 || npm.status !== 0) {
        throw dependencyStoreError('PLOINKY_DEPS_HOST_TOOLCHAIN_MISSING', 'could not probe the host node/npm toolchain');
    }
    const nodeInfo = JSON.parse(node.stdout);
    const npmRealpath = fsApi.realpathSync(npmPath);
    const npmRoot = path.dirname(path.dirname(npmRealpath));
    let builtinNpmrc = null;
    try { builtinNpmrc = sha256Hex(fsApi.readFileSync(path.join(npmRoot, 'npmrc'))); } catch { /* none */ }
    const tools = {};
    for (const tool of ['python3', 'make', 'cc', 'c++', 'git']) {
        const found = findOnPath(tool, env, fsApi);
        tools[tool] = found ? executableIdentity(found, fsApi) : null;
    }
    return {
        node: { ...executableIdentity(nodeInfo.execPath || nodePath, fsApi), version: nodeInfo.version, modules: nodeInfo.modules,
            napi: nodeInfo.napi, v8: nodeInfo.v8 },
        npm: { ...executableIdentity(npmPath, fsApi, { hashContent: true }), version: String(npm.stdout).trim(), builtinNpmrc },
        platform: nodeInfo.platform,
        arch: nodeInfo.arch,
        libc: nodeInfo.libc || '',
        glibc: nodeInfo.glibc || '',
        tools,
    };
}

/** Host toolchain identity; the probed toolchain must match the selected runtime key. */
export function hostToolchainIdentity({ runtimeKey, probe }) {
    const parsed = parseRuntimeKey(runtimeKey);
    if (!parsed || !['bwrap', 'seatbelt'].includes(parsed.family)) {
        throw dependencyStoreError('PLOINKY_DEPS_RUNTIME_KEY_INVALID', `host dependency caches require a bwrap/seatbelt runtime key (got ${runtimeKey})`);
    }
    const nodeMajor = Number.parseInt(String(probe?.node?.version || '').split('.')[0], 10);
    if (probe?.platform !== parsed.platform || probe?.arch !== parsed.arch || nodeMajor !== parsed.nodeMajor) {
        throw dependencyStoreError('PLOINKY_DEPS_RUNTIME_KEY_MISMATCH',
            `host toolchain ${probe?.platform}-${probe?.arch}-node${nodeMajor} does not match runtime key ${runtimeKey}`);
    }
    return { kind: 'host', ...canonicalValue(probe) };
}

/** The AgentLib identity an install can observe: npm links it before lifecycle scripts run. */
export function agentLibInstallIdentity(runtimeFamily, selection) {
    const fingerprint = String(selection?.fingerprint || '').trim();
    const sourceDir = String(selection?.sourceDir || '').trim();
    if (!fingerprint || !sourceDir) {
        throw dependencyStoreError('PLOINKY_DEPS_AGENTLIB_IDENTITY_MISSING',
            'dependency caches require the selected AgentLib source directory and content fingerprint');
    }
    const container = runtimeFamily === 'container';
    return {
        adapterSchema: AGENTLIB_ADAPTER_SCHEMA,
        mode: String(selection.mode || ''),
        fingerprint,
        commit: String(selection.commit || ''),
        sourceIdHash: String(selection.sourceIdHash || ''),
        linkTarget: agentLibLinkTarget(runtimeFamily, selection),
        installTarget: container ? AGENTLIB_STABLE_MOUNT_PATH : path.resolve(sourceDir),
    };
}

/**
 * Provider-side contract shared by seed and agent keys.
 *
 * @param {{ runtimeKey: string, toolchain: object, npmPolicy: object, sdkBundle: object|null, agentLib: object }} input
 *   toolchain from containerToolchainIdentity(...).identity or hostToolchainIdentity(...);
 *   npmPolicy from resolveHostNpmPolicy(...).policy or containerNpmPolicy();
 *   agentLib is the active selection ({ sourceDir, mode, fingerprint, commit, sourceIdHash }).
 */
export function buildProviderContract({ runtimeKey, toolchain, npmPolicy, sdkBundle = null, agentLib }) {
    const parsed = parseRuntimeKey(runtimeKey);
    if (!parsed) throw dependencyStoreError('PLOINKY_DEPS_RUNTIME_KEY_INVALID', `invalid runtime key ${runtimeKey}`);
    if (!toolchain || (toolchain.kind === 'container') !== (parsed.family === 'container')) {
        throw dependencyStoreError('PLOINKY_DEPS_TOOLCHAIN_INVALID', `toolchain identity does not match runtime family ${parsed.family}`);
    }
    if (toolchain.kind === 'container') normalizeImageId(toolchain.imageId);
    if (!npmPolicy || (toolchain.kind === 'container' && npmPolicy.source !== 'image')
        || (toolchain.kind === 'host' && npmPolicy.source !== 'host-explicit')) {
        throw dependencyStoreError('PLOINKY_DEPS_NPM_POLICY_INVALID', 'npm policy does not match the installer kind');
    }
    return canonicalValue({
        schema: CONTRACT_SCHEMA,
        installerPolicy: INSTALLER_POLICY_VERSION,
        runtime: { family: parsed.family, key: runtimeKey, engine: toolchain.kind === 'container' ? toolchain.engine : parsed.family },
        toolchain,
        npm: npmPolicy,
        providers: {
            mcpSdk: sdkBundle ? boxMcpSdkStampSection(sdkBundle) : null,
            agentLib: agentLibInstallIdentity(parsed.family, agentLib),
        },
    });
}

function filterProviders(pkg, sdkBundle, source) {
    return withoutBoxMcpSdk(assertNoReservedAgentLibDependency(pkg || {}, source), { bundle: sdkBundle, source });
}

function applyPins(manifest, desiredPins) {
    const result = { ...manifest };
    for (const pin of desiredPins) {
        const spec = result[pin.section]?.[pin.name];
        const parsed = parseGitDependencySpec(spec);
        if (!parsed?.supported || parsed.identity !== pin.specIdentity) continue;
        result[pin.section] = { ...result[pin.section], [pin.name]: rewriteSpecToCommit(parsed, pin.commit) };
    }
    return result;
}

/**
 * Which direct Git packages the install must provably contain.
 * presence: 'required' (missing = failure), 'optional' (npm may omit it) or
 * 'policy' (omission depends on image/npm policy). Present packages must
 * always match source and, when known, the exact commit.
 */
function expectedGitPackages(installManifest, npmPolicy) {
    const seen = new Set();
    const expected = [];
    const omit = new Set(npmPolicy?.omit || []);
    const imagePolicy = npmPolicy?.source === 'image';
    for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
        for (const name of Object.keys(installManifest?.[section] || {}).sort()) {
            if (seen.has(name)) continue;
            seen.add(name);
            const parsed = parseGitDependencySpec(installManifest[section][name]);
            if (!parsed) continue;
            let presence = 'required';
            if (section === 'optionalDependencies' || omit.has('optional') && section === 'optionalDependencies') presence = 'optional';
            if (section === 'devDependencies') presence = imagePolicy ? 'policy' : (omit.has('dev') ? 'omitted' : 'required');
            if (section === 'peerDependencies') {
                const optionalPeer = Boolean(installManifest.peerDependenciesMeta?.[name]?.optional);
                presence = (npmPolicy?.legacyPeerDeps || optionalPeer || omit.has('peer')) ? 'optional' : (imagePolicy ? 'policy' : 'required');
            }
            expected.push({
                section,
                name,
                source: parsed.supported ? parsed.source : null,
                commit: parsed.supported && parsed.ref.kind === 'sha' ? parsed.ref.sha : null,
                supported: Boolean(parsed.supported),
                presence,
            });
        }
    }
    return expected;
}

function installSections(manifest) {
    const result = {};
    for (const field of INSTALL_SECTIONS) if (manifest?.[field] !== undefined) result[field] = manifest[field];
    return canonicalValue(result);
}

function assertProviderInputs(provider, sdkBundle, agentLibSelection) {
    const expectedSdk = sdkBundle ? boxMcpSdkStampSection(sdkBundle) : null;
    if (canonicalDigest({ sdk: expectedSdk }) !== canonicalDigest({ sdk: provider?.providers?.mcpSdk ?? null })) {
        throw dependencyStoreError('PLOINKY_DEPS_PROVIDER_MISMATCH', 'the SDK bundle differs from the provider contract');
    }
    const agentLib = agentLibInstallIdentity(provider?.runtime?.family, agentLibSelection);
    if (canonicalDigest(agentLib) !== canonicalDigest(provider?.providers?.agentLib || {})) {
        throw dependencyStoreError('PLOINKY_DEPS_PROVIDER_MISMATCH', 'the AgentLib selection differs from the provider contract');
    }
}

function finishPlan(kind, contract, effectiveManifest, installManifest, git, provider, sdkBundle, agentLibSelection) {
    assertProviderInputs(provider, sdkBundle, agentLibSelection);
    const inputKey = canonicalDigest(contract);
    return Object.freeze({
        kind,
        contract,
        inputKey,
        effectiveManifest,
        installManifest,
        npmRequired: !sdkBundle || needsNpmInstall(installManifest),
        installSections: installSections(installManifest),
        gitEntries: git.entries,
        gitUnsupported: git.unsupported,
        expectedGit: expectedGitPackages(installManifest, provider.npm),
        providers: Object.freeze({
            sdkBundle,
            agentLib: { selection: agentLibSelection, ...provider.providers.agentLib },
        }),
    });
}

/**
 * Seed (global) install plan.
 *
 * @param {{ provider: object, globalPackage: object, sdkBundle: object|null, agentLibSelection: object, pinState?: object }} input
 * @returns {object} plan with `inputKey` (full SHA-256), `contract`, `installManifest`, `expectedGit`, ...
 */
export function buildSeedInstallPlan({ provider, globalPackage, sdkBundle = null, agentLibSelection, pinState = {} }) {
    const effective = canonicalValue(filterProviders(globalPackage, sdkBundle, 'globalDeps/package.json'));
    const binding = { scope: 'global' };
    const git = collectGitInputs(effective, binding);
    const pins = desiredPinsFor(pinState, git.entries);
    const contract = canonicalValue({
        ...provider,
        kind: 'seed',
        global: { manifest: effective, pins: pins.map(pinContract) },
    });
    return finishPlan('seed', contract, effective, applyPins(effective, pins), git, provider, sdkBundle, agentLibSelection);
}

function pinContract(pin) {
    return { section: pin.section, name: pin.name, source: pin.source, specIdentity: pin.specIdentity, commit: pin.commit };
}

/**
 * Which agent package.json reaches the installer, mirroring current precedence:
 * when `<agent>/code` exists only `code/package.json` counts; otherwise the
 * agent root package.json.
 *
 * @returns {{ selection: 'code'|'root', relativePath: string, sha256: string|null, manifest: object|null }}
 */
export function readAgentPackageSource(agentPath, { relativeTo = agentPath, fsApi = fs } = {}) {
    const codePath = path.join(agentPath, 'code');
    const selection = fsApi.existsSync(codePath) ? 'code' : 'root';
    const packagePath = path.join(selection === 'code' ? codePath : agentPath, 'package.json');
    const relativePath = path.relative(relativeTo, packagePath).split(path.sep).join('/');
    let bytes;
    try { bytes = fsApi.readFileSync(packagePath); }
    catch (error) {
        if (error?.code === 'ENOENT') return { selection, relativePath, sha256: null, manifest: null };
        throw error;
    }
    return { selection, relativePath, sha256: sha256Hex(bytes), manifest: JSON.parse(bytes.toString('utf8')) };
}

/**
 * Agent install plan.
 *
 * @param {{ provider: object, globalPackage: object, agentPackage: {selection, relativePath, sha256, manifest}|null,
 *   registration: string, rebuildToken?: string|null, sdkBundle: object|null, agentLibSelection: object,
 *   pinState?: object, merge?: Function }} input
 */
export function buildAgentInstallPlan({
    provider,
    globalPackage,
    agentPackage = null,
    registration,
    rebuildToken = null,
    sdkBundle = null,
    agentLibSelection,
    pinState = {},
    merge = mergePackageJson,
}) {
    const registrationId = String(registration || '').trim();
    if (!registrationId) throw dependencyStoreError('PLOINKY_DEPS_REGISTRATION_REQUIRED', 'agent dependency plans require a registration id');
    const globalEffective = filterProviders(globalPackage, sdkBundle, 'globalDeps/package.json');
    const agentEffective = agentPackage?.manifest ? filterProviders(agentPackage.manifest, sdkBundle, 'agent package.json') : null;
    // Current merge semantics: fields the merge drops stay dropped.
    const effective = canonicalValue(merge(globalEffective, agentEffective));
    const packageSource = {
        selection: agentPackage?.selection || 'none',
        relativePath: agentPackage?.relativePath || '',
        sha256: agentPackage?.sha256 || null,
    };
    const binding = { scope: 'registration', registration: registrationId, packageSource: packageSource.relativePath };
    const git = collectGitInputs(effective, binding);
    const pins = desiredPinsFor(pinState, git.entries);
    const contract = canonicalValue({
        ...provider,
        kind: 'agent',
        agent: {
            manifest: effective,
            pins: pins.map(pinContract),
            packageSource,
            rebuildToken: rebuildToken === null || rebuildToken === undefined ? null : String(rebuildToken),
        },
    });
    const plan = finishPlan('agent', contract, effective, applyPins(effective, pins), git, provider, sdkBundle, agentLibSelection);
    return Object.freeze({ ...plan, registration: registrationId, hasAgentPackage: Boolean(agentPackage?.manifest), pinBinding: binding });
}

/**
 * A seed payload may be copied into an agent object only when no npm run
 * follows and every provider and install-relevant manifest field matches.
 */
export function seedCopyEligibility(agentPlan, seedPlan, { reinstall = false } = {}) {
    if (reinstall) return { eligible: false, reason: 'target reinstall bypasses seeds' };
    if (agentPlan.hasAgentPackage && agentPlan.npmRequired) return { eligible: false, reason: 'agent package requires npm' };
    const providerOf = (contract) => canonicalDigest({
        schema: contract.schema, installerPolicy: contract.installerPolicy, runtime: contract.runtime,
        toolchain: contract.toolchain, npm: contract.npm, providers: contract.providers,
    });
    if (providerOf(agentPlan.contract) !== providerOf(seedPlan.contract)) return { eligible: false, reason: 'provider contract differs' };
    if (canonicalDigest(agentPlan.installSections) !== canonicalDigest(seedPlan.installSections)) {
        return { eligible: false, reason: 'install manifest differs from the seed' };
    }
    return { eligible: true, reason: 'exact seed contract' };
}

export { PIN_SECTIONS, containerNpmPolicy };
