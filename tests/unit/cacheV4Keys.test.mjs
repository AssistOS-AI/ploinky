import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalDigest, canonicalJson } from '../../cli/utils/dependencies/cacheV4/canonical.mjs';
import {
    buildAgentInstallPlan,
    buildSeedInstallPlan,
    containerToolchainIdentity,
    normalizeImageId,
    readAgentPackageSource,
    seedCopyEligibility,
} from '../../cli/utils/dependencies/cacheV4/installContract.mjs';
import { NPM_BASE_INSTALL_ARGS, containerNpmPolicy, resolveHostNpmPolicy } from '../../cli/utils/dependencies/cacheV4/npmPolicy.mjs';
import { buildPin, collectGitInputs, PIN_VERIFICATION } from '../../cli/utils/dependencies/cacheV4/gitPins.mjs';
import { NPM_INSTALL_ARGS, buildContainerInstallScript } from '../../cli/utils/dependencies/dependencyCache.js';
import * as cacheV4 from '../../cli/utils/dependencies/cacheV4/index.mjs';
import {
    containerProvider,
    hostProbe,
    hostProvider,
    makeAgentLib,
    tempRoot,
} from './cacheV4Fixtures.mjs';

const IMAGE_A = `sha256:${'a'.repeat(64)}`;
const IMAGE_B = `sha256:${'b'.repeat(64)}`;
const SDK_URL = 'https://github.com/AssistOS-AI/MCPSDK.git';
const GLOBAL = Object.freeze({
    name: 'ploinky-global-deps',
    version: '1.0.0',
    dependencies: { 'mcp-sdk': `git+${SDK_URL}#main`, 'left-pad': '1.3.0' },
});

function sdkBundle(contentSha256 = 'c'.repeat(64)) {
    return { schema: 'ploinky.box.mcp-sdk/v1', repository: { url: SDK_URL, commit: 'd'.repeat(40) }, contentSha256, sourceRoot: '/nonexistent' };
}

function agentPackage(manifest, relativePath = 'repo/agent/code/package.json') {
    const bytes = JSON.stringify(manifest);
    return { selection: 'code', relativePath, sha256: canonicalDigest(bytes), manifest };
}

function plans(t, overrides = {}) {
    const root = tempRoot(t);
    const agentLib = overrides.agentLib || makeAgentLib(root);
    const sdk = overrides.sdkBundle ?? null;
    const provider = overrides.provider || hostProvider({ agentLib, sdkBundle: sdk, ...(overrides.providerOptions || {}) });
    const seed = buildSeedInstallPlan({ provider, globalPackage: overrides.globalPackage || GLOBAL, sdkBundle: sdk, agentLibSelection: agentLib, pinState: overrides.pinState || {} });
    const agent = buildAgentInstallPlan({
        provider,
        globalPackage: overrides.globalPackage || GLOBAL,
        agentPackage: overrides.agentPackage === undefined ? agentPackage({ name: 'agent', dependencies: { chalk: '5.0.0' } }) : overrides.agentPackage,
        registration: overrides.registration || 'repo/agent',
        rebuildToken: overrides.rebuildToken ?? null,
        sdkBundle: sdk,
        agentLibSelection: agentLib,
        pinState: overrides.pinState || {},
    });
    return { seed, agent, agentLib, root };
}

test('cache-v4 keys: canonical JSON sorts nested keys and never drops nested fields', () => {
    assert.equal(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 1, e: 0 }] } }), '{"a":{"c":[3,{"e":0,"f":1}],"d":2},"b":1}');
    assert.notEqual(canonicalDigest({ a: { b: 1 } }), canonicalDigest({ a: { b: 2 } }));
    assert.throws(() => canonicalJson({ a: Number.NaN }), /non-finite/);
    assert.throws(() => canonicalJson({ a: new Date(0) }), /non-plain/);
});

test('cache-v4 keys: unchanged inputs give identical full-length seed and agent keys', (t) => {
    const root = tempRoot(t);
    const agentLib = makeAgentLib(root);
    const first = plans(t, { agentLib });
    const second = plans(t, { agentLib });
    assert.match(first.seed.inputKey, /^[0-9a-f]{64}$/);
    assert.match(first.agent.inputKey, /^[0-9a-f]{64}$/);
    assert.equal(first.seed.inputKey, second.seed.inputKey);
    assert.equal(first.agent.inputKey, second.agent.inputKey);
    assert.notEqual(first.seed.inputKey, first.agent.inputKey);
    assert.equal(first.seed.contract.agent, undefined, 'seed contract carries no agent package or rebuild token');
});

test('cache-v4 keys: a nested-only manifest change changes the key', (t) => {
    const root = tempRoot(t);
    const agentLib = makeAgentLib(root);
    const a = plans(t, { agentLib, globalPackage: { ...GLOBAL, overrides: { foo: { bar: '1.0.0' } } } });
    const b = plans(t, { agentLib, globalPackage: { ...GLOBAL, overrides: { foo: { bar: '2.0.0' } } } });
    assert.notEqual(a.seed.inputKey, b.seed.inputKey);
    assert.notEqual(a.agent.inputKey, b.agent.inputKey);
});

test('cache-v4 keys: the immutable image ID, not the tag, identifies container inputs', (t) => {
    const root = tempRoot(t);
    const agentLib = makeAgentLib(root);
    const ids = { 'node:20': IMAGE_A };
    const inspect = ({ image }) => ids[image];
    const first = containerToolchainIdentity({ runtime: 'podman', image: 'node:20', inspectImage: inspect });
    ids['node:20'] = IMAGE_B;
    const repulled = containerToolchainIdentity({ runtime: 'podman', image: 'node:20', inspectImage: inspect });
    const keyFor = (toolchain) => buildSeedInstallPlan({
        provider: containerProvider({ imageId: toolchain.identity.imageId, agentLib }), globalPackage: GLOBAL, agentLibSelection: agentLib,
    }).inputKey;
    assert.notEqual(keyFor(first), keyFor(repulled), 'same tag, new image ID -> new key');
    assert.equal(first.diagnostics.imageReference, 'node:20');
    assert.equal(JSON.stringify(first.identity).includes('node:20'), false, 'the tag is not part of the identity');
    // Profile/catalog selections that pick different tags for the same image share the key.
    ids['profile-tag'] = IMAGE_B;
    const viaProfile = containerToolchainIdentity({ runtime: 'podman', image: 'profile-tag', inspectImage: inspect });
    assert.equal(keyFor(viaProfile), keyFor(repulled));
    // A catalog selection that resolves to a different image changes the key.
    ids['catalog-tag'] = IMAGE_A;
    assert.notEqual(keyFor(containerToolchainIdentity({ runtime: 'podman', image: 'catalog-tag', inspectImage: inspect })), keyFor(repulled));
    // Podman's bare hex is normalized; a tag alone is rejected as identity.
    assert.equal(normalizeImageId('a'.repeat(64)), IMAGE_A);
    assert.throws(() => containerToolchainIdentity({ runtime: 'podman', image: 'node:20', inspectImage: () => 'node:20' }),
        { code: 'PLOINKY_DEPS_IMAGE_IDENTITY_REQUIRED' });
    assert.throws(() => containerProvider({ imageId: 'node:20', agentLib }), { code: 'PLOINKY_DEPS_IMAGE_IDENTITY_REQUIRED' });
});

test('cache-v4 keys: the engine is part of the container identity', (t) => {
    const root = tempRoot(t);
    const agentLib = makeAgentLib(root);
    const podman = buildSeedInstallPlan({ provider: containerProvider({ imageId: IMAGE_A, agentLib }), globalPackage: GLOBAL, agentLibSelection: agentLib });
    const docker = buildSeedInstallPlan({ provider: containerProvider({ imageId: IMAGE_A, engine: 'docker', agentLib }), globalPackage: GLOBAL, agentLibSelection: agentLib });
    assert.notEqual(podman.inputKey, docker.inputKey);
});

test('cache-v4 keys: agent package bytes and scripts change the agent key only', (t) => {
    const root = tempRoot(t);
    const agentLib = makeAgentLib(root);
    const base = plans(t, { agentLib });
    const script = plans(t, { agentLib, agentPackage: agentPackage({ name: 'agent', dependencies: { chalk: '5.0.0' }, scripts: { postinstall: 'node build.js' } }) });
    const dep = plans(t, { agentLib, agentPackage: agentPackage({ name: 'agent', dependencies: { chalk: '5.1.0' } }) });
    assert.notEqual(base.agent.inputKey, script.agent.inputKey);
    assert.notEqual(base.agent.inputKey, dep.agent.inputKey);
    assert.equal(base.seed.inputKey, script.seed.inputKey);
    assert.equal(base.seed.inputKey, dep.seed.inputKey);
    const moved = plans(t, { agentLib, agentPackage: agentPackage({ name: 'agent', dependencies: { chalk: '5.0.0' } }, 'repo/agent/package.json') });
    assert.notEqual(base.agent.inputKey, moved.agent.inputKey, 'package source/code selection is keyed');
});

test('cache-v4 keys: current merge semantics are preserved (agent optional/peer fields stay dropped)', (t) => {
    const root = tempRoot(t);
    const agentLib = makeAgentLib(root);
    const { agent } = plans(t, {
        agentLib,
        agentPackage: agentPackage({ name: 'agent', dependencies: { a: '1.0.0' }, optionalDependencies: { b: '1.0.0' }, peerDependencies: { c: '1.0.0' }, overrides: { d: '1.0.0' } }),
    });
    assert.deepEqual(Object.keys(agent.installManifest.dependencies).sort(), ['a', 'left-pad', 'mcp-sdk']);
    assert.equal(agent.installManifest.optionalDependencies, undefined);
    assert.equal(agent.installManifest.peerDependencies, undefined);
    assert.equal(agent.installManifest.overrides, undefined);
    assert.equal(agent.installManifest.name, 'agent');
});

test('cache-v4 keys: reserved AgentLib declarations are rejected before keying', (t) => {
    assert.throws(() => plans(t, { agentPackage: agentPackage({ name: 'agent', dependencies: { achillesAgentLib: '1.0.0' } }) }),
        { code: 'PLOINKY_AGENTLIB_RESERVED_DEPENDENCY' });
});

test('cache-v4 keys: SDK bundle identity is keyed and in-Box SDK declarations are removed', (t) => {
    const root = tempRoot(t);
    const agentLib = makeAgentLib(root);
    const none = plans(t, { agentLib });
    const one = plans(t, { agentLib, sdkBundle: sdkBundle('c'.repeat(64)) });
    const two = plans(t, { agentLib, sdkBundle: sdkBundle('e'.repeat(64)) });
    assert.notEqual(one.seed.inputKey, two.seed.inputKey);
    assert.notEqual(one.agent.inputKey, two.agent.inputKey);
    assert.notEqual(none.seed.inputKey, one.seed.inputKey);
    assert.equal(one.seed.installManifest.dependencies['mcp-sdk'], undefined, 'bundled SDK removed before install/pinning');
    assert.equal(none.seed.installManifest.dependencies['mcp-sdk'], `git+${SDK_URL}#main`);
    assert.equal(one.seed.gitEntries.length, 0, 'removed SDK is not a pin input');
    assert.throws(() => buildSeedInstallPlan({ provider: hostProvider({ agentLib }), globalPackage: GLOBAL, sdkBundle: sdkBundle(), agentLibSelection: agentLib }),
        { code: 'PLOINKY_DEPS_PROVIDER_MISMATCH' });
});

test('cache-v4 keys: AgentLib fingerprint and actual link target are keyed', (t) => {
    const root = tempRoot(t);
    const base = makeAgentLib(root, { name: 'lib-a' });
    const refingerprinted = { ...base, fingerprint: 'fp-2' };
    const relocated = makeAgentLib(root, { name: 'lib-b' });
    const a = plans(t, { agentLib: base });
    const b = plans(t, { agentLib: refingerprinted });
    const c = plans(t, { agentLib: relocated });
    assert.notEqual(a.seed.inputKey, b.seed.inputKey);
    assert.notEqual(a.seed.inputKey, c.seed.inputKey, 'seatbelt link target is the host source path');
    assert.equal(a.seed.providers.agentLib.linkTarget, base.sourceDir);
    // Container links target the stable mount; the host path is not part of the key there.
    const containerA = buildSeedInstallPlan({ provider: containerProvider({ imageId: IMAGE_A, agentLib: base }), globalPackage: GLOBAL, agentLibSelection: base });
    const relocatedSameBytes = { ...relocated, fingerprint: base.fingerprint };
    const containerC = buildSeedInstallPlan({ provider: containerProvider({ imageId: IMAGE_A, agentLib: relocatedSameBytes }), globalPackage: GLOBAL, agentLibSelection: relocatedSameBytes });
    assert.equal(containerA.providers.agentLib.linkTarget, '/opt/ploinky-agentlib');
    assert.equal(containerA.inputKey, containerC.inputKey);
    assert.throws(() => hostProvider({ agentLib: { ...base, fingerprint: '' } }), { code: 'PLOINKY_DEPS_AGENTLIB_IDENTITY_MISSING' });
});

test('cache-v4 keys: host toolchain and explicit npm policy are keyed; credentials are not', (t) => {
    const root = tempRoot(t);
    const agentLib = makeAgentLib(root);
    const key = (options) => plans(t, { agentLib, providerOptions: options }).seed.inputKey;
    const base = key({});
    assert.notEqual(base, key({ probe: hostProbe({ node: { ...hostProbe().node, version: '25.9.0' } }) }));
    assert.notEqual(base, key({ probe: hostProbe({ npm: { ...hostProbe().npm, version: '11.12.0' } }) }));
    assert.notEqual(base, key({ probe: hostProbe({ tools: { ...hostProbe().tools, python3: { realpath: '/usr/bin/python3', size: 1, mtimeMs: 1 } } }) }));
    assert.notEqual(base, key({ npmSources: { env: { npm_config_registry: 'https://mirror.example/' }, files: [] } }));
    assert.notEqual(base, key({ npmSources: { env: { NODE_ENV: 'production' }, files: [] } }));
    assert.notEqual(base, key({ npmSources: { env: {}, files: [{ path: '/u/.npmrc', text: 'omit[]=optional\n' }] } }));
    const tokenA = key({ npmSources: { env: {}, files: [{ path: '/u/.npmrc', text: '//registry.npmjs.org/:_authToken=secret-token-one\n' }] } });
    const tokenB = key({ npmSources: { env: {}, files: [{ path: '/u/.npmrc', text: '//registry.npmjs.org/:_authToken=secret-token-two\n' }] } });
    assert.equal(tokenA, base, 'credentials are transport-only');
    assert.equal(tokenB, base);
    const resolved = resolveHostNpmPolicy({ env: {}, files: [{ path: '/u/.npmrc', text: '//registry.npmjs.org/:_authToken=secret-token-one\n' }] });
    assert.equal(JSON.stringify(resolved.policy).includes('secret-token'), false);
    assert.deepEqual(resolved.transport.npmrcLines, ['//registry.npmjs.org/:_authToken=secret-token-one']);
    assert.throws(() => resolveHostNpmPolicy({ env: { npm_config_script_shell: '/bin/zsh' }, files: [] }), { code: 'PLOINKY_DEPS_NPM_POLICY_UNREPRESENTABLE' });
    assert.throws(() => resolveHostNpmPolicy({ env: {}, files: [{ path: '/u/.npmrc', text: 'node-options=--require /x.js\n' }] }), { code: 'PLOINKY_DEPS_NPM_POLICY_UNREPRESENTABLE' });
    assert.throws(() => resolveHostNpmPolicy({ env: { npm_config_registry: 'https://user:pw@mirror.example/' }, files: [] }), { code: 'PLOINKY_DEPS_NPM_POLICY_UNREPRESENTABLE' });
    assert.equal(key({ npmSources: { env: { npm_config_loglevel: 'silly', npm_config_fund: 'false' }, files: [] } }), base, 'output-only settings are ignored');
    assert.throws(() => hostProvider({ agentLib, probe: hostProbe({ arch: 'x64' }) }), { code: 'PLOINKY_DEPS_RUNTIME_KEY_MISMATCH' });
});

test('cache-v4 keys: container npm policy records the argv the container script actually runs', () => {
    const policy = containerNpmPolicy();
    assert.equal(policy.source, 'image');
    assert.deepEqual(policy.args, NPM_INSTALL_ARGS);
    const script = buildContainerInstallScript();
    assert.ok(script.includes(`npm ${policy.args.map((arg) => `'${arg}'`).join(' ')};`), script);
    assert.deepEqual(NPM_BASE_INSTALL_ARGS, [...NPM_INSTALL_ARGS, '--update-notifier=false'], 'host argv = legacy argv + disabled notifier');
});

test('cache-v4 keys: remote-verified pins change keys; observed-at-install and changed specs do not', (t) => {
    const root = tempRoot(t);
    const agentLib = makeAgentLib(root);
    const url = 'git+file:///srv/remote.git';
    const globalPackage = { ...GLOBAL, dependencies: { tool: `${url}#main` } };
    const [entry] = collectGitInputs(globalPackage, { scope: 'global' }).entries;
    const pinned = (commit, verification) => ({ [entry.pinId]: buildPin(entry, { commit, verification }) });
    const unpinned = plans(t, { agentLib, globalPackage });
    const observed = plans(t, { agentLib, globalPackage, pinState: pinned('1'.repeat(40), PIN_VERIFICATION.observed) });
    const verifiedA = plans(t, { agentLib, globalPackage, pinState: pinned('1'.repeat(40), PIN_VERIFICATION.remote) });
    const verifiedB = plans(t, { agentLib, globalPackage, pinState: pinned('2'.repeat(40), PIN_VERIFICATION.remote) });
    assert.equal(unpinned.seed.inputKey, observed.seed.inputKey, 'provenance-only records keep the first-start key stable');
    assert.notEqual(unpinned.seed.inputKey, verifiedA.seed.inputKey);
    assert.notEqual(verifiedA.seed.inputKey, verifiedB.seed.inputKey);
    assert.equal(verifiedA.seed.installManifest.dependencies.tool, `${url}#${'1'.repeat(40)}`, 'desired pin rewritten to the full SHA');
    assert.equal(verifiedA.seed.expectedGit[0].commit, '1'.repeat(40));
    // A different original spec never inherits another input's pin.
    const changedSpec = { ...GLOBAL, dependencies: { tool: `${url}#dev` } };
    const inherited = plans(t, { agentLib, globalPackage: changedSpec, pinState: pinned('1'.repeat(40), PIN_VERIFICATION.remote) });
    assert.equal(inherited.seed.installManifest.dependencies.tool, `${url}#dev`);
    assert.equal(inherited.seed.contract.global.pins.length, 0);
});

test('cache-v4 keys: the rebuild token changes only the agent key', (t) => {
    const root = tempRoot(t);
    const agentLib = makeAgentLib(root);
    const before = plans(t, { agentLib });
    const after = plans(t, { agentLib, rebuildToken: 'rebuild-1' });
    assert.notEqual(before.agent.inputKey, after.agent.inputKey);
    assert.equal(before.seed.inputKey, after.seed.inputKey);
});

test('cache-v4 keys: seed copies are allowed only for exact contracts without an npm run', (t) => {
    const root = tempRoot(t);
    const agentLib = makeAgentLib(root);
    const withoutPackage = plans(t, { agentLib, agentPackage: null });
    assert.deepEqual(seedCopyEligibility(withoutPackage.agent, withoutPackage.seed), { eligible: true, reason: 'exact seed contract' });
    assert.equal(seedCopyEligibility(withoutPackage.agent, withoutPackage.seed, { reinstall: true }).eligible, false);
    const withPackage = plans(t, { agentLib });
    assert.equal(seedCopyEligibility(withPackage.agent, withPackage.seed).eligible, false);
    const otherLib = makeAgentLib(root, { name: 'other', fingerprint: 'fp-9' });
    const otherSeed = buildSeedInstallPlan({ provider: hostProvider({ agentLib: otherLib }), globalPackage: GLOBAL, agentLibSelection: otherLib });
    assert.equal(seedCopyEligibility(withoutPackage.agent, otherSeed).reason, 'provider contract differs');
});

test('cache-v4 keys: agent package source follows code/ precedence', (t) => {
    const root = tempRoot(t);
    const agent = path.join(root, 'repo', 'agent');
    fs.mkdirSync(agent, { recursive: true });
    fs.writeFileSync(path.join(agent, 'package.json'), '{"name":"root"}');
    assert.equal(readAgentPackageSource(agent, { relativeTo: root }).manifest.name, 'root');
    fs.mkdirSync(path.join(agent, 'code'));
    const codeWithout = readAgentPackageSource(agent, { relativeTo: root });
    assert.equal(codeWithout.selection, 'code');
    assert.equal(codeWithout.manifest, null, 'an existing code/ directory hides the root package.json');
    fs.writeFileSync(path.join(agent, 'code', 'package.json'), '{"name":"code"}');
    const code = readAgentPackageSource(agent, { relativeTo: root });
    assert.equal(code.relativePath, 'repo/agent/code/package.json');
    assert.match(code.sha256, /^[0-9a-f]{64}$/);
});

test('cache-v4 keys: the cache-v4 entry module exposes the integration API', () => {
    for (const name of ['buildSeedInstallPlan', 'buildAgentInstallPlan', 'createCacheStore', 'createHostNpmInstaller',
        'createContainerNpmInstaller', 'discoverGitPins', 'mergeDiscoveredPins', 'resolveHostNpmPolicy', 'containerToolchainIdentity']) {
        assert.equal(typeof cacheV4[name], 'function', name);
    }
});
