#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { assertArtifactRoot, assertExplorerSmokeDirectory, assertMarketplacePrerequisite } from './deployed-prerequisites.mjs';

const repo = process.env.SMOKE_EXPLORER_REPO;
assert.ok(repo && path.isAbsolute(repo), 'SMOKE_EXPLORER_REPO must name the fresh Explorer checkout.');
assert.ok(process.env.SMOKE_USERNAME && process.env.SMOKE_PASSWORD,
    'Pass provisioned credentials through the environment; never put them in command arguments.');
const prerequisite = await assertMarketplacePrerequisite();
const here = path.dirname(fileURLToPath(import.meta.url));
const artifactBase = await assertArtifactRoot(process.env.SMOKE_ARTIFACT_DIR,
    [path.resolve(here, '../../..'), repo, prerequisite.workspaceRoot]);
const smoke = await assertExplorerSmokeDirectory(repo, prerequisite);
const baseURL = new URL(prerequisite.baseURL);
const runId = `conversation-skills-${Date.now()}-${randomUUID().slice(0, 8)}`;
const output = path.join(artifactBase, runId);
process.env.SMOKE_RUN_ID = runId;
process.env.SMOKE_ARTIFACT_DIR = output;
process.env.SMOKE_QA_ACCEPTANCE = '0';
const require = createRequire(path.join(smoke, 'package.json'));
let playwright;
try { playwright = require('@playwright/test'); } catch {
    throw new Error('The selected Explorer smoke checkout needs its existing Playwright dependency. See README.md; this check installs no packages.');
}
const { chromium, expect } = playwright;
// This check is unexecuted until the deployment gate (D1); Copilot-family flows are excluded from the 2026-10-02 post-merge acceptance.
// This check drives RoboTeam's Conversation skills page through the Explorer smoke helper that ships with the deployment.
const load = name => import(pathToFileURL(path.join(smoke, 'lib', `${name}.mjs`)).href);
const { openExplorer } = await load('explorer');
const { createDirectory, deleteDirectoryIfPresent, directoryRow, openCopilotForDirectory } = await load('copilot');
const { waitForWebchatIdle } = await load('webchat');
const { callAgentToolViaRouter } = await load('mcp');
const { createRedactor } = await load('security');
let conversationSkills;
try { conversationSkills = await load('conversation-skills'); } catch (cause) {
    throw new Error('The selected Explorer smoke checkout lacks tests/smoke/lib/conversation-skills.mjs; use a revision that contains the Conversation skills helper.', { cause });
}
const { ROBOTEAM_BASE_PATH, conversationFromSkillsURL, roboTeamApi, roboTeamRobotId, openConversationSkills,
    conversationSkillsState, setConversationSkill, refreshConversationSkills } = conversationSkills;
const redact = createRedactor();
const unique = randomUUID().slice(0, 8);
const directoryName = runId;
const directoryPath = `/${directoryName}`;
const repositoryName = `set1-${unique}`;
const skillName = `conversation-settings-proof-${unique}`;
const repositoryDirectory = `${directoryName}/skills-repo`;
const descriptorPath = `${repositoryDirectory}/${skillName}/SKILL.md`;
const descriptor = `---\nname: ${skillName}\ndescription: Verify conversation-local skill settings in a disposable test folder.\n---\n\nUse only when explicitly testing conversation skill settings. Do not run commands or modify files.\n`;
const identity = `${repositoryName}/${skillName}`;
const invalidLinkText = 'The conversation skills link is invalid. Open Conversation skills from the chat menu again.';
const evidence = { kind: 'deployed-conversation-skills-page', runId, baseURL: baseURL.origin, prerequisite,
    directoryPath, repositoryName, identity, fixtureDescriptorSha256: hash(descriptor),
    playwrightVersion: require('@playwright/test/package.json').version,
    result: 'running', cleanup: 'not-started', conversationApiRequests: [], roboTeamPageMcpRequests: 0, probes: {} };
// What this run created and must remove. Both stay in place, and are reported, when the run fails.
const created = { registeredRepository: null, folder: null };
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ baseURL: baseURL.origin, viewport: { width: 1440, height: 1000 } });
context.setDefaultTimeout(30_000);
context.setDefaultNavigationTimeout(60_000);
const page = await context.newPage();
const skillsPages = new Set();
let dashboard;
let copilotPage;
let settingsPage;
let phase = 'setup';

function hash(value) { return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex'); }
async function receipt() {
    await mkdir(output, { recursive: true });
    await writeFile(path.join(output, 'evidence.json'), redact(JSON.stringify(evidence, null, 2)) + '\n', { mode: 0o600 });
}
function observeRequest(request) {
    let url;
    let origin;
    try { url = new URL(request.url()); origin = request.frame()?.page(); } catch { return; }
    if (!skillsPages.has(origin)) return;
    if (url.pathname.endsWith('/mcp') && request.method() === 'POST') evidence.roboTeamPageMcpRequests += 1;
    if (!/\/api\/robots\/[^/]+\/conversations\/[^/]+\/skills$/.test(url.pathname)) return;
    let bodyKeys = null;
    if (request.method() === 'PATCH') {
        try { bodyKeys = Object.keys(request.postDataJSON()).sort(); } catch { bodyKeys = ['unparseable']; }
    }
    // Headers and tokens are never recorded; only whether the browser mutation proof was sent.
    evidence.conversationApiRequests.push({ phase, method: request.method(), search: url.search, bodyKeys,
        csrfHeaderPresent: Boolean(request.headers()['x-ploinky-browser-csrf-token']) });
}
context.on('request', observeRequest);

async function defaults() {
    const catalog = await callAgentToolViaRouter(page, { agent: 'roboTeamAgent', tool: 'list_achilles_skills', args: { robot: 'default' } });
    assert.equal(catalog.scope, 'defaults');
    return { policyVersion: catalog.policyVersion, policySha256: hash(catalog.policy) };
}
async function conversation(sessionId) {
    return callAgentToolViaRouter(page, { agent: 'roboTeamAgent', tool: 'list_achilles_skills', args: { robot: 'default', sessionId } });
}
function selectedItem(catalog) {
    const items = catalog.skills.filter(item => item.identity === identity);
    assert.equal(items.length, 1, 'The fixture must have exactly one unambiguous inventory entry.');
    return items[0];
}
function rowOf(state) {
    const rows = state.items.filter(item => item.identity === identity);
    assert.equal(rows.length, 1, 'The Conversation skills page must list the registered skill exactly once.');
    return rows[0];
}

try {
    await openExplorer(page);
    const roots = await callAgentToolViaRouter(page, { agent: 'explorer', tool: 'list_allowed_directories' });
    const allowedRoots = String(roots.rawText || '').split('\n').filter(line => line.startsWith('/'));
    assert.ok(allowedRoots.length, 'Explorer must report its actual filesystem root.');
    const filesystemRoot = allowedRoots[0].replace(/\/+$/, '');
    evidence.fixtureFilesystemPath = `${filesystemRoot}/${descriptorPath}`;

    // Registering a repository is an administrator action. Refuse before any write when the user cannot do it.
    phase = 'admin-check';
    dashboard = await context.newPage();
    await dashboard.goto(new URL(ROBOTEAM_BASE_PATH, baseURL).href, { waitUntil: 'domcontentloaded' });
    const robots = await roboTeamApi(dashboard, { path: 'api/robots' });
    assert.equal(robots.status, 200);
    assert.ok(robots.payload.canAdmin === true, 'The signed-in user must be a RoboTeam administrator to register the run-owned repository.');
    const robotId = await roboTeamRobotId(dashboard, 'default');
    evidence.robotId = robotId;

    phase = 'defaults-before';
    const defaultsBefore = await defaults();
    evidence.defaultsBefore = defaultsBefore;

    phase = 'conversation-launch';
    await createDirectory(page, directoryName, directoryPath);
    created.folder = directoryPath;
    copilotPage = await openCopilotForDirectory(page, directoryPath);
    await expect(copilotPage.locator('#cmd')).toBeEditable({ timeout: 60_000 });
    await waitForWebchatIdle(copilotPage, 60_000);

    phase = 'repository-registration';
    const made = await callAgentToolViaRouter(page, { agent: 'explorer', tool: 'create_directory',
        args: { path: `${repositoryDirectory}/${skillName}` } });
    assert.match(made.rawText || '', /^Successfully created directory /);
    const written = await callAgentToolViaRouter(page, { agent: 'explorer', tool: 'write_file',
        args: { path: descriptorPath, content: descriptor } });
    assert.match(written.rawText || '', /^Successfully wrote to /);
    const readBack = await callAgentToolViaRouter(page, { agent: 'explorer', tool: 'read_file', args: { path: descriptorPath } });
    assert.equal(readBack.rawText, descriptor);
    const registered = await roboTeamApi(dashboard, { method: 'POST', path: `api/robots/${robotId}/skillsets`,
        body: { name: repositoryName, source: `${filesystemRoot}/${repositoryDirectory}` } });
    assert.equal(registered.status, 200);
    created.registeredRepository = repositoryName;

    phase = 'conversation-settings-open';
    settingsPage = await openConversationSkills(copilotPage);
    skillsPages.add(settingsPage);
    const target = conversationFromSkillsURL(settingsPage.url(), baseURL.origin, { robotId });
    evidence.conversation = target;
    await copilotPage.screenshot({ path: path.join(output, 'webchat-after-conversation-skills.png') });
    const current = await conversationSkillsState(settingsPage);
    assert.equal(current.robotId, robotId);
    assert.equal(current.sessionId, target.sessionId);
    const initial = rowOf(current);
    assert.equal(initial.enabled, false, 'A newly registered repository is not selected until the user enables it.');
    assert.equal(initial.state, 'available');

    phase = 'conversation-enable';
    const enabled = await setConversationSkill(settingsPage, identity, true);
    assert.ok(enabled.policyVersion > current.policyVersion);
    assert.equal(rowOf(enabled).enabled, true);
    const afterEnable = await conversation(target.sessionId);
    assert.equal(afterEnable.scope, 'conversation');
    assert.equal(afterEnable.sessionId, target.sessionId);
    assert.equal(selectedItem(afterEnable).enabled, true);
    assert.ok(afterEnable.policy.selectors.skills.includes(identity));
    assert.equal(afterEnable.cwd, `${filesystemRoot}/${directoryName}`);
    assert.ok(afterEnable.policyVersion > current.policyVersion);

    phase = 'conversation-disable';
    const disabled = await setConversationSkill(settingsPage, identity, false);
    assert.ok(disabled.policyVersion > enabled.policyVersion);
    const afterDisable = await conversation(target.sessionId);
    assert.equal(selectedItem(afterDisable).enabled, false);
    assert.ok(afterDisable.policy.excludedSkills.includes(identity));
    assert.ok(afterDisable.policyVersion > afterEnable.policyVersion);
    evidence.persisted = { policyVersion: afterDisable.policyVersion, exclusionSaved: true, policySha256: hash(afterDisable.policy) };

    phase = 'conversation-reload';
    await settingsPage.reload({ waitUntil: 'domcontentloaded' });
    const reloaded = await conversationSkillsState(settingsPage);
    assert.equal(rowOf(reloaded).enabled, false);
    assert.equal(reloaded.policyVersion, afterDisable.policyVersion);
    const refreshed = await refreshConversationSkills(settingsPage);
    assert.equal(rowOf(refreshed).enabled, false);
    assert.equal(refreshed.policyVersion, afterDisable.policyVersion);
    await settingsPage.screenshot({ path: path.join(output, 'conversation-skills-disabled.png') });

    phase = 'api-evidence';
    const calls = evidence.conversationApiRequests;
    assert.ok(calls.some(call => call.method === 'GET'), 'The page must read the conversation through the conversation API.');
    const patches = calls.filter(call => call.method === 'PATCH');
    assert.ok(patches.length >= 2, 'Enabling and disabling must each send one PATCH.');
    for (const call of calls) {
        assert.ok(['GET', 'PATCH'].includes(call.method), `Unexpected method ${call.method} on the conversation API.`);
        assert.equal(call.search, '', 'The conversation API takes no query parameters.');
    }
    for (const call of patches) {
        assert.deepEqual(call.bodyKeys, ['enabled', 'identity', 'policyVersion']);
        assert.equal(call.csrfHeaderPresent, true, 'A browser mutation must carry the Router mutation proof.');
    }
    assert.equal(evidence.roboTeamPageMcpRequests, 0, 'The RoboTeam page must not call MCP tools.');

    phase = 'probes';
    const stale = await roboTeamApi(dashboard, { method: 'PATCH',
        path: `api/robots/${robotId}/conversations/${target.sessionId}/skills`,
        body: { identity, enabled: true, policyVersion: current.policyVersion } });
    assert.equal(stale.status, 409);
    const afterStale = await conversation(target.sessionId);
    assert.equal(afterStale.policyVersion, afterDisable.policyVersion, 'A rejected stale update must not change the version.');
    assert.equal(selectedItem(afterStale).enabled, false);
    const invalidPage = await context.newPage();
    const invalidApiRequests = [];
    invalidPage.on('request', request => { if (new URL(request.url()).pathname.includes('/api/')) invalidApiRequests.push(request.method()); });
    await invalidPage.goto(new URL(`${ROBOTEAM_BASE_PATH}conversation-skills/${robotId}/not-a-uuid`, baseURL).href, { waitUntil: 'domcontentloaded' });
    await expect(invalidPage.locator('#conversationSkillsStatus')).toHaveText(invalidLinkText);
    await expect(invalidPage.locator('#conversationSkillsStatus')).toHaveClass(/error/);
    assert.equal(invalidApiRequests.length, 0, 'An invalid link must not reach the API.');
    await invalidPage.close();
    evidence.probes = { staleStatus: stale.status, invalidLinkApiRequests: invalidApiRequests.length };

    phase = 'defaults-after';
    const defaultsAfter = await defaults();
    assert.deepEqual(defaultsAfter, defaultsBefore, 'Conversation changes must not alter the robot defaults.');
    evidence.defaultsAfter = { ...defaultsAfter, unchanged: true };
    evidence.result = 'checks-passed';
    await receipt();

    // Remove what this run created: the repository first, then the folder.
    phase = 'cleanup';
    await settingsPage.close();
    await copilotPage.close();
    const removed = await roboTeamApi(dashboard, { method: 'DELETE', path: `api/robots/${robotId}/skillsets?name=${repositoryName}` });
    assert.equal(removed.status, 200);
    created.registeredRepository = null;
    await page.reload({ waitUntil: 'load' });
    await expect(directoryRow(page, directoryPath)).toHaveCount(1);
    await deleteDirectoryIfPresent(page, directoryPath);
    created.folder = null;
    evidence.cleanup = 'owned-repository-and-folder-deleted';
    evidence.result = 'passed';
} catch (error) {
    evidence.result = 'failed';
    evidence.failedPhase = phase;
    evidence.error = redact(error.message);
    evidence.cleanup = 'failed-fixture-retained-for-diagnosis';
    evidence.retained = { registeredRepository: created.registeredRepository, folder: created.folder };
    process.exitCode = 1;
} finally {
    await receipt();
    await context.close();
    await browser.close();
}
console.log(JSON.stringify({ result: evidence.result, artifactDirectory: output, cleanup: evidence.cleanup }));
