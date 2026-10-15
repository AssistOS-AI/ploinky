// The harness gives the local-llms candidate's offline suites and the vLLM calibration tool a runner-owned scratch copy of
// the exact candidate with the pworker engine installed by one uniform command (decision U13). Offline: the engine is a local
// git+file fixture repository, and npm is the real npm.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { liveSourceDigest } from '../hardware-limits/liveCommon.mjs';
import { LLM_SOURCE_DIRECTORY } from '../hardware-limits/liveLlmNames.mjs';
import { assertModelSource } from '../hardware-limits/liveModelCases.mjs';
import { randomRunId } from '../hardware-limits/fixtures.mjs';
import {
    LOCAL_LLMS_INSTALL_COMMAND,
    assertLocalLlmsLayoutUnchanged,
    buildReport,
    copyFrozenTree,
    createBaselineStage,
    prepareLocalLlmsLayout,
    prepareVllmToolTree,
    recordLocalLlmInstall,
    runSuite,
    treeDigest,
    validateInstallRecord,
    vllmStage,
} from '../hardware-limits/verify.mjs';

const GIT_ENV = {
    ...process.env, GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
};
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: GIT_ENV }).trim();

function scratchDirectory(t, prefix = 'hwl-s-') {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

function write(root, files) {
    for (const [name, body] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
        fs.writeFileSync(path.join(root, name), body);
    }
}

function commit(root, message) {
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', message);
    return git(root, 'rev-parse', 'HEAD');
}

// A stand-in for the engine package: pworker's package shape and the one module the measurement snippet imports.
function pworkerFixture(t, marker = 'pworker-fixture') {
    const root = path.join(scratchDirectory(t, 'hwl-pw-'), 'pworker');
    fs.mkdirSync(root);
    git(root, 'init', '-q', '-b', 'main');
    write(root, {
        'package.json': JSON.stringify({ name: 'pworker', version: '0.0.0', type: 'module', exports: { './local-llm': './lib/local-llm/index.mjs' }, dependencies: {} }),
        'lib/local-llm/index.mjs': `export const marker = ${JSON.stringify(marker)};\n`,
        'lib/local-llm/controller/downloader.mjs': `import path from 'node:path';
export function artifactPaths({ root, artifact }) {
    const file = path.join(path.resolve(root), ...artifact.repo.split('/'), artifact.commit, ...artifact.file.split('/'));
    return { root: path.resolve(root), file };
}
`,
    });
    return { root, sha: commit(root, 'engine fixture') };
}

const POST_MOVE_TEST = `import assert from 'node:assert/strict';
import test from 'node:test';
import { marker } from 'pworker/local-llm';
test('the scratch copy resolves the installed engine', () => assert.equal(marker, 'pworker-fixture'));
`;

// A local-llms tree that pins the fixture engine, as the post-move candidate pins pworker.
function postMoveCandidate(t, engine, { pin = engine.sha, extra = {} } = {}) {
    const root = path.join(scratchDirectory(t, 'hwl-ll-'), 'local-llms');
    fs.mkdirSync(root);
    git(root, 'init', '-q', '-b', 'main');
    write(root, {
        '.gitignore': 'node_modules/\n',
        'local-llm/.npmrc': 'bin-links=false\nignore-scripts=true\n',
        'local-llm/package.json': JSON.stringify({ name: 'local-llm', private: true, type: 'module', dependencies: { pworker: `git+file://${engine.root}#${pin}` } }),
        'local-llm/src/value.mjs': 'export const value = 1;\n',
        'local-llm/tests/pworker.test.mjs': POST_MOVE_TEST,
        ...extra,
    });
    commit(root, 'candidate');
    return root;
}

// The tree as it was before the move: a package.json without dependencies, no .npmrc, no engine.
function preMoveCandidate(t) {
    const root = path.join(scratchDirectory(t, 'hwl-pre-'), 'local-llms');
    fs.mkdirSync(root);
    git(root, 'init', '-q', '-b', 'main');
    write(root, {
        'local-llm/package.json': JSON.stringify({ name: 'local-llm', private: true, type: 'module', scripts: { test: 'node --test tests/*.test.mjs' } }),
        'local-llm/src/value.mjs': 'export const value = 1;\n',
        'local-llm/tests/value.test.mjs': `import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { value } from '../src/value.mjs';\ntest('value', () => assert.equal(value, 1));\n`,
    });
    commit(root, 'pre-move candidate');
    return root;
}

const cleanDigest = root => `git-tree:${git(root, 'rev-parse', 'HEAD^{tree}')}`;
const prepare = (t, root, sourceDigest, options = {}) => {
    const stageParent = scratchDirectory(t, 'hwl-st-');
    const layout = prepareLocalLlmsLayout({ candidateRoot: root, sourceDigest, stageParent, runId: randomRunId(), ...options });
    return { layout, stageParent };
};

async function suiteIn(t, root, file) {
    const scratch = scratchDirectory(t, 'hwl-ev-');
    return runSuite({ root, files: [file], runId: randomRunId(), childId: 'scratch', eventsPath: path.join(scratch, 'events.jsonl'), deadlineMs: 120000 });
}

test('SCR.the-uniform-install-command-is-exactly-the-decided-one', () => {
    assert.deepEqual([...LOCAL_LLMS_INSTALL_COMMAND], ['npm', '--prefix', 'local-llm', 'install', '--ignore-scripts', '--no-bin-links', '--no-package-lock']);
    assert.equal(Object.isFrozen(LOCAL_LLMS_INSTALL_COMMAND), true);
});

test('SCR.a-clean-candidate-is-archived-installed-and-records-the-pworker-commit-and-digest-while-the-frozen-stage-has-no-node-modules', async (t) => {
    const engine = pworkerFixture(t);
    const candidate = postMoveCandidate(t, engine);
    // The real local-llms checkout holds an ignored local-llm/node_modules; the candidate's identity stays its git tree.
    write(candidate, { 'local-llm/node_modules/pworker/ignored.txt': 'an ignored file of the candidate\n' });
    const digest = cleanDigest(candidate);
    const { layout, stageParent } = prepare(t, candidate, digest);
    assert.equal(layout.install.pworkerCommit, engine.sha);
    assert.equal(layout.install.pworkerTreeDigest, treeDigest(path.join(layout.root, 'local-llm', 'node_modules', 'pworker')));
    assert.notEqual(layout.install.pworkerTreeDigest, treeDigest(path.join(candidate, 'local-llm', 'node_modules', 'pworker')), 'the ignored file of the candidate is not what was installed');
    assert.equal(fs.existsSync(path.join(layout.root, 'local-llm', 'node_modules', 'pworker', 'ignored.txt')), false);
    assert.equal(fs.existsSync(path.join(layout.root, 'local-llm', 'node_modules', 'pworker', 'lib', 'local-llm', 'index.mjs')), true);
    assert.equal(fs.readdirSync(layout.root).includes('.git'), false);
    assert.deepEqual(layout.install, validateInstallRecord(layout.install));
    // The suite runs in the scratch copy and sees the installed engine; it would not resolve it in a tree without one.
    const result = await suiteIn(t, layout.root, 'local-llm/tests/pworker.test.mjs');
    assert.equal(result.verdict, 'PASS', JSON.stringify(result.problems));
    assert.equal(result.discovered, 1);
    assertLocalLlmsLayoutUnchanged(layout);
    // The candidate itself was not touched.
    assert.equal(cleanDigest(candidate), digest);
    assert.equal(git(candidate, 'status', '--porcelain', '--untracked-files=all'), '');

    // The frozen stage is built from the committed revision and never gets a node_modules, whatever the checkout holds.
    const frozen = path.join(scratchDirectory(t, 'hwl-fz-'), 'stage');
    createBaselineStage(candidate, git(candidate, 'rev-parse', 'HEAD'), `${frozen}.tmp`);
    const frozenTree = path.join(frozen, LLM_SOURCE_DIRECTORY, 'local-llm');
    fs.mkdirSync(path.dirname(frozenTree), { recursive: true });
    copyFrozenTree(path.join(`${frozen}.tmp`, 'local-llm'), frozenTree);
    assert.equal(fs.existsSync(path.join(frozenTree, 'node_modules')), false);
    assert.equal(fs.existsSync(path.join(frozenTree, '.npmrc')), true);
    // assertModelSource compares the frozen source with the staged workspace copy, whose node_modules is only Ploinky's empty mount point.
    const workspace = path.join(scratchDirectory(t, 'hwl-ws-'), 'ws');
    const staged = path.join(workspace, 'local-llms', 'local-llm');
    fs.mkdirSync(path.dirname(staged), { recursive: true });
    copyFrozenTree(frozenTree, staged);
    fs.mkdirSync(path.join(staged, 'node_modules'));
    const profile = { provision: { llm: { sourcePath: frozenTree, treeDigest: liveSourceDigest(frozenTree), manifest: null } }, model: { profile: 'cpu' }, workspace: { path: workspace }, llm: { image: 'x' } };
    assert.equal(assertModelSource(profile).originalTreeDigest, profile.provision.llm.treeDigest);
    // A node_modules in the frozen source is a code substitution that assertModelSource refuses.
    fs.mkdirSync(path.join(frozenTree, 'node_modules'));
    assert.throws(() => assertModelSource(profile), /code substitution|Frozen model source changed/);
    assert.deepEqual(fs.readdirSync(stageParent), [path.basename(layout.stage)], 'the stage parent holds only the layout, which the caller removes');
});

test('SCR.b-PW-C13-a-dirty-candidate-with-a-failing-uncommitted-assertion-and-an-untracked-import-is-tested-as-it-is-never-as-HEAD', async (t) => {
    const engine = pworkerFixture(t);
    const candidate = postMoveCandidate(t, engine, { extra: {
        'local-llm/tests/value.test.mjs': `import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { value } from '../src/value.mjs';\ntest('value', () => assert.equal(value, 1));\n`,
    } });
    const headDigest = cleanDigest(candidate);
    // Control: the committed tree passes.
    const head = prepare(t, candidate, headDigest);
    assert.equal((await suiteIn(t, head.layout.root, 'local-llm/tests/value.test.mjs')).verdict, 'PASS');
    // The uncommitted state: the assertion now fails, and the test imports a file git does not track.
    write(candidate, {
        'local-llm/tests/value.test.mjs': `import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { value } from '../src/value.mjs';\nimport { expected } from '../src/untracked.mjs';\ntest('value', () => assert.equal(value, expected));\n`,
        'local-llm/src/untracked.mjs': 'export const expected = 2;\n',
    });
    assert.notEqual(git(candidate, 'status', '--porcelain', '--untracked-files=all'), '');
    const dirtyDigest = treeDigest(candidate);
    const dirty = prepare(t, candidate, dirtyDigest);
    assert.equal(fs.existsSync(path.join(dirty.layout.root, 'local-llm', 'src', 'untracked.mjs')), true, 'the untracked import is in the copy');
    assert.match(fs.readFileSync(path.join(dirty.layout.root, 'local-llm', 'tests', 'value.test.mjs'), 'utf8'), /untracked\.mjs/);
    const result = await suiteIn(t, dirty.layout.root, 'local-llm/tests/value.test.mjs');
    assert.equal(result.verdict, 'FAIL', 'the dirty candidate fails as it is; it is never reported as its passing HEAD');
    assert.ok(result.newFailures.length > 0 || result.problems.length > 0);
    assertLocalLlmsLayoutUnchanged(dirty.layout);
    // A clean digest recorded at configure time no longer describes the dirty working tree: refused before any copy.
    const before = fs.readdirSync(dirty.stageParent);
    assert.throws(() => prepareLocalLlmsLayout({ candidateRoot: candidate, sourceDigest: headDigest, stageParent: dirty.stageParent, runId: randomRunId() }), /changed before staging/);
    assert.deepEqual(fs.readdirSync(dirty.stageParent), before);
    // A content digest that is not the working tree's is refused after the copy, before anything is installed.
    let installs = 0;
    assert.throws(() => prepareLocalLlmsLayout({ candidateRoot: candidate, sourceDigest: `sha256:${'0'.repeat(64)}`, stageParent: dirty.stageParent, runId: randomRunId(), install: () => { installs += 1; } }),
        /differs from the configured candidate digest/);
    assert.equal(installs, 0);
    assert.deepEqual(fs.readdirSync(dirty.stageParent), before);
});

test('SCR.c-a-dirty-candidate-that-holds-a-node-modules-is-refused-before-it-is-copied', (t) => {
    const engine = pworkerFixture(t);
    const candidate = postMoveCandidate(t, engine);
    write(candidate, { 'local-llm/src/dirty.mjs': 'export const dirty = true;\n', 'local-llm/node_modules/pworker/index.js': 'candidate code\n' });
    const stageParent = scratchDirectory(t, 'hwl-st-');
    let installs = 0;
    assert.throws(() => prepareLocalLlmsLayout({ candidateRoot: candidate, sourceDigest: treeDigest(candidate), stageParent, runId: randomRunId(), install: () => { installs += 1; } }),
        (error) => error.name === 'SchemaError' && /contains a node_modules at local-llm\/node_modules/.test(error.message));
    assert.equal(installs, 0);
    assert.deepEqual(fs.readdirSync(stageParent), [], 'nothing was copied or left behind');
    // Any node_modules, at any depth, is a refusal.
    fs.rmSync(path.join(candidate, 'local-llm', 'node_modules'), { recursive: true });
    write(candidate, { 'tools/node_modules/x.js': 'x\n' });
    assert.throws(() => prepareLocalLlmsLayout({ candidateRoot: candidate, sourceDigest: treeDigest(candidate), stageParent, runId: randomRunId() }), /contains a node_modules at tools\/node_modules/);
    assert.deepEqual(fs.readdirSync(stageParent), []);
});

test('SCR.d-a-scratch-copy-changed-during-the-suite-fails-the-recheck-and-only-local-llm-node-modules-is-excluded', (t) => {
    const engine = pworkerFixture(t);
    const candidate = postMoveCandidate(t, engine);
    const { layout } = prepare(t, candidate, cleanDigest(candidate));
    assertLocalLlmsLayoutUnchanged(layout);
    const tree = path.join(layout.root, 'local-llm');
    // Writes into the install output that leave the installed pworker as it was are the one thing excluded.
    write(tree, { 'node_modules/.cache/x': 'cache\n' });
    assertLocalLlmsLayoutUnchanged(layout);
    fs.rmSync(path.join(tree, 'node_modules', '.cache'), { recursive: true });
    const mutate = (file, text) => { const target = path.join(tree, file); const before = fs.existsSync(target) ? fs.readFileSync(target) : null; write(tree, { [file]: text });
        return () => (before === null ? fs.rmSync(target, { recursive: true, force: true }) : fs.writeFileSync(target, before)); };
    const attempts = [
        ['a new source file', () => mutate('src/new.mjs', 'export const x = 1;\n'), /changed during the suite/],
        ['a changed tracked file', () => mutate('src/value.mjs', 'export const value = 2;\n'), /changed during the suite/],
        ['a sibling whose name only starts with node_modules', () => mutate('node_modules-extra/x.js', 'x\n'), /changed during the suite/],
        ['a node_modules elsewhere in the tree', () => mutate('src/node_modules/x.js', 'x\n'), /changed during the suite/],
        ['a changed installed pworker', () => mutate('node_modules/pworker/lib/local-llm/index.mjs', 'export const marker = "other";\n'), /installed pworker changed/],
        ['a new file in the installed pworker', () => mutate('node_modules/pworker/lib/local-llm/extra.mjs', 'export {};\n'), /installed pworker changed/],
    ];
    for (const [label, change, pattern] of attempts) {
        const undo = change();
        assert.throws(() => assertLocalLlmsLayoutUnchanged(layout), pattern, label);
        undo();
        assertLocalLlmsLayoutUnchanged(layout);
    }
});

test('SCR.d-a-scratch-copy-whose-install-output-is-removed-fails-the-recheck-although-node-modules-is-excluded-from-the-identity', (t) => {
    const engine = pworkerFixture(t);
    const candidate = postMoveCandidate(t, engine);
    const { layout } = prepare(t, candidate, cleanDigest(candidate));
    fs.rmSync(path.join(layout.root, 'local-llm', 'node_modules'), { recursive: true });
    assert.throws(() => assertLocalLlmsLayoutUnchanged(layout), /installed pworker \(none\)/);
});

test('SCR.e-the-uniform-command-on-a-pre-move-shaped-tree-records-null-and-changes-nothing', async (t) => {
    const candidate = preMoveCandidate(t);
    const digest = cleanDigest(candidate);
    const { layout } = prepare(t, candidate, digest);
    assert.deepEqual(layout.install, { command: [...LOCAL_LLMS_INSTALL_COMMAND], pworkerCommit: null, pworkerTreeDigest: null });
    assert.equal(fs.existsSync(path.join(layout.root, 'local-llm', 'node_modules')), false, 'npm wrote no node_modules');
    assert.equal(treeDigest(layout.root), layout.stageDigest);
    assert.equal((await suiteIn(t, layout.root, 'local-llm/tests/value.test.mjs')).verdict, 'PASS');
    assertLocalLlmsLayoutUnchanged(layout);
    // It is the same function and the same command: the pre-move tree is not detected, only recorded.
    assert.deepEqual(recordLocalLlmInstall(layout.root), { pworkerCommit: null, pworkerTreeDigest: null });
});

test('SCR.a-failed-install-never-passes-and-leaves-nothing-behind', (t) => {
    const engine = pworkerFixture(t);
    const absent = 'a'.repeat(40);
    const candidate = postMoveCandidate(t, engine, { pin: absent });
    const stageParent = scratchDirectory(t, 'hwl-st-');
    assert.throws(() => prepareLocalLlmsLayout({ candidateRoot: candidate, sourceDigest: cleanDigest(candidate), stageParent, runId: randomRunId() }), /install .* failed/);
    assert.deepEqual(fs.readdirSync(stageParent), []);
    // A command that exits 0 without installing what the tree pins is not a pass either.
    const good = postMoveCandidate(t, engine);
    assert.throws(() => prepareLocalLlmsLayout({ candidateRoot: good, sourceDigest: cleanDigest(good), stageParent, runId: randomRunId(), install: () => {} }),
        /installed pworker \(none\) is not the one local-llm\/package\.json pins/);
    assert.deepEqual(fs.readdirSync(stageParent), []);
    // A command that changes the tree outside node_modules is refused.
    assert.throws(() => prepareLocalLlmsLayout({ candidateRoot: good, sourceDigest: cleanDigest(good), stageParent, runId: randomRunId(),
        install: (root) => { fs.writeFileSync(path.join(root, 'local-llm', 'package-lock.json'), '{}\n'); } }), /changed files outside local-llm\/node_modules/);
    assert.deepEqual(fs.readdirSync(stageParent), []);
});

function recordFixture(t, { declared, resolved, entry = true, symlink = false }) {
    const root = scratchDirectory(t, 'hwl-rec-');
    write(root, { 'local-llm/package.json': JSON.stringify(declared === undefined ? { name: 'x' } : { name: 'x', dependencies: { pworker: declared } }) });
    if (resolved !== undefined) {
        const packages = entry ? { 'node_modules/pworker': { version: '0.0.0', resolved } } : { 'node_modules/other': { version: '1.0.0', resolved: 'https://registry.example/other.tgz' } };
        write(root, { 'local-llm/node_modules/.package-lock.json': JSON.stringify({ packages }) });
        if (symlink) {
            fs.mkdirSync(path.join(root, 'elsewhere'));
            fs.symlinkSync(path.join(root, 'elsewhere'), path.join(root, 'local-llm', 'node_modules', 'pworker'));
        } else write(root, { 'local-llm/node_modules/pworker/index.js': 'code\n' });
    }
    return root;
}

test('SCR.the-recorded-commit-is-the-text-after-the-hash-of-a-ssh-or-https-resolution-and-must-be-the-pinned-one', (t) => {
    const sha = '4668a3f0e2cae0c85463945def068741dc8c2b68';
    const https = `git+https://github.com/AssistOS-AI/Ploinky-Worker.git#${sha}`;
    const ssh = `git+ssh://git@github.com/AssistOS-AI/Ploinky-Worker.git#${sha}`;
    for (const resolved of [https, ssh]) {
        const root = recordFixture(t, { declared: https, resolved });
        assert.deepEqual(recordLocalLlmInstall(root), { pworkerCommit: sha, pworkerTreeDigest: treeDigest(path.join(root, 'local-llm', 'node_modules', 'pworker')) });
    }
    const refused = [
        ['a different installed commit', { declared: https, resolved: `${ssh.slice(0, -40)}${'b'.repeat(40)}` }, /installed pworker .* is not the one/],
        ['a short installed commit', { declared: https, resolved: `${ssh.slice(0, -40)}${sha.slice(0, 7)}` }, /not pinned to a full 40-hex commit/],
        ['an installed commit in capitals', { declared: https, resolved: `${ssh.slice(0, -40)}${sha.toUpperCase()}` }, /not pinned to a full 40-hex commit/],
        ['an installed resolution without a commit', { declared: https, resolved: 'https://registry.example/pworker.tgz' }, /not pinned to a full 40-hex commit/],
        ['a declared dependency that is not a full commit', { declared: 'git+https://github.com/AssistOS-AI/Ploinky-Worker.git#main', resolved: ssh }, /not pinned to a full 40-hex commit/],
        ['a declared range', { declared: '^1.0.0', resolved: ssh }, /not pinned to a full 40-hex commit/],
        ['a pinned dependency with nothing installed', { declared: https }, /installed pworker \(none\)/],
        ['an installed lock without the pworker entry', { declared: https, resolved: ssh, entry: false }, /installed pworker \(none\)/],
        ['an installed pworker that nothing pins', { declared: undefined, resolved: ssh }, /is not the one local-llm\/package\.json pins \(none\)/],
        ['an installed pworker that is a link', { declared: https, resolved: ssh, symlink: true }, /not a real directory/],
    ];
    for (const [label, options, pattern] of refused) assert.throws(() => recordLocalLlmInstall(recordFixture(t, options)), pattern, label);
    assert.deepEqual(recordLocalLlmInstall(recordFixture(t, { declared: undefined })), { pworkerCommit: null, pworkerTreeDigest: null });
});

test('SCR.the-report-carries-a-validated-install-record-for-the-suite-that-has-one', () => {
    const suite = { repo: 'localLlms', files: [], exitCode: 0, signal: null, streamComplete: true, discovered: 0, completed: 0, problems: [], newFailures: [], baselineFailures: [], eventsPaths: [] };
    const record = { command: [...LOCAL_LLMS_INSTALL_COMMAND], pworkerCommit: 'a'.repeat(40), pworkerTreeDigest: `sha256:${'b'.repeat(64)}` };
    const make = (install) => buildReport({ runId: 'r', command: 'offline', phase: 'p5', suites: [{ ...suite, ...(install === undefined ? {} : { install }) }], cases: [], sources: {}, verdict: 'PASS' });
    assert.deepEqual(make(record).suites[0].install, record);
    assert.deepEqual(make({ ...record, pworkerCommit: null, pworkerTreeDigest: null }).suites[0].install.pworkerCommit, null);
    assert.equal(Object.hasOwn(make(undefined).suites[0], 'install'), false);
    for (const bad of [
        { ...record, extra: 1 },
        { command: record.command },
        { ...record, command: ['npm', 'install'] },
        { ...record, pworkerCommit: 'a'.repeat(39) },
        { ...record, pworkerTreeDigest: null },
        { ...record, pworkerCommit: null },
        { ...record, pworkerTreeDigest: 'sha256:xyz' },
    ]) assert.throws(() => make(bad), /install record/, JSON.stringify(bad));
});

// --- the vLLM calibration tool ---------------------------------------------------------------------------------------------
function frozenCandidate(t, engine) {
    const source = postMoveCandidate(t, engine, { extra: {
        'local-llm/tools/vllm_mps_calibration.mjs': `import { marker } from 'pworker/local-llm';
export const CALIBRATION_SCHEMA = 'fixture.calibration/v1';
export const TUPLE_FIELDS = Object.freeze(['a']);
export const evidenceDigest = () => 'digest-1';
export const PWORKER_MARKER = marker;
`,
        'local-llm/src/controller/vllmMpsQualification.mjs': `import { createHash } from 'node:crypto';
export const resolveVllmMpsQualification = (tuple) => ({ qualified: tuple.a === 1, evidenceDigest: createHash('sha256').update('x').digest('hex') && 'digest-1' });
`,
    } });
    const root = path.join(scratchDirectory(t, 'hwl-cand-'), 'candidate');
    createBaselineStage(source, git(source, 'rev-parse', 'HEAD'), `${root}.tmp`);
    fs.mkdirSync(path.join(root, LLM_SOURCE_DIRECTORY), { recursive: true });
    copyFrozenTree(path.join(`${root}.tmp`, 'local-llm'), path.join(root, LLM_SOURCE_DIRECTORY, 'local-llm'));
    fs.rmSync(`${root}.tmp`, { recursive: true });
    return { root, digest: liveSourceDigest(root) };
}

test('SCR.the-calibration-tool-is-imported-from-a-scratch-copy-of-the-frozen-tree-and-the-frozen-stage-never-gets-a-node-modules', async (t) => {
    const engine = pworkerFixture(t);
    const candidate = frozenCandidate(t, engine);
    const frozenTree = path.join(candidate.root, LLM_SOURCE_DIRECTORY, 'local-llm');
    // The premise: the frozen tool cannot import the engine, so it cannot be loaded from the frozen tree.
    await assert.rejects(import(pathToFileURL(path.join(frozenTree, 'tools', 'vllm_mps_calibration.mjs')).href), { code: 'ERR_MODULE_NOT_FOUND' });
    const evidence = scratchDirectory(t, 'hwl-ev-');
    const document = path.join(evidence, 'calibration.json');
    fs.writeFileSync(document, JSON.stringify({ evidence: { schema: 'fixture.calibration/v1', verdict: { qualifiable: true }, tuple: { a: 1 }, evidenceDigest: 'digest-1' } }));
    const runId = randomRunId();
    const outcome = await vllmStage({ stage: 'qualified', 'calibration-evidence': document }, candidate, { scratchParent: evidence, runId });
    assert.deepEqual(outcome, { stage: 'qualified', calibration: { evidenceDigest: 'digest-1', tuple: { a: 1 }, expectQualified: true } });
    assert.equal(fs.existsSync(path.join(frozenTree, 'node_modules')), false);
    assert.equal(liveSourceDigest(candidate.root), candidate.digest, 'the frozen stage digest never sees the scratch');
    assert.deepEqual(fs.readdirSync(evidence).sort(), ['calibration.json', `vllm-tool-install-${runId}.json`], 'the scratch is removed; the install record stays');
    const record = JSON.parse(fs.readFileSync(path.join(evidence, `vllm-tool-install-${runId}.json`), 'utf8'));
    assert.equal(record.install.pworkerCommit, engine.sha);
    assert.match(record.install.pworkerTreeDigest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(record.frozenTreeDigest, treeDigest(frozenTree));
    // Stage 1 installs nothing and needs no scratch.
    assert.deepEqual(await vllmStage({ stage: 'calibration' }, candidate, { scratchParent: evidence, runId: randomRunId() }), { stage: 'calibration' });
    assert.deepEqual(fs.readdirSync(evidence).sort(), ['calibration.json', `vllm-tool-install-${runId}.json`]);
});

test('SCR.the-calibration-stage-refuses-a-frozen-tree-with-a-node-modules-and-a-failed-install-and-removes-its-scratch', async (t) => {
    const engine = pworkerFixture(t);
    const candidate = frozenCandidate(t, engine);
    const frozenTree = path.join(candidate.root, LLM_SOURCE_DIRECTORY, 'local-llm');
    const evidence = scratchDirectory(t, 'hwl-ev-');
    const document = path.join(evidence, 'calibration.json');
    fs.writeFileSync(document, JSON.stringify({ schema: 'fixture.calibration/v1', verdict: { qualifiable: true }, tuple: { a: 1 }, evidenceDigest: 'digest-1' }));
    const options = { stage: 'qualified', 'calibration-evidence': document };
    // Evidence that does not match its own digest is a usage error, and the scratch is gone afterwards.
    fs.writeFileSync(document, JSON.stringify({ schema: 'fixture.calibration/v1', verdict: { qualifiable: true }, tuple: { a: 1 }, evidenceDigest: 'other' }));
    await assert.rejects(vllmStage(options, candidate, { scratchParent: evidence, runId: randomRunId() }), /does not match|not a qualifiable/);
    assert.deepEqual(fs.readdirSync(evidence).filter(name => name.startsWith('llm-tool-')), []);
    await assert.rejects(vllmStage(options, candidate, { scratchParent: evidence, runId: randomRunId(), install: () => { throw new Error('install refused'); } }), /install refused/);
    assert.deepEqual(fs.readdirSync(evidence).filter(name => name.startsWith('llm-tool-')), []);
    fs.mkdirSync(path.join(frozenTree, 'node_modules'));
    await assert.rejects(vllmStage(options, candidate, { scratchParent: evidence, runId: randomRunId() }), /frozen local-llm tree has a node_modules/);
    assert.deepEqual(fs.readdirSync(evidence).filter(name => name.startsWith('llm-tool-')), []);
    assert.throws(() => prepareVllmToolTree({ frozenTree, stageParent: evidence, runId: randomRunId() }), /frozen local-llm tree has a node_modules/);
});
