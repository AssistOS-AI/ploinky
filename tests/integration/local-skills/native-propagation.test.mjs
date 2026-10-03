import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import test from 'node:test';
import { fixture, source, roots, writeSkill, createAlaEngine, ACHILLES_PRIVATE_DIRECTORY_NAME } from './fixture.mjs';

// Explicit opt-in file: requires a working Linux sandbox, a real backend, and an
// authenticated donor home. It never falls back to the deterministic consumer.
test('real native conversation uses live source edits, additions, deselection, and final deletion', { timeout: 1200000 }, async (t) => {
    const { findBubblewrap, canMountPrivateProc } = await source('ala', 'src/coding-agents/sandbox.mjs');
    const bwrap = findBubblewrap();
    const privateProc = Boolean(bwrap && canMountPrivateProc(bwrap));
    const binary = process.env.CODEX_BIN;
    const donorHome = process.env.SKILLS_TEST_NATIVE_HOME;
    const capabilities = { linux: process.platform === 'linux', bubblewrap: Boolean(bwrap), privateProc,
        codexConfigured: Boolean(binary), authHomeConfigured: Boolean(donorHome) };
    t.diagnostic(JSON.stringify({ capabilities }));
    assert.ok(privateProc, 'Native acceptance needs Bubblewrap private /proc; no relaxed sandbox or fake-backend fallback is allowed.');
    assert.ok(binary && path.isAbsolute(binary), 'Set CODEX_BIN to an installed Linux native executable.');
    assert.ok(donorHome && path.isAbsolute(donorHome), 'Set SKILLS_TEST_NATIVE_HOME to an authenticated dedicated home.');
    await fs.access(binary, constants.X_OK);
    await fs.access(path.join(donorHome, '.codex/auth.json'), constants.R_OK);
    const f = await fixture(t);
    // The always-present required skill must be a real instruction document for the model, not the fixture stand-in.
    await fs.writeFile(path.join(f.documentation, 'skills/human-report/SKILL.md'),
        '---\nname: human-report\ndescription: Write the final response in plain, accurate language.\n---\nWrite plainly and accurately. Keep the response markers the task asks for.\n');
    const repo = path.join(f.scopeRoot, 'acceptance-skills');
    const directory = path.join(repo, 'skills/acceptance-probe');
    const first = await writeSkill(directory, 'acceptance-probe');
    await f.useSources({ 'acceptance-skills': repo });
    await fs.mkdir(path.join(f.home, '.codex'), { mode: 0o700, recursive: true });
    await fs.copyFile(path.join(donorHome, '.codex/auth.json'), path.join(f.home, '.codex/auth.json'));
    await fs.chmod(path.join(f.home, '.codex/auth.json'), 0o600);
    const unselectedHomeSkill = path.join(f.home, '.codex/skills/home-only');
    await writeSkill(unselectedHomeSkill, 'home-only');
    const homeDescriptor = await fs.readFile(path.join(unselectedHomeSkill, 'SKILL.md'), 'utf8');
    const { alaTranscript } = await source('achilles', 'roboTeamAgent/copilot/src/lib/execution/alaTranscript.mjs');
    const { resolveAlaInstallation } = await source('achilles', 'roboTeamAgent/copilot/src/lib/execution/alaInstallation.mjs');
    const installation = await resolveAlaInstallation({ env: { ...process.env, ACHILLES_ALA_COMMAND: path.join(roots.ala, 'bin/ala.mjs') } });
    const engine = createAlaEngine({ workingDir: f.scopeRoot, sessionStore: f.sessionStore, skillCatalog: f.catalog,
        installation, settings: { readAchillesSettings: () => ({}), getCodingAgentModels: () => ({}),
            getPermissionMode: () => 'full-access' }, interactions: { cancelTurn() {} }, execution: { backend: 'codex', robotId: f.robot.id } });
    f.cleanup.push(() => engine.close());
    const history = `conversation-${randomUUID()}`;
    const states = [];
    const turn = async (label, prompt, expected, entries, sourceAnswers = expected) => {
        for (const value of sourceAnswers) assert.ok(!prompt.includes(value), 'Expected skill answers must only exist in source files.');
        const result = await engine.executeTurn({ sessionId: f.id, prompt, signal: AbortSignal.timeout(150000) });
        for (const value of expected) assert.ok(result.outputText.includes(value), `${label} must use the current source answer or recall history`);
        // ALA saves the conversation as a transcript in the working folder's private directory; RoboTeam binds the home.
        const metadata = alaTranscript.readSessionSync(path.join(f.scopeRoot, ACHILLES_PRIVATE_DIRECTORY_NAME, '.ala'), f.id);
        const bound = f.sessionStore.loadSession(f.id).engine;
        assert.equal(metadata.id, f.id);
        assert.equal(bound.home, f.home);
        assert.equal(bound.cwd, f.scopeRoot);
        assert.equal(metadata.agent, 'codex');
        assert.ok(metadata.continuation?.threadId);
        if (states.length) assert.equal(metadata.continuation.threadId, states[0].threadId);
        const execution = f.sessionStore.loadSession(f.id).skillExecution;
        assert.deepEqual(execution.entries.filter((entry) => !entry.required).map((entry) => entry.name).sort(), entries);
        states.push({ label, threadId: metadata.continuation.threadId, revision: execution.revision });
        t.diagnostic(JSON.stringify(states.at(-1)));
        return result.outputText;
    };
    await turn('original', `Remember ${history}. Use acceptance-probe. Return DESCRIPTOR=<descriptor value> HELPER=<helper output>.`,
        [first.descriptor, first.helper, first.asset], ['acceptance-probe']);
    const helper = path.join(directory, 'helper.mjs');
    const before = await fs.stat(helper);
    const changed = await writeSkill(directory, 'acceptance-probe');
    assert.equal((await fs.stat(helper)).size, before.size);
    await fs.utimes(helper, before.atime, before.mtime);
    await turn('changed', 'Use acceptance-probe again. Return DESCRIPTOR=<descriptor value> HELPER=<helper output>.',
        [changed.descriptor, changed.helper, changed.asset], ['acceptance-probe']);
    assert.equal(states[1].revision, states[0].revision, 'a live link set keeps its revision when only file bytes change');
    const helperBefore = await fs.stat(helper);
    const helperOnly = randomUUID();
    const helperSource = await fs.readFile(helper, 'utf8');
    assert.ok(helperSource.includes(changed.helper));
    await fs.writeFile(helper, helperSource.replace(changed.helper, helperOnly));
    await fs.utimes(helper, helperBefore.atime, helperBefore.mtime);
    assert.equal((await fs.stat(helper)).size, helperBefore.size);
    await turn('helper-only', 'Use acceptance-probe again. Return DESCRIPTOR=<descriptor value> HELPER=<helper output>.',
        [changed.descriptor, helperOnly, changed.asset], ['acceptance-probe']);
    assert.equal(states[2].revision, states[1].revision);
    const addedDirectory = path.join(repo, 'skills/new-probe');
    const added = await writeSkill(addedDirectory, 'new-probe');
    await turn('addition', 'Use new-probe. Return DESCRIPTOR=<descriptor value> HELPER=<helper output>.',
        [added.descriptor, added.helper, added.asset], ['acceptance-probe', 'new-probe']);
    assert.notEqual(states[3].revision, states[2].revision, 'adding a linked skill changes the link set revision');
    await f.settings.load();
    for (const item of f.settings.items.filter((entry) => entry.enabled && !entry.required)) await f.settings.toggle(item.identity);
    const emptyPrompt = 'If .agents/skills holds no skill other than human-report, respond exactly NO_SKILLS followed by the conversation token I asked you to remember. Otherwise respond HAS_SKILLS.';
    const empty = await turn('deselected', emptyPrompt, ['NO_SKILLS', history], [], []);
    assert.ok(!empty.includes('HAS_SKILLS'));
    await f.settings.load();
    await f.settings.toggle('acceptance-skills/acceptance-probe');
    await fs.rm(path.join(repo, 'skills'), { recursive: true });
    const deleted = await turn('final-deletion', emptyPrompt, ['NO_SKILLS', history], [], []);
    assert.ok(!deleted.includes('HAS_SKILLS'));
    for (const marker of [first.descriptor, changed.descriptor, added.descriptor]) assert.ok(!deleted.includes(marker));
    assert.equal(await fs.readFile(path.join(unselectedHomeSkill, 'SKILL.md'), 'utf8'), homeDescriptor,
        'Native exclusions must not rewrite or remove the unselected home skill.');
});
