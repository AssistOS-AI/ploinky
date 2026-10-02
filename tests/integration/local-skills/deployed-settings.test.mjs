import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Guards for deployed-settings.mjs. They run on any host without a browser, a deployment, or credentials. The check
// itself stays unexecuted until the deployment gate (D1).
const script = fileURLToPath(new URL('./deployed-settings.mjs', import.meta.url));
const source = await fs.readFile(script, 'utf8');

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
    assert.ok(source.indexOf('canAdmin === true') < source.indexOf("tool: 'write_file'"), 'the admin check must precede every write');
    assert.match(source, /skillsets\?name=/, 'the run-owned repository must be deleted by name');
    assert.ok(source.indexOf('skillsets?name=') < source.lastIndexOf('deleteDirectoryIfPresent('), 'the repository is deleted before the folder');
    assert.match(source, /registeredRepository/);
    assert.match(source, /process\.exitCode = 1/);
});

test('deployed-settings asserts the conversation API traffic and the page probes', () => {
    assert.match(source, /\['enabled', 'identity', 'policyVersion'\]/, 'a PATCH must carry exactly three keys');
    assert.match(source, /x-ploinky-browser-csrf-token/);
    assert.match(source, /\['GET', 'PATCH'\]/);
    assert.match(source, /search === ''|search, ''/);
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
