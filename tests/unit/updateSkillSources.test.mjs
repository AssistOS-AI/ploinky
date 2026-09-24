import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Declared skills sources join the single update operation set: every
// physical checkout is fetched at most once, the skills phases consume the
// operation records instead of pulling again, a refused source is neither
// retried nor pruned, and `update repo X` refreshes X's manifest consumers.

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const moduleUrl = rel => pathToFileURL(path.join(projectRoot, rel)).href;

const PRELUDE = String.raw`
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const scratch = process.env.PLOINKY_TEST_SCRATCH;
const workspaceRoot = process.env.PLOINKY_WORKSPACE_ROOT;
const git = (cwd, ...args) => String(execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim();
function writeFile(file, content) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
}
function makeRemote(name, files) {
    const remote = path.join(scratch, 'remotes', name + '.git');
    const seed = path.join(scratch, 'remotes', name + '-seed');
    fs.mkdirSync(path.dirname(remote), { recursive: true });
    execFileSync('git', ['init', '-q', '--bare', remote]);
    fs.mkdirSync(seed, { recursive: true });
    git(seed, 'init', '-q', '-b', 'main');
    for (const [rel, content] of Object.entries(files)) writeFile(path.join(seed, rel), content);
    git(seed, 'add', '.');
    git(seed, 'commit', '-q', '-m', 'initial');
    git(seed, 'remote', 'add', 'origin', remote);
    git(seed, 'push', '-q', '-u', 'origin', 'main');
    return { remote, seed };
}
function clone(remote, destination) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    execFileSync('git', ['clone', '-q', remote, destination]);
}
function advance(seed, rel, content) {
    writeFile(path.join(seed, rel), content);
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'advance ' + rel);
    git(seed, 'push', '-q');
    return git(seed, 'rev-parse', 'HEAD');
}
const { REPOS_DIR } = await import(${JSON.stringify(moduleUrl('cli/utils/config.js'))});
const commands = await import(${JSON.stringify(moduleUrl('cli/commands/repoAgentCommands.js'))});
const skills = await import(${JSON.stringify(moduleUrl('cli/commands/skills.js'))});
for (const name of ['AchillesCopilotBasicSkills', 'DocumentationSkills', 'PloinkySkills']) {
    const source = makeRemote(name, { ['skills/' + name + '-skill/SKILL.md']: '# ' + name + '\n' });
    clone(source.remote, path.join(REPOS_DIR, name));
}
function trace() {
    const file = process.env.PLOINKY_TEST_GIT_TRACE;
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
}
function resetTrace() {
    fs.rmSync(process.env.PLOINKY_TEST_GIT_TRACE, { force: true });
}
// Git commands that reach a remote or move a checkout.
function networkOrMutation(checkout) {
    const spellings = [checkout, fs.realpathSync(checkout)];
    return trace().filter(line => spellings.some(spelling => line.startsWith('-C ' + spelling + ' ') || line.includes(' ' + spelling + ' ')))
        .filter(line => / (?:fetch|pull|merge|clone|checkout|reset|ls-remote)(?: |$)/.test(line));
}
async function quiet(operation) {
    const original = { log: console.log, error: console.error, warn: console.warn };
    console.log = console.error = console.warn = () => {};
    try { return await operation(); } finally { Object.assign(console, original); }
}
const brief = result => (result?.records || []).map(record => [record.phase, record.id, record.outcome, record.code]);
function done(value) {
    process.stdout.write('RESULT:' + JSON.stringify(value) + '\n');
}
`;

function runScenario(body) {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-update-skill-sources-'));
    try {
        const workspaceRoot = path.join(scratch, 'workspace');
        const bin = path.join(scratch, 'bin');
        fs.mkdirSync(path.join(workspaceRoot, '.ploinky'), { recursive: true });
        fs.mkdirSync(path.join(scratch, 'runtime-root'), { recursive: true });
        fs.mkdirSync(bin);
        const globalConfig = path.join(scratch, 'gitconfig');
        fs.writeFileSync(globalConfig, '[user]\n\tname = Ploinky Test\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n');
        const realGit = String(execFileSync('which', ['git'], { encoding: 'utf8' })).trim();
        fs.writeFileSync(path.join(bin, 'git'), [
            '#!/bin/sh',
            'printf \'%s\\n\' "$*" >> "$PLOINKY_TEST_GIT_TRACE"',
            'for arg in "$@"; do case "$arg" in http://*|https://*|ssh://*|git@*) echo "network Git access is not allowed in this test: $arg" >&2; exit 97;; esac; done',
            `exec "${realGit}" "$@"`,
            '',
        ].join('\n'));
        fs.chmodSync(path.join(bin, 'git'), 0o755);
        const env = {
            ...process.env,
            HOME: scratch,
            GIT_CONFIG_GLOBAL: globalConfig,
            GIT_CONFIG_NOSYSTEM: '1',
            PATH: `${bin}${path.delimiter}${process.env.PATH}`,
            PLOINKY_WORKSPACE_ROOT: workspaceRoot,
            PLOINKY_ROOT: path.join(scratch, 'runtime-root'),
            PLOINKY_TEST_SCRATCH: scratch,
            PLOINKY_TEST_GIT_TRACE: path.join(scratch, 'git-trace.log'),
        };
        for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'PLOINKY_UPDATED_WORKSPACE_CHECKOUT',
            'PLOINKY_UPDATE_REPORT_NONCE', 'PLOINKY_UPDATE_REPORT_CONTEXT']) delete env[name];
        const output = execFileSync(process.execPath, ['--input-type=module', '-e', `${PRELUDE}\n${body}`], {
            cwd: workspaceRoot, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        });
        return JSON.parse(output.split('\n').find(line => line.startsWith('RESULT:')).slice('RESULT:'.length));
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
}

test('update all fetches each physical checkout once across registered, workspace and declared manifest sources', () => {
    const result = runScenario(String.raw`
        // A managed cache (registered) and a workspace checkout, both also declared by a manifest.
        const cache = makeRemote('CacheSkills', { 'skills/c1/SKILL.md': '# c1 v1\n' });
        const cachePath = path.join(REPOS_DIR, 'CacheSkills');
        clone(cache.remote, cachePath);
        const outer = makeRemote('Outer', { 'skills/o1/SKILL.md': '# o1 v1\n' });
        const outerPath = path.join(workspaceRoot, 'Outer');
        clone(outer.remote, outerPath);
        const consumer = path.join(workspaceRoot, 'consumer');
        writeFile(path.join(consumer, 'ploinky-skills-manifest.json'), JSON.stringify([
            { name: 'CacheSkills', url: cache.remote, skills: ['c1'] },
            { name: 'Outer', url: outer.remote, skills: ['o1'] },
        ]));
        // A scoped consumer outside the discovery scan of the second run.
        const scoped = path.join(workspaceRoot, 'scoped', 'consumer');
        writeFile(path.join(scoped, 'ploinky-skills-manifest.json'), JSON.stringify([{ name: 'Outer', url: outer.remote, skills: ['o1'] }]));
        advance(cache.seed, 'skills/c1/SKILL.md', '# c1 v2\n');
        advance(outer.seed, 'skills/o1/SKILL.md', '# o1 v2\n');

        resetTrace();
        const all = await quiet(() => commands.updateAllRepos(workspaceRoot, { interactiveSession: true }));
        const allFetches = { cache: networkOrMutation(cachePath), outer: networkOrMutation(outerPath) };
        const read = file => fs.readFileSync(file, 'utf8');
        // Exports are links into the checkout: read them before the next update.
        const firstC1 = read(path.join(consumer, '.agents', 'skills', 'c1', 'SKILL.md'));
        const firstO1 = read(path.join(consumer, '.agents', 'skills', 'o1', 'SKILL.md'));

        advance(outer.seed, 'skills/o1/SKILL.md', '# o1 v3\n');
        resetTrace();
        const scopedRun = await quiet(() => commands.updateAllRepos(path.join(workspaceRoot, 'scoped'), { interactiveSession: true }));
        done({
            allFetches,
            allRecords: brief(all).filter(record => ['registered-repository', 'workspace-repository', 'skills-manifest'].includes(record[0]))
                .map(record => [record[0], path.basename(record[1]), record[2]]),
            c1: firstC1,
            o1: firstO1,
            scopedFetches: networkOrMutation(outerPath),
            scopedOuter: brief(scopedRun).filter(record => record[0] === 'workspace-repository').map(record => [path.basename(record[1]), record[2]]),
            scopedO1: read(path.join(scoped, '.agents', 'skills', 'o1', 'SKILL.md')),
        });
    `);
    assert.equal(result.allFetches.cache.filter(line => / fetch /.test(line)).length, 1, result.allFetches.cache.join('\n'));
    assert.equal(result.allFetches.outer.filter(line => / fetch /.test(line)).length, 1, result.allFetches.outer.join('\n'));
    assert.equal(result.allFetches.cache.some(line => / pull /.test(line)), false, 'the skills phase never pulls');
    assert.equal(result.allFetches.outer.some(line => / pull /.test(line)), false);
    const pick = (phase, name) => result.allRecords.filter(record => record[0] === phase && record[1] === name);
    assert.deepEqual(pick('registered-repository', 'CacheSkills'), [['registered-repository', 'CacheSkills', 'changed']]);
    assert.deepEqual(pick('workspace-repository', 'Outer'), [['workspace-repository', 'Outer', 'changed']]);
    assert.equal(result.c1, '# c1 v2\n');
    assert.equal(result.o1, '# o1 v2\n');
    // The scoped run discovers nothing under `scoped/` except the consumer, yet
    // the declared workspace source joins the operation set exactly once.
    assert.equal(result.scopedFetches.filter(line => / fetch /.test(line)).length, 1, result.scopedFetches.join('\n'));
    assert.deepEqual(result.scopedOuter, [['Outer', 'changed']]);
    assert.equal(result.scopedO1, '# o1 v3\n');
});

test('a refused registered source is not retried by the skills phase and prunes nothing', () => {
    const result = runScenario(String.raw`
        const cache = makeRemote('CacheSkills', { 'skills/c1/SKILL.md': '# c1\n', 'skills/c2/SKILL.md': '# c2\n' });
        const cachePath = path.join(REPOS_DIR, 'CacheSkills');
        clone(cache.remote, cachePath);
        const consumer = path.join(workspaceRoot, 'consumer');
        const manifestPath = path.join(consumer, 'ploinky-skills-manifest.json');
        writeFile(manifestPath, JSON.stringify([{ name: 'CacheSkills', url: cache.remote, skills: ['c1', 'c2'] }], null, 2) + '\n');
        await quiet(() => skills.installSkillsFromManifest(manifestPath, { targetRoot: consumer, pruneMissing: true }));
        // c2 disappears from the cache in a committed local change, and the
        // cache's upstream no longer matches its branch: the update is refused.
        git(cachePath, 'rm', '-q', '-r', 'skills/c2');
        git(cachePath, 'commit', '-q', '-m', 'drop c2 locally');
        git(cache.seed, 'push', '-q', 'origin', 'main:other');
        git(cachePath, 'fetch', '-q', 'origin');
        git(cachePath, 'branch', '--set-upstream-to=origin/other', 'main');
        advance(cache.seed, 'skills/c1/SKILL.md', '# c1 upstream\n');
        const manifestBefore = fs.readFileSync(manifestPath, 'utf8');
        const head = git(cachePath, 'rev-parse', 'HEAD');
        resetTrace();
        const run = await quiet(() => commands.updateAllRepos(workspaceRoot, { interactiveSession: true }));
        done({
            cacheRecord: brief(run).find(record => record[0] === 'registered-repository' && record[1] === 'CacheSkills'),
            manifestRecord: brief(run).find(record => record[0] === 'skills-manifest'),
            mutations: networkOrMutation(cachePath),
            headKept: git(cachePath, 'rev-parse', 'HEAD') === head,
            manifestKept: fs.readFileSync(manifestPath, 'utf8') === manifestBefore,
            c2Link: fs.lstatSync(path.join(consumer, '.agents', 'skills', 'c2'), { throwIfNoEntry: false }) !== undefined,
        });
    `);
    assert.deepEqual(result.cacheRecord.slice(2), ['skipped', 'upstream-mismatch']);
    assert.deepEqual(result.mutations, [], 'no fetch, pull or merge reached the refused source');
    assert.ok(result.headKept);
    assert.ok(result.manifestKept, 'the manifest entry for the missing skill was not pruned');
    assert.ok(result.c2Link, 'the existing c2 output is retained');
    assert.notEqual(result.manifestRecord[2], 'failed', 'the consumer uses the untouched checkout');
});

test('update repo X refreshes every manifest consumer of X with its full owner set and pulls nothing else', () => {
    const result = runScenario(String.raw`
        const x = makeRemote('XSkills', { 'skills/x1/SKILL.md': '# x1 v1\n' });
        const y = makeRemote('YSkills', { 'skills/y1/SKILL.md': '# y1\n' });
        const xPath = path.join(REPOS_DIR, 'XSkills');
        const yPath = path.join(REPOS_DIR, 'YSkills');
        clone(x.remote, xPath);
        clone(y.remote, yPath);
        const consumers = {
            both: [{ name: 'XSkills', url: x.remote, skills: ['x1'] }, { name: 'YSkills', url: y.remote, skills: ['y1'] }],
            xOnly: [{ name: 'XSkills', url: x.remote, skills: ['x1'] }],
            yOnly: [{ name: 'YSkills', url: y.remote, skills: ['y1'] }],
        };
        for (const [folder, manifest] of Object.entries(consumers)) {
            const target = path.join(workspaceRoot, folder);
            writeFile(path.join(target, 'ploinky-skills-manifest.json'), JSON.stringify(manifest));
            await quiet(() => skills.installSkillsFromManifest(path.join(target, 'ploinky-skills-manifest.json'), { targetRoot: target, pruneMissing: true }));
        }
        advance(x.seed, 'skills/x2/SKILL.md', '# x2\n');
        advance(y.seed, 'skills/y1/SKILL.md', '# y1 upstream\n');
        resetTrace();
        const run = await quiet(() => commands.updateRepoResult('XSkills'));
        const exists = rel => fs.existsSync(path.join(workspaceRoot, rel));
        done({
            records: brief(run).filter(record => record[0] === 'skills-manifest').map(record => path.basename(record[1])).sort(),
            yMutations: networkOrMutation(yPath),
            xFetches: networkOrMutation(xPath).filter(line => / fetch /.test(line)).length,
            bothY: exists('both/.agents/skills/y1/SKILL.md'),
            bothX: exists('both/.agents/skills/x1/SKILL.md'),
            yContent: fs.readFileSync(path.join(workspaceRoot, 'both', '.agents', 'skills', 'y1', 'SKILL.md'), 'utf8'),
            consumers: run.skillConsumers.refreshed.map(entry => path.basename(entry.destRoot)).sort(),
        });
    `);
    assert.deepEqual(result.records, ['both', 'xOnly'], 'only consumers declaring X get a refresh record');
    assert.deepEqual(result.consumers, ['both', 'xOnly']);
    assert.equal(result.xFetches, 1);
    assert.deepEqual(result.yMutations, [], 'the other source is used as it is, never pulled');
    assert.ok(result.bothX);
    assert.ok(result.bothY, 'the full owner set keeps the other source\'s skill');
    assert.equal(result.yContent, '# y1\n');
});
