import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as ploinky from '../../cli/utils/skills/exportTransaction.mjs';
import * as ploinkyExclusions from '../../cli/utils/skills/exportExclusions.mjs';
import { scenarios, contentionScenario } from './fixtures/skillExportConformanceScenarios.mjs';

const temporary = t => label => {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `skill-tx-${label}-`)));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
};

for (const scenario of scenarios) {
    test(`ploinky protocol: ${scenario.name}`, t => scenario.run({ mod: ploinky, exclusions: ploinkyExclusions, tmp: temporary(t) }));
}

test('two Ploinky exporter instances exclude and recover each other on one folder', t => {
    contentionScenario({ first: ploinky, second: ploinky, tmp: temporary(t) });
});

// Transaction-level: a journal whose only shared-Git artifacts are private files
// (the managed excludes file and its composition record) is a common-Git
// metadata change, exactly like a git-config journal.
test('a private-file-only journal is recovered under the common Git lock, with or without a planner, and never without it', t => {
    const root = temporary(t)('private-only');
    const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', XDG_CONFIG_HOME: path.join(root, 'xdg'), HOME: root,
        GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid' };
    fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '');
    const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const project = path.join(root, 'project');
    fs.mkdirSync(path.join(project, 'one'), { recursive: true });
    git(project, 'init', '-q', '-b', 'main');
    const source = path.join(root, 'source');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'SKILL.md'), '# demo\n');
    const live = pid => ({ current: () => ({ pid, start: `s${pid}`, boot: 'b', namespace: 'n', hostname: 'h', container: false }), alive: other => other !== 200, start: other => `s${other}` });
    const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
    Object.assign(process.env, env);
    t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
    const planner = () => ploinkyExclusions.createSkillExclusionPlanner({ env, containerExecutor: false, capability: () => ({ supported: true }) });
    const publish = (folder, extra = {}) => ploinky.syncManagedSkillExports({ folder, owner: 'manifest', sources: [{ name: 'demo', path: source }], exclusions: planner(), ...extra });
    assert.equal(publish(project).exclusions.status, 'published');
    const crash = { crash(point) { if (point === 'after-metadata-journal') throw Object.assign(new Error('simulated crash'), { [ploinky.SIMULATED_CRASH]: true }); } };
    const one = path.join(project, 'one');
    assert.throws(() => publish(one, { lock: { liveness: live(200) }, hooks: crash }), /simulated crash/);
    const journalFile = path.join(one, '.agents', '.ploinky-skill-exports.journal.json');
    const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
    journal.artifacts = journal.artifacts.filter(artifact => artifact.kind === 'private-file');
    assert.equal(journal.artifacts.length, 2);
    fs.writeFileSync(journalFile, JSON.stringify(journal));
    const common = fs.realpathSync(path.join(project, '.git'));
    fs.rmSync(path.join(common, ploinkyExclusions.GIT_CONFIG_LOCK), { recursive: true });
    const metadata = () => ['ploinky-skill-exports.exclude', 'ploinky-skill-exports.exclusions.json'].map(name => fs.readFileSync(path.join(common, name), 'utf8'));
    const before = metadata();
    // Without a lock the journal stays pending and nothing is written.
    assert.throws(() => ploinky.withSkillExportLocks([one], () => null, { liveness: live(300), acquireGitMetadataLock: () => { throw Object.assign(new Error('read-only'), { code: 'EROFS' }); } }),
        error => error.code === 'SKILL_EXPORT_RECOVERY_REQUIRED');
    assert.ok(fs.existsSync(journalFile));
    assert.deepEqual(metadata(), before);
    // With the lock, discovered from the journal alone and without a planner, it rolls forward.
    const held = [];
    const recovery = ploinky.withSkillExportLocks([one], ([handle]) => handle.recovery, { liveness: live(300), acquireGitMetadataLock: key => { held.push(key); return ploinky.acquireGitConfigLock(key, { liveness: live(300) }); } });
    assert.deepEqual(held, [common]);
    assert.equal(recovery.status, 'rolled-forward');
    assert.notDeepEqual(metadata(), before);
    assert.deepEqual(Object.keys(JSON.parse(metadata()[1]).owners).sort(), ['.', 'one']);
});
