import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createOwnedSettingsTarget, defaultSettingsEvidence, ownedSettingsLaunchURL,
    settingsCleanupBudget, settingsPolicyEvidence } from './deployed-settings-target.mjs';

// Guards for deployed-settings.mjs. They run on any host without a browser, a deployment, or credentials. The check
// itself stays unexecuted until the deployment gate (D1).
const script = fileURLToPath(new URL('./deployed-settings.mjs', import.meta.url));
const source = await fs.readFile(script, 'utf8');
const targetSource = await fs.readFile(new URL('./deployed-settings-target.mjs', import.meta.url), 'utf8');

test('C3 settings fixture never resolves the default robot as its mutation target', () => {
    assert.doesNotMatch(source, /const robotId = await roboTeamRobotId\(dashboard, 'default'\)/,
        'The existing default robot must not own C3 repository registration or settings writes.');
    assert.doesNotMatch(source, /args: \{ robot: 'default', sessionId \}/,
        'C3 conversation policy reads and writes must bind the newly owned robot.');
    assert.match(source, /ownedSettingsLaunchURL\(/,
        'C3 must launch its explicitly owned robot separately from the C1 default folder action.');
});

test('deployed-settings drives RoboTeam\'s Conversation skills page and no retired Explorer Settings selector', () => {
    for (const retired of ['settings-modal', 'copilotSettingsStatus', 'copilotSettingsList', 'toggleCopilotSkill',
        'getCopilotContext', 'explorer/index.html', 'copilot-robot', 'copilot-session', 'plugin-settings-row',
        "getByRole('tab'"]) {
        assert.ok(!source.includes(retired), `the retired Explorer Settings contract ${retired} must not remain`);
    }
    assert.match(source, /load\('conversation-skills'\)/, 'the Explorer smoke helper for the RoboTeam page must be loaded from the deployment');
    for (const name of ['conversationFromSkillsURL', 'roboTeamApi', 'roboTeamRobotId', 'openConversationSkills',
        'conversationSkillsState', 'setConversationSkill', 'refreshConversationSkills', 'ROBOTEAM_BASE_PATH']) {
        assert.ok(source.includes(name), `the check must use the helper ${name}`);
    }
});

test('deployed-settings keeps its preflight before any browser dependency is loaded', () => {
    const preflight = source.indexOf('await assertMarketplacePrerequisite()');
    assert.ok(preflight > 0);
    assert.ok(preflight < source.indexOf("require('@playwright/test')"));
    assert.ok(preflight < source.indexOf('chromium.launch'));
    assert.ok(source.indexOf('assertArtifactRoot(') > preflight && source.indexOf('assertExplorerSmokeDirectory(') > preflight);
});

test('deployed-settings fails before any write unless the user can administer robots, and cleans up what it created', () => {
    assert.match(source, /canAdmin === true/);
    const admin = source.indexOf('canAdmin === true');
    for (const write of ['await ownedTarget.create(', 'await createDirectory(', "tool: 'create_directory'", "tool: 'write_file'", 'await ownedTarget.register(']) {
        assert.ok(source.includes(write), `the check must contain the write ${write}`);
        assert.ok(admin < source.indexOf(write), `the admin check must precede every write, including ${write}`);
    }
    assert.match(targetSource, /skillsets\?name=/, 'the run-owned repository must be deleted by name');
    assert.ok(targetSource.indexOf('skillsets?name=') < targetSource.indexOf("operation: 'robot-delete'"));
    assert.ok(targetSource.indexOf("operation: 'robot-delete'") < targetSource.indexOf('await removeFolder('), 'the repository and robot are deleted before the folder');
    assert.match(targetSource, /registeredRepository/);
    assert.match(source, /process\.exitCode = 1/);
});

test('C3 keeps the source-defined cleanup grace and finite deadlines separate from composer and idle deadlines', () => {
    assert.match(source, /await readFile\(path.resolve\(here, '\.\.\/\.\.\/\.\.\/cli\/server\/handlers\/webchat\/runtimeState.js'\)/);
    assert.match(source, /cleanupBudget.operationTimeoutMs/);
    assert.match(source, /cleanupBudget.cleanupTimeoutMs/);
    assert.match(source, /cleanupPagesClosed = true/);
    assert.match(source, /signal: deadline.signal/);
    assert.match(source, /toBeEditable\(\{ timeout: 60_000 \}\)/);
    assert.match(source, /waitForWebchatIdle\(copilotPage, 60_000\)/);
    assert.ok(source.indexOf('evidence.cleanupPagesClosed = true') > source.indexOf('await copilotPage.close()'));
});

const runId = 'conversation-skills-1791060000000-a1b2c3d4';
const robotName = `c3-settings-${runId}`;
const repositoryName = 'set1-a1b2c3d4';
const workspaceRoot = '/selected/workspace';
const timestamp = '2026-10-04T00:00:00.000Z';
const defaultRobot = () => ({ id: 'default-123abc', name: 'default', codingAgents: ['opencode'],
    skillsets: [], skillRepositories: [], repositories: [{ id: 'copilot', source: '/code/copilot' }],
    createdAt: timestamp, updatedAt: timestamp, run: { state: 'stopped', queueDepth: 0, task: null } });
const defaultsCatalog = () => ({ robot: 'default', scope: 'defaults', sessionId: null, policyVersion: 1,
    policy: { version: 2, mode: 'live', selectors: { skillSets: ['copilot'], skills: ['copilot/launch-workflow'] },
        excludedSkills: [], excludedSources: [], excludedNames: [] } });

function ownedFixture({ createTransform = value => value, failRegistration = false, failDelete = false,
    failRobotDelete = false, retainRobot = false } = {}) {
    const calls = [];
    const inventory = [defaultRobot()];
    const api = async input => {
        calls.push(structuredClone(input));
        if ((input.method || 'GET') === 'GET') return { status: 200, payload: { canAdmin: true, robots: structuredClone(inventory) } };
        if (input.path === 'api/robots') {
            const robot = { ...defaultRobot(), id: 'owned-settings-123abc', name: input.body.name, codingAgents: input.body.codingAgents,
                repositories: [], createdAt: '2026-10-04T00:01:00.000Z' };
            const response = createTransform(robot);
            inventory.push(robot);
            return { status: 201, payload: { robot: response } };
        }
        const robot = inventory.find(item => item.name === robotName);
        if (input.method === 'POST' && input.path.endsWith('/skillsets')) {
            robot.repositories.push({ id: input.body.name, source: input.body.source });
            return { status: failRegistration ? 500 : 200, payload: { ok: true } };
        }
        if (input.method === 'DELETE') {
            if (failDelete) return { status: 500, payload: {} };
            robot.repositories = [];
            return { status: 200, payload: { ok: true } };
        }
        if (input.path === 'api/control') {
            if (failRobotDelete) return { status: 409, payload: {} };
            if (!retainRobot) inventory.splice(inventory.indexOf(robot), 1);
            return { status: 200, payload: { ok: true, deleted: robot.name } };
        }
        throw new Error('Unexpected fake API request.');
    };
    const target = createOwnedSettingsTarget({ runId, repositoryName, workspaceRoot, api });
    const steps = [];
    const cleanup = { pagesClosed: true, waitForDisconnect: async () => { steps.push('disconnect-drained'); },
        removeFolder: async () => { steps.push('folder-removed'); } };
    return { target, inventory, calls, steps, cleanup, writes: () => calls.filter(input => input.method && input.method !== 'GET') };
}

test('C3 owned target binds launch, registration and cleanup while preserving the existing default', async () => {
    const fixture = ownedFixture();
    const before = defaultSettingsEvidence(fixture.inventory[0], defaultsCatalog());
    const identity = await fixture.target.create();
    const launch = new URL(ownedSettingsLaunchURL('http://127.0.0.1:8080', identity));
    assert.equal(launch.pathname, '/webchat');
    assert.equal(launch.searchParams.get('robot'), robotName);
    assert.equal(launch.searchParams.get('workspace-dir'), runId);
    assert.equal(launch.searchParams.get('agent'), 'roboTeamAgent');
    assert.equal(launch.searchParams.get('forward-envelope'), '1');
    assert.throws(() => ownedSettingsLaunchURL(launch.origin, { ...identity, robotName: 'default' }), /exact newly owned/);
    await fixture.target.register();
    await fixture.target.cleanup(fixture.cleanup);
    assert.deepEqual(fixture.steps, ['disconnect-drained', 'folder-removed']);
    assert.deepEqual(fixture.writes().map(input => [input.method, input.path]), [
        ['POST', 'api/robots'], ['POST', `api/robots/${identity.robotId}/skillsets`],
        ['DELETE', `api/robots/${identity.robotId}/skillsets?name=${repositoryName}`], ['POST', 'api/control'],
    ]);
    assert.deepEqual(fixture.writes().at(-1).body, { operation: 'robot-delete', robotId: identity.robotId });
    assert.deepEqual(defaultSettingsEvidence(fixture.inventory[0], defaultsCatalog()), before);
    assert.equal(fixture.target.state.cleanup, 'owned-repository-robot-and-folder-deleted');
    assert.equal(fixture.target.state.robotRemoved, true);
});

test('C3 default preservation detects configuration, policy and registration drift without hashing arbitrary response fields', () => {
    const baseline = defaultSettingsEvidence(defaultRobot(), defaultsCatalog());
    for (const mutate of [robot => { robot.codingAgents = ['codex']; }, robot => { robot.updatedAt = '2026-10-04T00:02:00.000Z'; },
        robot => { robot.repositories.push({ id: repositoryName, source: '/wrong/source' }); },
        robot => { robot.skillsets.push({ name: repositoryName }); }]) {
        const changed = defaultRobot(); mutate(changed);
        assert.notDeepEqual(defaultSettingsEvidence(changed, defaultsCatalog()), baseline);
    }
    const policy = defaultsCatalog(); policy.policy.excludedSkills.push('copilot/launch-workflow');
    assert.notDeepEqual(defaultSettingsEvidence(defaultRobot(), policy), baseline);
    assert.deepEqual(defaultSettingsEvidence({ ...defaultRobot(), unrelatedResponseField: 'unrecorded' },
        { ...defaultsCatalog(), unrelatedResponseField: 'unrecorded' }), baseline);
    assert.throws(() => settingsPolicyEvidence(defaultsCatalog(), robotName), /another robot/);
    assert.throws(() => settingsPolicyEvidence({ ...defaultsCatalog(), robot: robotName }, robotName, 'session'), /conversation/);
});

test('C3 refuses an existing target name before creation and a returned preexisting default identity before registration', async () => {
    const existing = ownedFixture(); existing.inventory.push({ ...defaultRobot(), id: 'old-settings-123abc', name: robotName });
    await assert.rejects(existing.target.create(), /existing settings robot/);
    assert.equal(existing.writes().length, 0);
    const substituted = ownedFixture({ createTransform: robot => ({ ...robot, id: 'default-123abc' }) });
    await assert.rejects(substituted.target.create(), /preexisting robot ID/);
    await assert.rejects(substituted.target.register(), /not provably owned/);
    await assert.rejects(substituted.target.cleanup(substituted.cleanup), /Ambiguous robot creation/);
    assert.equal(substituted.writes().length, 1);
    assert.equal(substituted.target.retained().robotCreationAttempted, true);
    assert.equal(substituted.target.retained().robotId, null);
});

test('C3 ambiguous registration cannot authorize cleanup or retry', async () => {
    const fixture = ownedFixture({ failRegistration: true });
    await fixture.target.create();
    await assert.rejects(fixture.target.register(), /failed/);
    await assert.rejects(fixture.target.register(), /Never retry ambiguous/);
    await assert.rejects(fixture.target.cleanup(fixture.cleanup), /Ambiguous registration/);
    assert.equal(fixture.writes().length, 2);
    assert.deepEqual(fixture.steps, []);
    assert.equal(fixture.target.retained().registrationAttempted, true);
});

for (const [label, mutate, expected] of [
    ['foreign name', fixture => { fixture.inventory[1].name = 'foreign-settings'; }, /name|foreign/],
    ['ambiguous name', fixture => { fixture.inventory.push({ ...fixture.inventory[1], id: 'other-settings-123abc' }); }, /ambiguous/],
    ['changed creation identity', fixture => { fixture.inventory[1].createdAt = timestamp; }, /creation identity/],
    ['retargeted repository', fixture => { fixture.inventory[1].repositories[0].source = '/foreign/source'; }, /source changed/],
    ['running workstation', fixture => { fixture.inventory[1].run.state = 'running'; }, /stopped/],
    ['queued task', fixture => { fixture.inventory[1].run.queueDepth = 1; }, /queue must be empty/],
    ['runtime task', fixture => { fixture.inventory[1].run.task = { state: 'running' }; }, /no runtime task/],
]) {
    test(`C3 cleanup refuses ${label} before deleting any resource`, async () => {
        const fixture = ownedFixture(); await fixture.target.create(); await fixture.target.register(); mutate(fixture);
        await assert.rejects(fixture.target.cleanup(fixture.cleanup), expected);
        assert.equal(fixture.writes().length, 2);
        assert.equal(fixture.target.state.cleanup, 'failed');
        assert.equal(fixture.target.retained().registeredRepository, repositoryName);
        assert.ok(!fixture.steps.includes('folder-removed'));
    });
}

test('C3 cleanup requires closed pages and a completed disconnect drain', async () => {
    const fixture = ownedFixture(); await fixture.target.create(); await fixture.target.register();
    await assert.rejects(fixture.target.cleanup({ ...fixture.cleanup, pagesClosed: false }), /Close the owned/);
    await assert.rejects(fixture.target.cleanup({ ...fixture.cleanup, waitForDisconnect: async () => { throw new Error('drain deadline'); } }), /drain deadline/);
    assert.equal(fixture.writes().length, 2);
    assert.ok(!fixture.steps.includes('folder-removed'));
});

for (const [label, options, expected, expectedWrites] of [
    ['repository deletion failure', { failDelete: true }, /failed/, 3],
    ['live CLI refusal', { failRobotDelete: true }, /failed/, 4],
    ['unconfirmed robot deletion', { retainRobot: true }, /not confirmed/, 4],
]) {
    test(`C3 cleanup retains the folder after ${label} and makes no retry`, async () => {
        const fixture = ownedFixture(options); await fixture.target.create(); await fixture.target.register();
        await assert.rejects(fixture.target.cleanup(fixture.cleanup), expected);
        const writes = fixture.writes().length;
        assert.equal(writes, expectedWrites);
        await assert.rejects(fixture.target.cleanup(fixture.cleanup));
        assert.equal(fixture.writes().length, writes);
        assert.equal(fixture.target.state.cleanup, 'failed');
        assert.equal(fixture.target.retained().robotRemoved, false);
        assert.ok(!fixture.steps.includes('folder-removed'));
    });
}

test('C3 cleanup budget reuses the candidate source constant and rejects ambiguity or unbounded timing', () => {
    const budget = settingsCleanupBudget('const STREAM_RECONNECT_GRACE_MS = 120000;\n');
    assert.equal(budget.disconnectGraceMs, 120_000);
    assert.equal(budget.cleanupTimeoutMs, 181_000);
    assert.equal(budget.operationTimeoutMs, 720_000);
    assert.equal(settingsCleanupBudget('const STREAM_RECONNECT_GRACE_MS = 150000;\n').disconnectGraceMs, 150_000);
    for (const value of ['', 'const STREAM_RECONNECT_GRACE_MS = 0;\n', 'const STREAM_RECONNECT_GRACE_MS = 600000;\n',
        'const STREAM_RECONNECT_GRACE_MS = 120000;\nconst STREAM_RECONNECT_GRACE_MS = 120000;\n']) {
        assert.throws(() => settingsCleanupBudget(value));
    }
});

test('deployed-settings asserts the conversation API traffic and the page probes', () => {
    assert.match(source, /\['enabled', 'identity', 'policyVersion'\]/, 'a PATCH must carry exactly three keys');
    assert.match(source, /x-ploinky-browser-csrf-token/);
    assert.match(source, /\['GET', 'PATCH'\]/);
    assert.match(source, /search === ''|search, ''/);
    assert.match(source, /call\.phase === 'conversation-settings-open'/, 'the first load after the WebChat link must be recorded');
    assert.ok(!source.includes('skillsPages'), 'requests are classified by frame URL, not by pages registered after the helper returns');
    assert.match(source, /not-a-uuid/);
    assert.match(source, /status, 409/);
    assert.match(source, /The conversation skills link is invalid\. Open Conversation skills from the chat menu again\./);
});

test('deployed-settings is labelled unexecuted until the deployment gate', () => {
    assert.match(source, /unexecuted until the deployment gate \(D1\)/);
    assert.match(source, /Copilot-family flows are excluded from the 2026-10-02 post-merge acceptance/);
});

test('deployed-settings refuses without its environment, before any file, browser or network use', async (t) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'deployed-settings-refusal-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const run = (env) => spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH, ...env } });
    const missingRepo = run({});
    assert.notEqual(missingRepo.status, 0);
    assert.match(missingRepo.stderr, /SMOKE_EXPLORER_REPO must name the fresh Explorer checkout/);
    const missingCredentials = run({ SMOKE_EXPLORER_REPO: root });
    assert.notEqual(missingCredentials.status, 0);
    assert.match(missingCredentials.stderr, /Pass provisioned credentials through the environment/);
    const secret = 'refusal-secret-value';
    const missingPrerequisite = run({ SMOKE_EXPLORER_REPO: root, SMOKE_USERNAME: 'refusal-user', SMOKE_PASSWORD: secret });
    assert.notEqual(missingPrerequisite.status, 0);
    assert.equal(missingPrerequisite.stderr.includes(secret), false);
    assert.deepEqual(await fs.readdir(root), [], 'a refusal creates no file');
});
