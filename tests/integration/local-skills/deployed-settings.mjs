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
const load = name => import(pathToFileURL(path.join(smoke, 'lib', `${name}.mjs`)).href);
const { openExplorer, assertExplorerDirectory } = await load('explorer');
const { createDirectory, deleteDirectoryIfPresent, directoryRow, openCopilotForDirectory } = await load('copilot');
const { waitForWebchatIdle } = await load('webchat');
const { callAgentToolViaRouter } = await load('mcp');
const { createRedactor } = await load('security');
const redact = createRedactor();
const directoryName = runId;
const directoryPath = `/${directoryName}`;
const skillName = `conversation-settings-proof-${randomUUID().slice(0, 8)}`;
const relativeSkillDirectory = `${directoryName}/.agents/skills/${skillName}`;
const descriptorPath = `${relativeSkillDirectory}/SKILL.md`;
const descriptor = `---\nname: ${skillName}\ndescription: Verify conversation-local skill settings in a disposable test folder.\n---\n\nUse only when explicitly testing conversation skill settings. Do not run commands or modify files.\n`;
const evidence = { kind: 'deployed-production-ui', runId, baseURL: baseURL.origin, prerequisite,
    directoryPath, descriptorPath, fixtureDescriptorSha256: hash(descriptor),
    playwrightVersion: require('@playwright/test/package.json').version,
    result: 'running', cleanup: 'not-started', requests: [] };
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ baseURL: baseURL.origin, viewport: { width: 1440, height: 1000 } });
context.setDefaultTimeout(30_000);
context.setDefaultNavigationTimeout(60_000);
const page = await context.newPage();
let copilotPage;
let settingsPage;
let phase = 'setup';

function hash(value) { return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex'); }
async function receipt() {
    await mkdir(output, { recursive: true });
    await writeFile(path.join(output, 'evidence.json'), redact(JSON.stringify(evidence, null, 2)) + '\n', { mode: 0o600 });
}
function catalogArguments(tool, expected, step) {
    const calls = evidence.requests.filter(entry => entry.phase === step && entry.tool === tool);
    assert.ok(calls.length, `Production UI made no ${tool} request during ${step}.`);
    for (const call of calls) assert.deepEqual(call.arguments, expected);
}
function observeRequest(request) {
    if (!new URL(request.url()).pathname.endsWith('/mcp') || request.method() !== 'POST') return;
    let payload;
    try { payload = request.postDataJSON(); } catch { return; }
    const tool = payload?.params?.name;
    if (payload?.method !== 'tools/call' || !['list_achilles_skills', 'set_achilles_skill_enabled'].includes(tool)) return;
    const args = payload.params.arguments;
    if (!args || Object.keys(args).some(key => !['robot', 'sessionId', 'dir', 'identity', 'enabled', 'policyVersion'].includes(key))) {
        evidence.requests.push({ phase, tool, invalidArgumentShape: true });
        return;
    }
    // Headers, tokens, auth bodies and complete response payloads are never recorded.
    evidence.requests.push({ phase, tool, arguments: structuredClone(args) });
}
context.on('request', observeRequest);

async function modalState(candidate) {
    return candidate.locator('settings-modal').evaluate(element => {
        const presenter = element.webSkelPresenter;
        const state = presenter?.state;
        if (!state) throw new Error('Production Settings presenter is unavailable.');
        return { context: presenter.getCopilotContext(), policyVersion: state.copilotPolicyVersion,
            policy: state.copilotPolicy, items: state.copilotItems, loaded: state.copilotDataLoaded,
            activeRevision: state.copilotActiveRevision ?? null };
    });
}
async function loadedModal(candidate, conversation) {
    await expect(candidate.locator('settings-modal')).toBeVisible();
    await expect(candidate.getByRole('tab', { name: 'Copilot', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(candidate.locator('#copilotSettingsStatus')).toContainText(conversation
        ? 'Current selection loaded.' : 'defaults loaded.');
    await expect(candidate.locator('#copilotSettingsStatus')).not.toHaveClass(/error/);
    const state = await modalState(candidate);
    assert.ok(state.loaded && Number.isSafeInteger(state.policyVersion));
    return state;
}
async function ordinarySettings(candidate) {
    await candidate.locator('#accountMenuButton').click();
    await candidate.getByRole('menuitem', { name: 'Settings', exact: true }).click();
    await expect(candidate.locator('settings-modal')).toBeVisible();
    await candidate.getByRole('tab', { name: 'Copilot', exact: true }).click();
    return loadedModal(candidate, false);
}
async function closeModal(candidate) {
    await candidate.locator('settings-modal .close[data-local-action="closeModal"]').click();
    await expect(candidate.locator('settings-modal')).toHaveCount(0);
}
function selectedItem(catalog) {
    const items = (catalog.skills || catalog.items).filter(item => item.name === skillName);
    assert.equal(items.length, 1, 'The fixture must have exactly one unambiguous inventory entry.');
    return items[0];
}

try {
    await openExplorer(page);
    const roots = await callAgentToolViaRouter(page, { agent: 'explorer', tool: 'list_allowed_directories' });
    const allowedRoots = String(roots.rawText || '').split('\n').filter(line => line.startsWith('/'));
    assert.ok(allowedRoots.length, 'Explorer must report its actual filesystem root.');
    const filesystemRoot = allowedRoots[0].replace(/\/+$/, '');
    evidence.fixtureFilesystemPath = `${filesystemRoot}/${descriptorPath}`;
    await createDirectory(page, directoryName, directoryPath);

    phase = 'defaults-before';
    const before = await ordinarySettings(page);
    assert.deepEqual(before.context, { robot: 'default' });
    catalogArguments('list_achilles_skills', { robot: 'default' }, phase);
    evidence.defaultsBefore = { policyVersion: before.policyVersion, policySha256: hash(before.policy) };
    await closeModal(page);

    phase = 'conversation-launch';
    copilotPage = await openCopilotForDirectory(page, directoryPath);
    await expect(copilotPage.locator('#cmd')).toBeEditable({ timeout: 60_000 });
    await waitForWebchatIdle(copilotPage, 60_000);
    phase = 'live-skill-addition';
    const created = await callAgentToolViaRouter(page, { agent: 'explorer', tool: 'create_directory',
        args: { path: relativeSkillDirectory } });
    assert.match(created.rawText || '', /^Successfully created directory /);
    const written = await callAgentToolViaRouter(page, { agent: 'explorer', tool: 'write_file',
        args: { path: descriptorPath, content: descriptor } });
    assert.match(written.rawText || '', /^Successfully wrote to /);
    const readBack = await callAgentToolViaRouter(page, { agent: 'explorer', tool: 'read_file', args: { path: descriptorPath } });
    assert.equal(readBack.rawText, descriptor);
    evidence.fixtureAddedAfterConversationLaunch = true;
    await copilotPage.locator('#settingsBtn').click();
    const link = copilotPage.locator('#sessionSettingsLink');
    await expect(link).toBeVisible({ timeout: 60_000 });
    await expect(link).toHaveText('Conversation skills');
    const actionURL = new URL(await link.getAttribute('href'), baseURL.origin);
    assert.equal(actionURL.origin, baseURL.origin);
    assert.equal(actionURL.pathname, '/explorer/index.html');
    assert.deepEqual([...actionURL.searchParams.keys()].sort(), ['copilot-robot', 'copilot-session']);
    const robot = actionURL.searchParams.get('copilot-robot');
    const sessionId = actionURL.searchParams.get('copilot-session');
    assert.equal(robot, 'default');
    assert.match(sessionId, /^[a-f0-9-]{36}$/);
    evidence.conversation = { robot, sessionId };
    phase = 'conversation-settings-open';
    const popup = context.waitForEvent('page');
    await link.click();
    settingsPage = await popup;
    await settingsPage.waitForLoadState('domcontentloaded');
    const current = await loadedModal(settingsPage, true);
    assert.deepEqual(current.context, { robot, sessionId });
    catalogArguments('list_achilles_skills', { robot, sessionId }, phase);
    assert.equal(new URL(settingsPage.url()).search, '', 'Explorer must consume context query parameters once.');
    // The opened browser is at root; the conversation still resolves its saved launch folder.
    await assertExplorerDirectory(settingsPage, '/');
    const item = selectedItem(current);
    assert.equal(item.enabled, true, 'The new local skill must be effective without commit/update/import.');
    assert.equal(item.sourcePath, `${filesystemRoot}/${relativeSkillDirectory}`);
    assert.ok(item.identity.startsWith('workspace:'));
    evidence.initial = { identity: item.identity, state: item.state, sourcePath: item.sourcePath,
        enabled: item.enabled, policyVersion: current.policyVersion };
    const row = settingsPage.locator('#copilotSettingsList .plugin-settings-row').filter({
        has: settingsPage.locator('.plugin-settings-key', { hasText: new RegExp(`^${skillName}$`) }),
    });
    await expect(row).toHaveCount(1);
    const toggle = row.locator('button[data-local-action^="toggleCopilotSkill "]');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    phase = 'conversation-disable';
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await loadedModal(settingsPage, true);
    catalogArguments('set_achilles_skill_enabled', { robot, sessionId, identity: item.identity,
        enabled: false, policyVersion: current.policyVersion }, phase);

    phase = 'persisted-conversation-read';
    const saved = await callAgentToolViaRouter(page, { agent: 'roboTeamAgent', tool: 'list_achilles_skills', args: { robot, sessionId } });
    assert.equal(saved.scope, 'conversation');
    assert.equal(saved.sessionId, sessionId);
    assert.equal(saved.cwd, `${filesystemRoot}/${directoryName}`);
    assert.ok(saved.policyVersion > current.policyVersion);
    assert.equal(selectedItem(saved).enabled, false);
    assert.ok(saved.policy.excludedSkills.includes(item.identity));
    evidence.persisted = { scope: saved.scope, cwd: saved.cwd, policyVersion: saved.policyVersion,
        enabled: false, exclusionSaved: true, policySha256: hash(saved.policy) };
    phase = 'conversation-refresh';
    await settingsPage.getByRole('button', { name: 'Refresh skills', exact: true }).click();
    const refreshed = await loadedModal(settingsPage, true);
    assert.equal(refreshed.policyVersion, saved.policyVersion);
    assert.equal(selectedItem(refreshed).enabled, false);
    catalogArguments('list_achilles_skills', { robot, sessionId }, phase);
    await mkdir(output, { recursive: true });
    await settingsPage.locator('settings-modal').screenshot({ path: path.join(output, 'conversation-disabled.png') });
    await closeModal(settingsPage);
    phase = 'defaults-after';
    const after = await ordinarySettings(settingsPage);
    assert.deepEqual(after.context, { robot: 'default' });
    assert.equal(after.policyVersion, before.policyVersion);
    assert.deepEqual(after.policy, before.policy);
    catalogArguments('list_achilles_skills', { robot: 'default' }, phase);
    await expect(settingsPage.locator('#copilotSettingsList')).toContainText('Defaults apply to future conversations.');
    evidence.defaultsAfter = { policyVersion: after.policyVersion, policySha256: hash(after.policy), unchanged: true };
    await settingsPage.locator('settings-modal').screenshot({ path: path.join(output, 'defaults-unchanged.png') });
    evidence.result = 'checks-passed';
    await receipt();
    await settingsPage.close();
    await copilotPage.close();
    phase = 'successful-fixture-cleanup';
    await page.reload({ waitUntil: 'load' });
    await expect(directoryRow(page, directoryPath)).toHaveCount(1);
    await deleteDirectoryIfPresent(page, directoryPath);
    evidence.cleanup = 'owned-folder-deleted';
    evidence.result = 'passed';
} catch (error) {
    evidence.result = 'failed';
    evidence.failedPhase = phase;
    evidence.error = redact(error.message);
    evidence.cleanup = 'failed-fixture-retained-for-diagnosis';
    process.exitCode = 1;
} finally {
    await receipt();
    await context.close();
    await browser.close();
}
console.log(JSON.stringify({ result: evidence.result, artifactDirectory: output, cleanup: evidence.cleanup }));
