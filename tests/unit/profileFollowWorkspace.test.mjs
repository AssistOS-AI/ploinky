import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// AC1b-AC3 and the profile rules behind them: records and enable pins that name
// an environment follow the workspace profile, role pins stay explicit, and the
// existing profileChanged logic rotates the identity of an out-of-graph record.

const cwd = process.cwd();
const savedEnv = { ...process.env };
const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-profile-follow-')));
test.after(() => {
    process.chdir(cwd);
    for (const name of Object.keys(process.env)) {
        if (!Object.hasOwn(savedEnv, name)) delete process.env[name];
    }
    Object.assign(process.env, savedEnv);
    fs.rmSync(workspace, { recursive: true, force: true });
});
process.chdir(workspace);
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
process.env.PLOINKY_MASTER_KEY = randomUUID().replaceAll('-', '').padEnd(64, 'b');
fs.writeFileSync('.env', '');

const { followWorkspaceProfile, ENVIRONMENT_PROFILES, isEnvironmentProfile } = await import('../../cli/utils/runtime/profileFollow.mjs');
const profileService = await import('../../cli/utils/runtime/profileService.js');
const { resolveWorkspaceDependencyGraph } = await import('../../cli/utils/workspaceDependencyGraph.js');
const workspaceUtil = await import('../../cli/commands/workspaceUtil.js');
const structure = await import('../../cli/utils/workspaceStructure.js');
const dockerCommon = await import('../../cli/sandbox/docker/common.js');
const agents = await import('../../cli/utils/agents.js');
const { parseStartArgs } = await import('../../cli/utils/repos.js');

const { ensureGraphNodesEnabled, resolveExtraEnabledRuntimeNodes } = workspaceUtil;
const containerOf = (name) => dockerCommon.getAgentContainerName(name, 'repo');
const codeIs = (code) => (error) => error?.code === code;

function writeAgent(name, manifest) {
    const dir = path.join(workspace, '.ploinky', 'repos', 'repo', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ container: 'node:20-alpine', ...manifest }, null, 2));
}

const FULL = { default: {}, dev: {}, qa: {}, prod: {} };
// The static agent enables a dependency pinned to the `default` environment, a
// role-pinned one, and one pinned to `qa`.
writeAgent('static', {
    profiles: FULL,
    enable: [
        { agent: 'repo/dep', profile: 'default' },
        { agent: 'repo/rolepinned', profile: 'embedded' },
        { agent: 'repo/qapinned', profile: 'qa' },
    ],
});
writeAgent('dep', { profiles: FULL });
writeAgent('rolepinned', { profiles: { ...FULL, embedded: {} } });
writeAgent('qapinned', { profiles: FULL });
writeAgent('extra', { profiles: FULL });
writeAgent('defaultonly', { profiles: { default: {} } });
writeAgent('noprod', { profiles: { default: {}, qa: {} } });
writeAgent('legacy', {});
writeAgent('rolerecord', { profiles: { ...FULL, embedded: {} } });

function record(name, profile, extra = {}) {
    return {
        type: 'agent',
        repoName: 'repo',
        agentName: name,
        runMode: agents.DEFAULT_ENABLE_AGENT_MODE,
        projectPath: structure.getAgentDataDir(name),
        profile,
        instanceId: `${name}-old-instance`,
        enableGeneration: `${name}-old-generation`,
        auth: { mode: 'none' },
        ...extra,
    };
}

function registryOf(profiles) {
    const reg = {};
    for (const [name, profile] of Object.entries(profiles)) reg[containerOf(name)] = record(name, profile);
    return reg;
}

let mintedIdentities = 0;

// Runs the staging of a workspace start with every engine effect replaced.
function stage(reg, { workspaceProfile, prod = false, staticAgent = 'repo/static' }) {
    const graph = resolveWorkspaceDependencyGraph({ staticAgentRef: staticAgent, registry: reg, workspaceProfile, prod });
    const { nodes: additionalNodes } = resolveExtraEnabledRuntimeNodes(
        graph, reg, dockerCommon.getAgentContainerName, { workspaceProfile, prod },
    );
    const removed = [];
    const lines = [];
    const prepared = ensureGraphNodesEnabled(graph, reg, {
        additionalNodes,
        uuid: () => `fresh-${(mintedIdentities += 1)}`,
        prepareAgentEnableBatch: () => ({ plans: [], preparedGeneration: { selector: { state: 'inactive' } } }),
        saveAgents() {},
        loadRouting: () => ({ routes: {} }),
        saveRouting() {},
        inactivateGeneration() {},
        retireNoWaitMarkers() {},
        readRuntimePredecessorImpl: () => null,
        writeRuntimePredecessorImpl: () => ({}),
        retireRuntimePredecessorImpl() {},
        runtimeReplacementReason: () => '',
        removeAgentContainerForRecreate: (key, reason) => removed.push({ key, reason }),
        executionRecordOptions: { workspaceRoot: workspace },
        logLine: (line) => lines.push(line),
    });
    return { graph, additionalNodes, prepared, removed, lines };
}

test('the environment names are exactly default, dev, qa and prod', () => {
    assert.deepEqual([...ENVIRONMENT_PROFILES], ['default', 'dev', 'qa', 'prod']);
    for (const name of ENVIRONMENT_PROFILES) assert.equal(isEnvironmentProfile(name), true);
    for (const name of ['embedded', 'explorer', 'staging', '', 'PROD2']) assert.equal(isEnvironmentProfile(name), false);
    assert.equal(isEnvironmentProfile(' QA '), true);
});

test('followWorkspaceProfile: roles stay, environment names follow, legacy stays empty, PROD is strict', () => {
    const full = { profiles: FULL };
    const noQa = { profiles: { default: {}, prod: {} } };
    const none = {};
    // Role pins never change.
    assert.equal(followWorkspaceProfile(full, 'embedded', 'qa'), 'embedded');
    assert.equal(followWorkspaceProfile({ profiles: { ...FULL, embedded: {} } }, 'embedded', 'prod', { prod: true }), 'embedded');
    // Environment names follow the workspace when declared, else default.
    assert.equal(followWorkspaceProfile(full, 'default', 'qa'), 'qa');
    assert.equal(followWorkspaceProfile(full, 'qa', 'prod'), 'prod');
    assert.equal(followWorkspaceProfile(full, 'prod', 'default'), 'default');
    assert.equal(followWorkspaceProfile(noQa, 'default', 'qa'), 'default');
    assert.equal(followWorkspaceProfile(none, 'qa', 'prod'), 'default');
    // A legacy record without a profile is left alone, so a default workspace
    // does not rotate it; under PROD it must resolve to the workspace profile.
    assert.equal(followWorkspaceProfile(full, '', 'default'), '');
    assert.equal(followWorkspaceProfile(full, undefined, 'qa'), '');
    assert.equal(followWorkspaceProfile(full, '', 'prod', { prod: true }), 'prod');
    // Under PROD an agent without `prod` refuses, whatever the record says.
    const noProd = { profiles: { default: {}, qa: {} } };
    for (const record of ['default', 'prod', '']) {
        assert.throws(
            () => followWorkspaceProfile(noProd, record, 'prod', { prod: true, agentRef: 'repo/x' }),
            codeIs('PLOINKY_PROFILE_NOT_FOUND'),
            JSON.stringify(record),
        );
    }
    assert.throws(() => followWorkspaceProfile(none, 'default', 'prod', { prod: true }), codeIs('PLOINKY_PROFILE_NOT_FOUND'));
    // A `prod` that is null, or `profiles` that is an array, declares nothing.
    assert.throws(
        () => followWorkspaceProfile({ profiles: { default: {}, prod: null } }, 'default', 'prod', { prod: true }),
        codeIs('PLOINKY_PROFILE_NOT_FOUND'),
    );
    assert.throws(
        () => followWorkspaceProfile({ profiles: [] }, 'default', 'prod', { prod: true }),
        codeIs('PLOINKY_PROFILE_NOT_FOUND'),
    );
    // Without PROD a null profile falls back to default instead of being followed.
    assert.equal(followWorkspaceProfile({ profiles: { default: {}, qa: null } }, 'default', 'qa'), 'default');
});

test('AC2: workspace profile names are the four, valid with zero installed manifests', () => {
    assert.equal(fs.existsSync(path.join(workspace, '.ploinky', 'profile')), false);
    assert.deepEqual(profileService.getValidProfiles(), ['default', 'dev', 'qa', 'prod']);
    const emptyWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-profile-names-'));
    try {
        // The fresh-workspace case: `ploinky start explorer --profile prod` runs
        // before any repository exists.
        assert.equal(parseStartArgs(['explorer', '--profile', 'PROD']).profile, 'prod');
        const savedRepos = fs.readdirSync(path.join(workspace, '.ploinky', 'repos'));
        fs.renameSync(path.join(workspace, '.ploinky', 'repos'), path.join(emptyWorkspace, 'repos'));
        try {
            for (const name of ['prod', 'qa', 'dev', 'default']) {
                assert.equal(profileService.setActiveProfile(name).success, true, name);
                assert.equal(profileService.getActiveProfile(), name);
            }
            assert.equal(profileService.setActiveProfile(' PROD ').success, true);
            assert.equal(profileService.getActiveProfile(), 'prod');
        } finally {
            fs.renameSync(path.join(emptyWorkspace, 'repos'), path.join(workspace, '.ploinky', 'repos'));
        }
        assert.ok(savedRepos.length > 0);
    } finally {
        fs.rmSync(emptyWorkspace, { recursive: true, force: true });
        fs.rmSync(path.join(workspace, '.ploinky', 'profile'), { force: true });
    }
});

test('AC2: roles and unknown names are not workspace profiles', () => {
    for (const bad of ['embedded', 'explorer', 'staging', '', '   ']) {
        const result = profileService.setActiveProfile(bad);
        assert.equal(result.success, false, JSON.stringify(bad));
    }
    assert.equal(profileService.isValidProfile('embedded'), false);
    assert.equal(profileService.isValidProfile('qa'), true);
});

test('a stored role or unknown profile name yields default and one warning per process', () => {
    const file = path.join(workspace, '.ploinky', 'profile');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'embedded');
    const warnings = [];
    const original = console.error;
    console.error = (...args) => warnings.push(args.join(' '));
    try {
        assert.equal(profileService.getActiveProfile(), 'default');
        assert.equal(profileService.getActiveProfile(), 'default');
    } finally {
        console.error = original;
        fs.rmSync(file, { force: true });
    }
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /'embedded'/);
});

test('AC3: an enable pin naming an environment follows the workspace profile; role pins stay', () => {
    for (const workspaceProfile of ['qa', 'prod', 'default']) {
        const graph = resolveWorkspaceDependencyGraph({ staticAgentRef: 'repo/static', workspaceProfile });
        const profileOf = (name) => [...graph.nodes.values()].find((node) => node.shortAgentName === name);
        assert.equal(profileOf('static').profile, workspaceProfile);
        // `"profile":"default"` pins (bizanso and scriptahub style) and a `qa` pin.
        assert.equal(profileOf('dep').profile, workspaceProfile, `dep under ${workspaceProfile}`);
        assert.equal(profileOf('dep').profileExplicit, false);
        assert.equal(profileOf('qapinned').profile, workspaceProfile, `qapinned under ${workspaceProfile}`);
        // A role pin is an explicit selection.
        assert.equal(profileOf('rolepinned').profile, 'embedded');
        assert.equal(profileOf('rolepinned').profileExplicit, true);
    }
});

test('AC3: under PROD a node without the prod profile stops the graph, even as a tolerated dependency', () => {
    writeAgent('prodstatic', { profiles: FULL, enable: ['repo/noprod'] });
    const unresolved = [];
    assert.throws(
        () => resolveWorkspaceDependencyGraph({
            staticAgentRef: 'repo/prodstatic', workspaceProfile: 'prod', prod: true,
            onUnresolvedDependency: (report) => unresolved.push(report),
        }),
        codeIs('PLOINKY_PROFILE_NOT_FOUND'),
    );
    assert.deepEqual(unresolved, []);
    // Without PROD the same graph falls back to default for that node.
    const graph = resolveWorkspaceDependencyGraph({ staticAgentRef: 'repo/prodstatic', workspaceProfile: 'prod' });
    assert.equal([...graph.nodes.values()].find((node) => node.shortAgentName === 'noprod').profile, 'default');
});

test('AC1b: a profile switch rotates the identity of graph and out-of-graph records and keeps role pins', () => {
    const reg = registryOf({
        static: 'default', dep: 'default', rolepinned: 'embedded', qapinned: 'default',
        extra: 'default', rolerecord: 'embedded', legacy: '',
    });
    delete reg[containerOf('legacy')].profile;
    const before = structuredClone(reg);

    const qa = stage(reg, { workspaceProfile: 'qa' });
    // Graph nodes.
    for (const name of ['static', 'dep', 'qapinned']) assert.equal(reg[containerOf(name)].profile, 'qa', name);
    assert.equal(reg[containerOf('rolepinned')].profile, 'embedded');
    // The out-of-graph record follows the workspace at the single change site.
    const extraNode = qa.additionalNodes.find((node) => node.shortAgentName === 'extra');
    assert.equal(extraNode.profile, 'qa');
    assert.equal(reg[containerOf('extra')].profile, 'qa');
    assert.notEqual(reg[containerOf('extra')].instanceId, before[containerOf('extra')].instanceId);
    assert.notEqual(reg[containerOf('extra')].enableGeneration, before[containerOf('extra')].enableGeneration);
    // The old-profile container is removed through the existing profileChanged path.
    const removedKeys = qa.removed.map((entry) => entry.key);
    assert.ok(removedKeys.includes(containerOf('extra')), JSON.stringify(qa.removed));
    assert.match(qa.removed.find((entry) => entry.key === containerOf('extra')).reason, /profileChanged/);
    // A role-pinned out-of-graph record keeps its role and its identity.
    assert.equal(reg[containerOf('rolerecord')].profile, 'embedded');
    assert.equal(reg[containerOf('rolerecord')].instanceId, before[containerOf('rolerecord')].instanceId);
    assert.equal(removedKeys.includes(containerOf('rolerecord')), false);
    // A legacy record without a profile is not rotated under a non-PROD workspace.
    assert.equal(reg[containerOf('legacy')].instanceId, before[containerOf('legacy')].instanceId);
    assert.equal(removedKeys.includes(containerOf('legacy')), false);

    // The same workspace again changes nothing.
    const again = stage(reg, { workspaceProfile: 'qa' });
    assert.deepEqual(again.removed, []);

    // Then PROD: every environment-named record follows to prod, role pins stay.
    // Under PROD every agent must declare `prod`, so the profile-less manifest
    // gets the four profiles first.
    writeAgent('legacy', { profiles: FULL });
    const prodStart = structuredClone(reg);
    const prod = stage(reg, { workspaceProfile: 'prod', prod: true, staticAgent: 'repo/static' });
    for (const name of ['static', 'dep', 'qapinned', 'extra']) assert.equal(reg[containerOf(name)].profile, 'prod', name);
    assert.equal(reg[containerOf('rolepinned')].profile, 'embedded');
    assert.equal(reg[containerOf('rolerecord')].profile, 'embedded');
    // Under PROD an empty legacy record resolves to the workspace profile too.
    assert.equal(reg[containerOf('legacy')].profile, 'prod');
    assert.notEqual(reg[containerOf('extra')].instanceId, prodStart[containerOf('extra')].instanceId);
    assert.ok(prod.removed.map((entry) => entry.key).includes(containerOf('extra')));
    assert.ok(prod.removed.map((entry) => entry.key).includes(containerOf('legacy')));
});

test('AC1b: the snapshot classifiers see record profile equal to the resolved profile and never read .ploinky/profile', () => {
    const reg = registryOf({ extra: 'default', rolerecord: 'embedded' });
    stage(reg, { workspaceProfile: 'prod', prod: true });
    // The classifiers resolve the persisted profile against the captured
    // manifest with a fixed `default` fallback.
    const profileFile = path.join(workspace, '.ploinky', 'profile');
    fs.writeFileSync(profileFile, 'qa');
    try {
        for (const name of ['extra', 'rolerecord']) {
            const rec = reg[containerOf(name)];
            const manifest = JSON.parse(fs.readFileSync(path.join(workspace, '.ploinky', 'repos', 'repo', name, 'manifest.json'), 'utf8'));
            const resolution = profileService.resolveManifestRuntimeProfile(manifest, {
                agentName: `repo/${name}`,
                persistedProfileName: rec.profile,
                fallbackProfileName: 'default',
            });
            assert.equal(resolution.resolvedProfileName, rec.profile, name);
        }
    } finally {
        fs.rmSync(profileFile, { force: true });
    }
    // None of the four classifier sources consults the workspace profile.
    const root = fileURLToPath(new URL('../../cli/', import.meta.url));
    for (const file of ['server/noWaitAgentStartupState.js', 'sandbox/agentRuntimeState.js', 'sandbox/edgeGeneration.js', 'server/edgeRoutePlan.js']) {
        const source = fs.readFileSync(path.join(root, file), 'utf8');
        assert.equal(/getActiveProfile|PROFILE_FILE/.test(source), false, file);
    }
});

test('AC1b: under PROD an out-of-graph record whose agent has no prod profile refuses the start', () => {
    const reg = registryOf({ noprod: 'default' });
    assert.throws(() => stage(reg, { workspaceProfile: 'prod', prod: true }), codeIs('PLOINKY_PROFILE_NOT_FOUND'));
});

test('enable: an operator-supplied per-agent environment that differs from the workspace refuses; a role is allowed', () => {
    const rules = (authOptions, options) => agents.assertEnableProfileRules(
        { agentName: 'repo/extra', authOptions }, options,
    );
    assert.throws(
        () => rules({ profile: 'qa' }, { workspaceProfile: 'default', prod: false }),
        codeIs('PLOINKY_PROFILE_ENVIRONMENT_SCOPE'),
    );
    assert.doesNotThrow(() => rules({ profile: 'qa' }, { workspaceProfile: 'qa', prod: false }));
    assert.doesNotThrow(() => rules({}, { workspaceProfile: 'qa', prod: false }));
    assert.doesNotThrow(() => rules({ profile: 'embedded' }, { workspaceProfile: 'qa', prod: false }));
    // Under PROD an agent without `prod` refuses; one with it passes.
    assert.throws(
        () => agents.assertEnableProfileRules({ agentName: 'repo/noprod', authOptions: {} }, { workspaceProfile: 'prod', prod: true }),
        codeIs('PLOINKY_PROFILE_NOT_FOUND'),
    );
    assert.doesNotThrow(() => rules({}, { workspaceProfile: 'prod', prod: true }));
    assert.throws(() => agents.assertEnableProfileRules(
        { agentName: 'repo/does-not-exist', authOptions: {} }, { workspaceProfile: 'prod', prod: true },
    ), codeIs('PLOINKY_AGENT_SOURCE_MISSING'));
});


test('PROD rejects malformed profile shapes and missing explicit roles', () => {
    for (const profiles of [{ ...FULL, prod: null }, { ...FULL, default: [] }, { ...FULL, embedded: null }, FULL]) {
        assert.throws(() => followWorkspaceProfile({ profiles }, 'embedded', 'prod', { prod: true }), codeIs('PLOINKY_PROFILE_NOT_FOUND'));
    }
});

test('PROD graph rejects malformed dependency declarations even with tolerance', () => {
    for (const enable of [null, {}, [null], [{ agent: 'repo/dep', profile: 42 }]]) {
        writeAgent('badgraph', { profiles: FULL, enable });
        assert.throws(() => resolveWorkspaceDependencyGraph({ staticAgentRef: 'repo/badgraph', workspaceProfile: 'prod', prod: true, onUnresolvedDependency() {} }));
    }
});

test('preflight defers a declared new repository until acquisition and still checks its installed siblings', () => {
    writeAgent('bootstrap', { profiles: FULL, repos: { partner: 'https://example.test/partner.git' },
        enable: ['partner/newAgent', 'repo/dep'] });
    const options = { staticAgentRef: 'repo/bootstrap', workspaceProfile: 'prod', prod: true };
    const graph = resolveWorkspaceDependencyGraph({ ...options, deferMissingDeclaredRepos: true });
    assert.deepEqual([...graph.nodes.values()].map(node => node.agentRef).sort(), ['repo/bootstrap', 'repo/dep']);
    assert.throws(() => resolveWorkspaceDependencyGraph(options), /not found/);
    writeAgent('bootstrap', { profiles: FULL, enable: ['unknown/newAgent'] });
    assert.throws(() => resolveWorkspaceDependencyGraph({ ...options, deferMissingDeclaredRepos: true }), /not found/);
});
