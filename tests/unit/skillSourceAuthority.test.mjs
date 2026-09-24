import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolated workspace, Git policy and a Git trace for the whole file.
const originalCwd = process.cwd();
const saved = Object.fromEntries(['PLOINKY_WORKSPACE_ROOT', 'PATH', 'XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']
    .map(key => [key, process.env[key]]));
const suite = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skill-source-authority-')));
const workspace = path.join(suite, 'workspace');
fs.mkdirSync(path.join(workspace, '.ploinky'), { recursive: true });
const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
const shim = path.join(suite, 'bin');
const traceLog = path.join(suite, 'git-trace.log');
fs.mkdirSync(shim);
fs.writeFileSync(path.join(shim, 'git'), `#!/bin/sh\nprintf '%s\\n' "$PWD $*" >> '${traceLog}'\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
fs.writeFileSync(path.join(suite, 'gitconfig'), '[user]\n\tname = Test\n\temail = test@example.invalid\n');
Object.assign(process.env, {
    PLOINKY_WORKSPACE_ROOT: workspace,
    PATH: `${shim}${path.delimiter}${process.env.PATH}`,
    XDG_CONFIG_HOME: path.join(suite, 'xdg'),
    GIT_CONFIG_GLOBAL: path.join(suite, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
});
process.chdir(workspace);

const [skills, { REPOS_DIR }, tx, exclusionsModule] = await Promise.all([
    import('../../cli/commands/skills.js'),
    import('../../cli/utils/config.js'),
    import('../../cli/utils/skills/exportTransaction.mjs'),
    import('../../cli/utils/skills/exportExclusions.mjs'),
]);

test.after(() => {
    process.chdir(originalCwd);
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(suite, { recursive: true, force: true });
});

const git = (cwd, ...args) => execFileSync(realGit, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const resetTrace = () => fs.writeFileSync(traceLog, '');
// Commands that contact a remote or move a checkout.
const mutations = () => fs.readFileSync(traceLog, 'utf8').split('\n')
    .filter(line => /\s(fetch|pull|merge|clone|checkout|rebase|reset|switch)\b/.test(line));

function sourceRepo(root, skillNames) {
    fs.mkdirSync(root, { recursive: true });
    for (const name of skillNames) {
        fs.mkdirSync(path.join(root, 'skills', name), { recursive: true });
        fs.writeFileSync(path.join(root, 'skills', name, 'SKILL.md'), `# ${name}\n`);
    }
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'initial');
    return root;
}

function manifest(folder, entries) {
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, skills.SKILLS_MANIFEST_FILE);
    fs.writeFileSync(file, `${JSON.stringify(entries, null, 2)}\n`);
    return file;
}

function fixture(t, label) {
    const root = path.join(suite, `${label}-${process.hrtime.bigint()}`);
    const upstreamA = sourceRepo(path.join(root, 'upstream-a'), ['a1', 'a2']);
    const upstreamB = sourceRepo(path.join(root, 'upstream-b'), ['b1']);
    const nameA = `SrcA${process.hrtime.bigint()}`;
    const nameB = `SrcB${process.hrtime.bigint()}`;
    const target = path.join(root, 'target');
    const file = manifest(target, [
        { name: nameA, url: upstreamA, skills: ['a1', 'a2'] },
        { name: nameB, url: upstreamB, skills: ['b1'] },
    ]);
    const cacheA = path.join(REPOS_DIR, nameA);
    const cacheB = path.join(REPOS_DIR, nameB);
    t.after(() => {
        for (const directory of [root, cacheA, cacheB]) fs.rmSync(directory, { recursive: true, force: true });
    });
    // First materialization is a standalone install (clones the caches).
    skills.installSkillsFromManifest(file, { targetRoot: target });
    return { root, target, file, cacheA, cacheB, nameA, nameB, link: name => path.join(target, '.agents', 'skills', name) };
}

const record = (outcome, code = outcome === 'unchanged' ? 'current' : outcome) => ({ outcome, code, reason: `${outcome} for test` });

test('update mode consumes one operation record per source and never pulls again', t => {
    const f = fixture(t, 'one-pull');
    resetTrace();
    skills.installSkillsFromManifest(f.file, { targetRoot: f.target });
    assert.ok(mutations().some(line => line.includes(' fetch ')), 'standalone installs still fetch through the verified API');
    resetTrace();
    const result = skills.installSkillsFromManifest(f.file, {
        targetRoot: f.target, pruneMissing: true,
        sourceOutcomes: new Map([[f.cacheA, record('changed', 'fast-forward')], [f.cacheB, record('unchanged')]]),
    });
    assert.deepEqual(mutations(), []);
    assert.deepEqual(result.sources.map(item => item.state), ['updated', 'current']);
    assert.deepEqual(result.skills.sort(), ['a1', 'a2', 'b1']);
});

test('a refused, failed or uncertain source is not pulled again and keeps its output', t => {
    for (const outcome of ['skipped', 'failed', 'uncertain']) {
        const f = fixture(t, `refused-${outcome}`);
        // The cache now lacks a2, which would otherwise be pruned.
        fs.rmSync(path.join(f.cacheA, 'skills', 'a2'), { recursive: true });
        const before = fs.readFileSync(f.file, 'utf8');
        resetTrace();
        const result = skills.installSkillsFromManifest(f.file, {
            targetRoot: f.target, pruneMissing: true,
            sourceOutcomes: [
                { ...record(outcome, 'upstream-mismatch'), details: { checkout: { path: f.cacheA } } },
                { ...record('unchanged'), details: { checkout: { path: f.cacheB } } },
            ],
        });
        assert.deepEqual(mutations(), [], `${outcome}: never retried under another policy`);
        // Skipped and failed updates left the checkout untouched: it is used as
        // it is but prunes nothing. An uncertain checkout is not read at all.
        assert.equal(result.sources[0].state, outcome === 'uncertain' ? 'retained' : 'stale');
        assert.equal(result.sources[0].code, 'upstream-mismatch');
        assert.deepEqual(result.prunedSkills, []);
        assert.equal(fs.readFileSync(f.file, 'utf8'), before, 'the manifest selection is not pruned');
        assert.ok(fs.lstatSync(f.link('a2')).isSymbolicLink(), 'retained output survives');
        assert.deepEqual(result.retainedSkills.sort(), outcome === 'uncertain' ? ['a1', 'a2'] : ['a2']);
        assert.ok(fs.lstatSync(f.link('a1')).isSymbolicLink());
        assert.ok(fs.lstatSync(f.link('b1')).isSymbolicLink());
    }
});

test('a targeted source refresh re-evaluates consumers with the complete owner set', t => {
    const f = fixture(t, 'targeted');
    fs.rmSync(path.join(f.cacheA, 'skills', 'a2'), { recursive: true });
    const other = manifest(path.join(f.root, 'unrelated'), [{ name: f.nameB, url: path.join(f.root, 'upstream-b'), skills: ['b1'] }]);
    resetTrace();
    const refreshed = skills.refreshSkillConsumersForSource({
        folders: [f.target, path.dirname(other)], sourcePath: f.cacheA, sourceOutcomes: new Map([[f.cacheA, record('changed', 'fast-forward')]]),
    });
    assert.deepEqual(mutations(), []);
    assert.equal(refreshed.refreshed.length, 1, 'only consumers declaring the source are refreshed');
    assert.deepEqual(refreshed.refreshed[0].prunedSkills, [{ repository: f.nameA, skill: 'a2' }]);
    assert.throws(() => fs.lstatSync(f.link('a2')), { code: 'ENOENT' });
    assert.ok(fs.lstatSync(f.link('b1')).isSymbolicLink(), 'another source is never pruned by a one-source refresh');
    assert.equal(refreshed.refreshed[0].sources.find(item => item.name === f.nameB).state, 'not-updated');
});

test('source records match through checkout aliases', t => {
    const f = fixture(t, 'alias');
    const alias = path.join(f.root, 'alias-a');
    fs.symlinkSync(f.cacheA, alias);
    fs.rmSync(path.join(f.cacheA, 'skills', 'a2'), { recursive: true });
    const result = skills.installSkillsFromManifest(f.file, {
        targetRoot: f.target, pruneMissing: true, sourceOutcomes: { [alias]: record('failed', 'fetch-failed') },
    });
    assert.equal(result.sources[0].state, 'stale');
    assert.equal(result.sources[0].code, 'fetch-failed');
    assert.ok(fs.lstatSync(f.link('a2')).isSymbolicLink());
});

test('a user-retargeted output link is preserved and never becomes source authority', t => {
    const f = fixture(t, 'retargeted');
    const elsewhere = sourceRepo(path.join(f.root, 'elsewhere'), ['a1']);
    fs.unlinkSync(f.link('a1'));
    fs.symlinkSync(path.join(elsewhere, 'skills', 'a1'), f.link('a1'));
    resetTrace();
    const result = skills.installSkillsFromManifest(f.file, {
        targetRoot: f.target, sourceOutcomes: new Map([[f.cacheA, record('unchanged')], [f.cacheB, record('unchanged')]]),
    });
    assert.ok(result.managedExport.diagnostics.some(item => item.name === 'a1' && item.reason === 'edited-output-preserved'));
    assert.equal(fs.readlinkSync(f.link('a1')), path.join(elsewhere, 'skills', 'a1'));
    assert.equal(fs.readFileSync(traceLog, 'utf8').includes(elsewhere), false, 'Git never ran in the retargeted repository');
});

test('duplicates stay ambiguous and a removed last skill is pruned only from a verified source', t => {
    const f = fixture(t, 'duplicates');
    const dup = manifest(path.join(f.root, 'dup'), [
        { name: f.nameA, url: path.join(f.root, 'upstream-a'), skills: ['a1'] },
        { name: `${f.nameA}Copy`, url: path.join(f.root, 'upstream-a-copy'), skills: ['a1'] },
    ]);
    sourceRepo(path.join(f.root, 'upstream-a-copy'), ['a1']);
    t.after(() => fs.rmSync(path.join(REPOS_DIR, `${f.nameA}Copy`), { recursive: true, force: true }));
    assert.throws(() => skills.installSkillsFromManifest(dup, { targetRoot: path.dirname(dup), sourceOutcomes: new Map() }), /Duplicate skill 'a1'/);
    fs.rmSync(path.join(f.cacheB, 'skills'), { recursive: true });
    const result = skills.installSkillsFromManifest(f.file, {
        targetRoot: f.target, pruneMissing: true, sourceOutcomes: new Map([[f.cacheA, record('unchanged')], [f.cacheB, record('changed', 'fast-forward')]]),
    });
    assert.deepEqual(result.prunedSkills, [{ repository: f.nameB, skill: 'b1' }]);
    assert.throws(() => fs.lstatSync(f.link('b1')), { code: 'ENOENT' });
});

test('source relocation to a workspace checkout re-points owned links', t => {
    const f = fixture(t, 'relocation');
    const local = path.join(workspace, f.nameB);
    t.after(() => fs.rmSync(local, { recursive: true, force: true }));
    git(workspace, 'clone', '-q', f.cacheB, local);
    const result = skills.installSkillsFromManifest(f.file, { targetRoot: f.target, sourceOutcomes: new Map() });
    assert.equal(result.sources.find(item => item.name === f.nameB).checkoutPath, fs.realpathSync(local));
    assert.equal(fs.realpathSync(f.link('b1')), fs.realpathSync(path.join(local, 'skills', 'b1')));
});

test('declared sources are listed per folder without touching Git', t => {
    const f = fixture(t, 'declared');
    const broken = path.join(f.root, 'broken');
    fs.mkdirSync(broken);
    fs.writeFileSync(path.join(broken, skills.SKILLS_MANIFEST_FILE), '{');
    resetTrace();
    const declared = skills.listDeclaredSkillSources([f.target, broken, path.join(f.root, 'no-manifest')]);
    assert.deepEqual(fs.readFileSync(traceLog, 'utf8'), '');
    assert.deepEqual(declared.filter(item => !item.error).map(item => [item.name, item.origin, item.checkoutPath, item.exists]), [
        [f.nameA, 'managed', fs.realpathSync(f.cacheA), true],
        [f.nameB, 'managed', fs.realpathSync(f.cacheB), true],
    ]);
    assert.match(declared.find(item => item.error).error, /Invalid JSON/);
});

test('output tracked by the target repository is classified with its own index', t => {
    const f = fixture(t, 'repo-owned');
    const target = path.join(f.root, 'tracked-target');
    fs.mkdirSync(path.join(target, '.agents', 'skills', 'a1'), { recursive: true });
    fs.writeFileSync(path.join(target, '.agents', 'skills', 'a1', 'SKILL.md'), '# repository copy\n');
    git(target, 'init', '-q');
    git(target, 'add', '.');
    git(target, 'commit', '-q', '-m', 'tracked skill');
    const file = manifest(target, [{ name: f.nameA, url: path.join(f.root, 'upstream-a'), skills: ['a1'] }]);
    const result = skills.installSkillsFromManifest(file, { targetRoot: target });
    assert.deepEqual(result.repositoryOwned, { count: 1, unchanged: ['a1'], modified: [] });
    assert.equal(fs.readFileSync(path.join(target, '.agents', 'skills', 'a1', 'SKILL.md'), 'utf8'), '# repository copy\n');
    fs.appendFileSync(path.join(target, '.agents', 'skills', 'a1', 'SKILL.md'), 'edit\n');
    assert.deepEqual(skills.installSkillsFromManifest(file, { targetRoot: target }).repositoryOwned.modified, ['a1']);
    const plain = path.join(f.root, 'plain-target');
    fs.mkdirSync(path.join(plain, '.agents', 'skills', 'a1'), { recursive: true });
    const unproven = skills.installSkillsFromManifest(manifest(plain, [{ name: f.nameA, url: path.join(f.root, 'upstream-a'), skills: ['a1'] }]), { targetRoot: plain });
    assert.equal(unproven.repositoryOwned.count, 0);
    assert.ok(unproven.managedExport.diagnostics.some(item => item.reason === 'unrecorded-output-preserved'));
});

test('default-skill consumers keep their recorded selection and legacy consumers are never broadened', t => {
    const name = `Defaults${process.hrtime.bigint()}`;
    const source = path.join(REPOS_DIR, name);
    t.after(() => fs.rmSync(source, { recursive: true, force: true }));
    sourceRepo(source, ['s1']);
    const consumer = path.join(suite, `consumer-${process.hrtime.bigint()}`);
    fs.mkdirSync(consumer);
    const first = skills.installDefaultSkills(name, { targetRoot: consumer, pruneMissing: true });
    assert.equal(first.selection.mode, 'all');
    const ledgerFile = path.join(consumer, '.agents', '.ploinky-skill-exports.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(ledgerFile, 'utf8')).consumers[`defaults:${name}`], { selection: 'all', source: name });
    fs.mkdirSync(path.join(source, 'skills', 's2'));
    fs.writeFileSync(path.join(source, 'skills', 's2', 'SKILL.md'), '# s2\n');
    assert.deepEqual(skills.installDefaultSkills(name, { targetRoot: consumer, pruneMissing: true }).managedExport.installed, ['s2']);

    // A legacy ledger has owned entries but no recorded selection.
    const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
    delete ledger.consumers;
    fs.writeFileSync(ledgerFile, `${JSON.stringify(ledger, null, 2)}\n`);
    fs.mkdirSync(path.join(source, 'skills', 's3'));
    fs.writeFileSync(path.join(source, 'skills', 's3', 'SKILL.md'), '# s3\n');
    const legacy = skills.installDefaultSkills(name, { targetRoot: consumer, pruneMissing: true });
    assert.deepEqual(legacy.selection, { mode: 'legacy-unknown', notBroadened: ['s3'] });
    assert.equal(fs.existsSync(path.join(consumer, '.agents', 'skills', 's3')), false);
    assert.ok(fs.existsSync(path.join(consumer, '.agents', 'skills', 's2')), 'legacy owned output is kept');
    const explicit = skills.installDefaultSkills(name, { targetRoot: consumer, consumerSelection: 'all' });
    assert.deepEqual(explicit.managedExport.installed, ['s3']);

    // A refused source record leaves the consumer untouched.
    fs.rmSync(path.join(source, 'skills', 's3'), { recursive: true });
    resetTrace();
    const skipped = skills.installDefaultSkills(name, { targetRoot: consumer, pruneMissing: true, sourceOutcomes: new Map([[source, record('skipped', 'dirty-checkout')]]) });
    assert.equal(skipped.sourceState, 'stale');
    assert.deepEqual(skipped.retainedSkills, ['s3']);
    assert.ok(fs.lstatSync(path.join(consumer, '.agents', 'skills', 's3')).isSymbolicLink(), 'a skipped source prunes nothing');
    const uncertain = skills.installDefaultSkills(name, { targetRoot: consumer, pruneMissing: true, sourceOutcomes: new Map([[source, record('uncertain', 'recovery-required')]]) });
    assert.equal(uncertain.sourceSkipped.code, 'recovery-required');
    assert.deepEqual(mutations(), []);
});

test('the host refreshes only exclusions after a container run deferred them', t => {
    const f = fixture(t, 'host-exclusions');
    const project = path.join(f.root, 'project');
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'README.md'), 'x\n');
    git(project, 'init', '-q');
    git(project, 'add', 'README.md');
    git(project, 'commit', '-q', '-m', 'initial');
    const inBox = tx.syncManagedSkillExports({
        folder: project, owner: 'manifest', mode: 'symlink', claude: 'root-or-skills',
        sources: [{ name: 'a1', path: path.join(f.cacheA, 'skills', 'a1') }],
        exclusions: exclusionsModule.createSkillExclusionPlanner({ containerExecutor: true }),
    });
    assert.equal(inBox.exclusions.code, 'exclusions-executor-view-unverified');
    assert.equal(inBox.exclusions.folder, fs.realpathSync(project));
    assert.match(git(project, 'status', '--porcelain'), /\?\? \.agents\//);
    const ledger = fs.readFileSync(path.join(project, '.agents', '.ploinky-skill-exports.json'), 'utf8');
    resetTrace();
    const host = skills.refreshExportExclusions({ folder: inBox.exclusions.folder });
    assert.equal(host.exclusions.status, 'published');
    assert.equal(git(project, 'status', '--porcelain'), '');
    assert.equal(fs.readFileSync(path.join(project, '.agents', '.ploinky-skill-exports.json'), 'utf8'), ledger, 'no skill publication');
    assert.deepEqual(mutations(), []);
    assert.equal(skills.refreshExportExclusions({ folder: project }).exclusions.status, 'unchanged');
    assert.equal(skills.refreshExportExclusions({ folder: path.join(f.root, 'no-exports') }).exclusions.code, 'no-export-folder');
});
