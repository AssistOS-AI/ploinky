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

// Operations the printed update summary does not count as updated.
const summaryShortfall = out => {
    const match = /^Update summary: (\d+)\/(\d+) update operations succeeded/.exec(out.find(line => line.startsWith('Update summary:')) || '');
    return match ? Number(match[2]) - Number(match[1]) : null;
};

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
// Same as quiet(), but keeps every printed line so a summary can be asserted.
async function captured(operation) {
    const original = { log: console.log, error: console.error, warn: console.warn };
    const out = [];
    console.log = console.error = console.warn = (...values) => out.push(values.map(String).join(' '));
    try { return { value: await operation(), out }; } finally { Object.assign(console, original); }
}
const brief = result => (result?.records || []).map(record => [record.phase, record.id, record.outcome, record.code]);
const manifestRecords = result => (result?.records || []).filter(record => record.phase === 'skills-manifest');
const decision = result => ({
    status: result.status, exitCode: result.exitCode, activationAllowed: result.activationAllowed,
    blockedBy: result.blockedBy, errors: result.errors,
});
const cloneAttempts = () => trace().filter(line => /(?:^| )clone /.test(line));
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
            'PLOINKY_UPDATE_REPORT_NONCE', 'PLOINKY_UPDATE_REPORT_CONTEXT', 'PLOINKY_SKILL_EXCLUDES_COMPOSE']) delete env[name];
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

// ---------------------------------------------------------------------------
// Truthful skill-source outcomes: a source that could not be acquired or
// verified is a failed (or uncertain) manifest record, never a success.

test('a fresh required manifest whose source clone fails is a failed record: nonzero, no activation, no success line', () => {
    const result = runScenario(String.raw`
        const missing = path.join(scratch, 'missing.git');
        const manifestPath = path.join(workspaceRoot, 'ploinky-skills-manifest.json');
        writeFile(manifestPath, JSON.stringify([{ name: 'MissingSource', url: missing, skills: ['mandatory'] }]) + '\n');
        resetTrace();
        const run = await captured(() => commands.updateAllRepos(workspaceRoot, { interactiveSession: true }));
        done({
            records: manifestRecords(run.value),
            decision: decision(run.value),
            out: run.out,
            clones: cloneAttempts().filter(line => line.includes('MissingSource')).length,
            exported: fs.existsSync(path.join(workspaceRoot, '.agents', 'skills', 'mandatory')),
            cache: fs.existsSync(path.join(REPOS_DIR, 'MissingSource')),
            manifest: fs.readFileSync(manifestPath, 'utf8'),
            missing,
        });
    `);
    assert.equal(result.records.length, 1);
    const [record] = result.records;
    assert.equal(record.outcome, 'failed', JSON.stringify(record));
    assert.equal(record.code, 'skill-source-unavailable');
    assert.equal(record.required, true);
    assert.equal(record.details.failedSources.length, 1);
    const [failed] = record.details.failedSources;
    assert.equal(failed.name, 'MissingSource');
    assert.equal(failed.url, result.missing, 'the source identity is recorded');
    assert.equal(failed.code, 'source-unavailable');
    assert.equal(failed.sourceOutcome, 'failed');
    assert.match(failed.reason, /does not exist/, 'the sanitized Git reason is kept');
    assert.match(record.reason, /MissingSource/);
    assert.ok(record.details.sources.includes('MissingSource'), 'required membership still resolves from details.sources');
    assert.deepEqual(record.details.sourceStates.map(state => [state.name, state.state]), [['MissingSource', 'retained']]);
    assert.equal(result.decision.exitCode, 1);
    assert.equal(result.decision.activationAllowed, false);
    assert.equal(result.decision.status, 'failed');
    assert.deepEqual(result.decision.blockedBy.map(entry => [entry.phase, entry.outcome, entry.code]), [['skills-manifest', 'failed', 'skill-source-unavailable']]);
    assert.deepEqual(result.decision.errors.map(entry => [entry.phase, entry.outcome]), [['skills-manifest', 'failed']]);
    assert.equal(result.out.some(line => /✓ .*skill\(s\)/.test(line)), false, result.out.join('\n'));
    assert.ok(result.out.some(line => /✗ workspace skills: .*MissingSource/.test(line)), result.out.join('\n'));
    assert.equal(summaryShortfall(result.out), 1, result.out.join('\n'));
    assert.ok(result.out.some(line => /Update completed with 1 error\(s\)/.test(line)));
    assert.equal(result.clones, 1, 'one clone attempt, no duplicate');
    assert.equal(result.exported, false);
    assert.equal(result.cache, false, 'a failed clone leaves no cache behind');
});

test('an independent manifest after a failed one is still attempted and both outcomes survive aggregation', () => {
    const result = runScenario(String.raw`
        const cache = makeRemote('CacheSkills', { 'skills/c1/SKILL.md': '# c1\n' });
        clone(cache.remote, path.join(REPOS_DIR, 'CacheSkills'));
        writeFile(path.join(workspaceRoot, 'ploinky-skills-manifest.json'),
            JSON.stringify([{ name: 'MissingSource', url: path.join(scratch, 'missing.git'), skills: ['mandatory'] }]));
        writeFile(path.join(workspaceRoot, 'healthy', 'ploinky-skills-manifest.json'),
            JSON.stringify([{ name: 'CacheSkills', url: cache.remote, skills: ['c1'] }]));
        const run = await captured(() => commands.updateAllRepos(workspaceRoot, { interactiveSession: true }));
        done({
            records: manifestRecords(run.value).map(record => [path.basename(record.id), record.outcome, record.code, record.required]),
            decision: decision(run.value),
            totals: run.value.totals,
            healthy: fs.readFileSync(path.join(workspaceRoot, 'healthy', '.agents', 'skills', 'c1', 'SKILL.md'), 'utf8'),
            out: run.out,
        });
    `);
    assert.deepEqual(result.records, [
        ['workspace', 'failed', 'skill-source-unavailable', true],
        ['healthy', 'changed', 'exported', false],
    ]);
    assert.equal(result.healthy, '# c1\n', 'the later manifest was exported');
    assert.equal(result.decision.exitCode, 1);
    assert.equal(result.decision.activationAllowed, false);
    assert.deepEqual(result.decision.errors.map(entry => entry.outcome), ['failed']);
    assert.ok(result.out.some(line => /✗ workspace skills: /.test(line)));
    assert.ok(result.out.some(line => /✓ healthy: 1 skill\(s\)/.test(line)), 'only the healthy manifest prints a success line');
    assert.equal(summaryShortfall(result.out), 1, 'exactly the failed manifest is not counted as updated');
});

test('an optional manifest outside the required graph fails nonzero but leaves activation allowed', () => {
    const result = runScenario(String.raw`
        const cache = makeRemote('CacheSkills', { 'skills/c1/SKILL.md': '# c1\n' });
        clone(cache.remote, path.join(REPOS_DIR, 'CacheSkills'));
        writeFile(path.join(workspaceRoot, 'ploinky-skills-manifest.json'),
            JSON.stringify([{ name: 'CacheSkills', url: cache.remote, skills: ['c1'] }]));
        writeFile(path.join(workspaceRoot, 'a-optional', 'ploinky-skills-manifest.json'),
            JSON.stringify([{ name: 'MissingSource', url: path.join(scratch, 'missing.git'), skills: ['mandatory'] }]));
        const run = await captured(() => commands.updateAllRepos(workspaceRoot, { interactiveSession: true }));
        done({
            records: manifestRecords(run.value).map(record => [path.basename(record.id), record.outcome, record.code, record.required]),
            decision: decision(run.value),
        });
    `);
    assert.deepEqual(result.records, [
        ['workspace', 'changed', 'exported', true],
        ['a-optional', 'failed', 'skill-source-unavailable', false],
    ]);
    assert.equal(result.decision.exitCode, 1, 'any failure still exits nonzero');
    assert.equal(result.decision.activationAllowed, true, 'activation follows graph membership');
    assert.equal(result.decision.status, 'partial');
    assert.deepEqual(result.decision.blockedBy, []);
});

for (const [cause, expectedCode] of [['origin', 'origin-mismatch'], ['branch', 'branch-mismatch'], ['not-git', 'not-a-git-checkout']]) {
    test(`a retained ${cause} failure fails the required manifest, preserves prior output and adds no Git work`, () => {
        const result = runScenario(String.raw`
            const cause = ${JSON.stringify(cause)};
            const cache = makeRemote('CacheSkills', { 'skills/c1/SKILL.md': '# c1\n', 'skills/c2/SKILL.md': '# c2\n' });
            const cachePath = path.join(REPOS_DIR, 'CacheSkills');
            clone(cache.remote, cachePath);
            const manifestPath = path.join(workspaceRoot, 'ploinky-skills-manifest.json');
            const entry = { name: 'CacheSkills', url: cache.remote, skills: ['c1', 'c2'] };
            writeFile(manifestPath, JSON.stringify([entry], null, 2) + '\n');
            await quiet(() => skills.installSkillsFromManifest(manifestPath, { targetRoot: workspaceRoot, pruneMissing: true }));
            const read = rel => fs.readFileSync(path.join(workspaceRoot, '.agents', 'skills', rel, 'SKILL.md'), 'utf8');
            const priorOutput = [read('c1'), read('c2')];
            if (cause === 'origin') {
                // A mirror with the same history: the Git refresh itself succeeds.
                const other = path.join(scratch, 'remotes', 'Other.git');
                execFileSync('git', ['clone', '-q', '--bare', cache.remote, other]);
                git(cachePath, 'remote', 'set-url', 'origin', other);
            } else if (cause === 'branch') {
                writeFile(manifestPath, JSON.stringify([{ ...entry, branch: 'release' }], null, 2) + '\n');
            } else {
                fs.renameSync(path.join(cachePath, '.git'), path.join(cachePath, '.git-away'));
            }
            const manifestBefore = fs.readFileSync(manifestPath, 'utf8');
            resetTrace();
            const run = await captured(() => commands.updateAllRepos(workspaceRoot, { interactiveSession: true }));
            const [record] = manifestRecords(run.value);
            done({
                record,
                decision: decision(run.value),
                out: run.out,
                priorKept: [read('c1'), read('c2')],
                priorOutput,
                manifestKept: fs.readFileSync(manifestPath, 'utf8') === manifestBefore,
                clones: cloneAttempts().length,
                fetches: networkOrMutation(cachePath).filter(line => / fetch /.test(line)).length,
                pulls: networkOrMutation(cachePath).filter(line => / pull /.test(line)).length,
            });
        `);
        const record = result.record;
        assert.equal(record.outcome, 'failed', JSON.stringify(record));
        assert.equal(record.code, 'skill-source-unavailable');
        assert.equal(record.details.failedSources[0].name, 'CacheSkills');
        assert.equal(record.details.failedSources[0].code, expectedCode);
        assert.equal(record.details.sourceStates[0].state, 'retained');
        assert.equal(record.required, true);
        assert.equal(result.decision.exitCode, 1);
        assert.equal(result.decision.activationAllowed, false);
        assert.ok(result.out.some(line => /✗ workspace skills: .*CacheSkills/.test(line)), result.out.join('\n'));
        assert.equal(result.out.some(line => /✓ .*skill\(s\)/.test(line)), false);
        assert.deepEqual(result.priorKept, result.priorOutput, 'prior output stays intact');
        assert.ok(result.manifestKept, 'the manifest is not pruned for a failed source');
        assert.equal(result.clones, 0, 'no clone attempt for an existing checkout');
        assert.equal(result.fetches, { origin: 1, branch: 1, 'not-git': 0 }[cause],
            'exactly the one operation-set refresh reached a Git checkout, none for a directory that is not one');
        assert.equal(result.pulls, 0, 'the skills phase never pulls');
    });
}

test('a user-edited export preserved with a healthy source stays a successful preservation', () => {
    const result = runScenario(String.raw`
        const cache = makeRemote('CacheSkills', { 'skills/c1/SKILL.md': '# c1\n', 'skills/c2/SKILL.md': '# c2\n' });
        clone(cache.remote, path.join(REPOS_DIR, 'CacheSkills'));
        writeFile(path.join(workspaceRoot, 'ploinky-skills-manifest.json'),
            JSON.stringify([{ name: 'CacheSkills', url: cache.remote, skills: ['c1', 'c2'] }]));
        // The user owns c1 already; Ploinky must keep it and still export c2.
        writeFile(path.join(workspaceRoot, '.agents', 'skills', 'c1', 'SKILL.md'), '# my own c1\n');
        const run = await captured(() => commands.updateAllRepos(workspaceRoot, { interactiveSession: true }));
        const [record] = manifestRecords(run.value);
        done({
            record, decision: decision(run.value), out: run.out,
            c1: fs.readFileSync(path.join(workspaceRoot, '.agents', 'skills', 'c1', 'SKILL.md'), 'utf8'),
            c2: fs.readFileSync(path.join(workspaceRoot, '.agents', 'skills', 'c2', 'SKILL.md'), 'utf8'),
        });
    `);
    assert.equal(result.record.outcome, 'changed');
    assert.equal(result.record.code, 'exported');
    assert.equal(result.record.details.preserved.length, 1);
    assert.equal(result.record.details.preserved[0].name, 'c1');
    assert.equal(result.record.details.failedSources, undefined);
    assert.equal(result.decision.exitCode, 0);
    assert.equal(result.decision.activationAllowed, true);
    assert.equal(result.c1, '# my own c1\n');
    assert.equal(result.c2, '# c2\n');
    assert.ok(result.out.some(line => /✓ workspace: 2 skill\(s\)/.test(line)));
});

test('a retained stale source is not a failed source and an uncertain source record makes the manifest uncertain', () => {
    const result = runScenario(String.raw`
        const { createOperationRecord } = await import(${JSON.stringify(moduleUrl('cli/commands/updateOutcome.js'))});
        const { skillsManifestRecord } = await import(${JSON.stringify(moduleUrl('cli/commands/updateRecords.js'))});
        const cache = makeRemote('CacheSkills', { 'skills/c1/SKILL.md': '# c1\n' });
        const cachePath = path.join(REPOS_DIR, 'CacheSkills');
        clone(cache.remote, cachePath);
        const manifestPath = path.join(workspaceRoot, 'ploinky-skills-manifest.json');
        writeFile(manifestPath, JSON.stringify([{ name: 'CacheSkills', url: cache.remote, skills: ['c1'] }]));
        await quiet(() => skills.installSkillsFromManifest(manifestPath, { targetRoot: workspaceRoot, pruneMissing: true }));
        const sourceRecord = outcome => createOperationRecord({
            phase: 'registered-repository', id: 'CacheSkills', outcome, code: 'fixture-' + outcome, reason: 'fixture',
            details: { checkout: { path: fs.realpathSync(cachePath) } },
        });
        const consume = async outcome => {
            const run = await quiet(() => skills.installSkillsFromManifest(manifestPath, {
                targetRoot: workspaceRoot, pruneMissing: true, sourceOutcomes: [sourceRecord(outcome)],
            }));
            const record = skillsManifestRecord({ folder: workspaceRoot, manifestPath, label: 'workspace', result: run });
            return { states: run.sources.map(source => [source.state, source.sourceOutcome || null, source.code || null]), outcome: record.outcome, code: record.code,
                uncertainSources: record.details.uncertainSources || null, failedSources: record.details.failedSources || null };
        };
        done({
            skipped: await consume('skipped'),
            failed: await consume('failed'),
            uncertain: await consume('uncertain'),
            c1: fs.readFileSync(path.join(workspaceRoot, '.agents', 'skills', 'c1', 'SKILL.md'), 'utf8'),
        });
    `);
    for (const name of ['skipped', 'failed']) {
        assert.equal(result[name].states[0][0], 'stale', `${name} source record: the checkout is used as it is`);
        assert.equal(result[name].states[0][1], null);
        assert.ok(['changed', 'unchanged'].includes(result[name].outcome), `${name}: ${JSON.stringify(result[name])}`);
        assert.equal(result[name].failedSources, null);
    }
    assert.deepEqual(result.uncertain.states[0].slice(0, 2), ['retained', 'uncertain']);
    assert.equal(result.uncertain.states[0][2], 'fixture-uncertain', 'the source record code is kept');
    assert.equal(result.uncertain.outcome, 'uncertain');
    assert.equal(result.uncertain.code, 'skill-source-uncertain');
    assert.equal(result.uncertain.uncertainSources[0].name, 'CacheSkills');
    assert.equal(result.c1, '# c1\n', 'nothing was pruned');
});

test('update repo X: a consumer that also uses a healthy unrefreshed Y succeeds without an extra pull', () => {
    const result = runScenario(String.raw`
        const x = makeRemote('XSkills', { 'skills/x1/SKILL.md': '# x1\n' });
        const y = makeRemote('YSkills', { 'skills/y1/SKILL.md': '# y1\n' });
        const xPath = path.join(REPOS_DIR, 'XSkills');
        const yPath = path.join(REPOS_DIR, 'YSkills');
        clone(x.remote, xPath);
        clone(y.remote, yPath);
        writeFile(path.join(workspaceRoot, 'ploinky-skills-manifest.json'), JSON.stringify([
            { name: 'XSkills', url: x.remote, skills: ['x1'] }, { name: 'YSkills', url: y.remote, skills: ['y1'] }]));
        advance(x.seed, 'skills/x1/SKILL.md', '# x1 v2\n');
        advance(y.seed, 'skills/y1/SKILL.md', '# y1 upstream\n');
        resetTrace();
        const run = await captured(() => commands.updateRepoResult('XSkills'));
        done({
            records: manifestRecords(run.value).map(record => [path.basename(record.id), record.outcome, record.code]),
            sourceStates: manifestRecords(run.value)[0].details.sourceStates.map(state => [state.name, state.state]),
            decision: decision(run.value), out: run.out,
            yMutations: networkOrMutation(yPath), clones: cloneAttempts().length,
            y1: fs.readFileSync(path.join(workspaceRoot, '.agents', 'skills', 'y1', 'SKILL.md'), 'utf8'),
            x1: fs.readFileSync(path.join(workspaceRoot, '.agents', 'skills', 'x1', 'SKILL.md'), 'utf8'),
        });
    `);
    assert.deepEqual(result.records, [['workspace', 'changed', 'exported']]);
    assert.deepEqual(result.sourceStates, [['XSkills', 'updated'], ['YSkills', 'not-updated']]);
    assert.equal(result.decision.exitCode, 0);
    assert.equal(result.decision.activationAllowed, true);
    assert.deepEqual(result.yMutations, [], 'Y is verified locally and never pulled');
    assert.equal(result.clones, 0);
    assert.equal(result.y1, '# y1\n');
    assert.equal(result.x1, '# x1 v2\n');
    assert.ok(result.out.some(line => /✓ skills consumer .*: 2 skill\(s\)/.test(line)), result.out.join('\n'));
});

test('update repo X: a consumer whose other source is missing fails truthfully and an independent consumer still succeeds', () => {
    const result = runScenario(String.raw`
        const x = makeRemote('XSkills', { 'skills/x1/SKILL.md': '# x1\n' });
        clone(x.remote, path.join(REPOS_DIR, 'XSkills'));
        writeFile(path.join(workspaceRoot, 'ploinky-skills-manifest.json'), JSON.stringify([
            { name: 'XSkills', url: x.remote, skills: ['x1'] },
            { name: 'ZMissing', url: path.join(scratch, 'z-missing.git'), skills: ['z1'] }]));
        writeFile(path.join(workspaceRoot, 'side', 'ploinky-skills-manifest.json'),
            JSON.stringify([{ name: 'XSkills', url: x.remote, skills: ['x1'] }]));
        resetTrace();
        const run = await captured(() => commands.updateRepoResult('XSkills'));
        done({
            records: manifestRecords(run.value).map(record => [path.basename(record.id), record.outcome, record.code, record.required]),
            failedSources: manifestRecords(run.value)[0].details.failedSources.map(source => [source.name, source.code]),
            decision: decision(run.value), out: run.out,
            sideExported: fs.existsSync(path.join(workspaceRoot, 'side', '.agents', 'skills', 'x1', 'SKILL.md')),
            clones: cloneAttempts().filter(line => line.includes('ZMissing')).length,
        });
    `);
    assert.deepEqual(result.records, [
        ['workspace', 'failed', 'skill-source-unavailable', true],
        ['side', 'changed', 'exported', false],
    ]);
    assert.deepEqual(result.failedSources, [['ZMissing', 'source-unavailable']]);
    assert.equal(result.decision.exitCode, 1);
    assert.equal(result.decision.activationAllowed, false);
    assert.ok(result.sideExported);
    assert.equal(result.out.filter(line => /✓ skills consumer/.test(line)).length, 1, 'only the healthy consumer prints a success line');
    assert.ok(result.out.some(line => /✗ skills consumer .*ZMissing/.test(line)), result.out.join('\n'));
    assert.ok(result.out.some(line => /✓ skills consumer .*side: 1 skill\(s\)/.test(line)));
    assert.equal(result.clones, 1);
});

test('a retry after the missing source becomes available exports without a stale failure or duplicate work', () => {
    const result = runScenario(String.raw`
        const url = path.join(scratch, 'remotes', 'Late.git');
        const manifestPath = path.join(workspaceRoot, 'ploinky-skills-manifest.json');
        writeFile(manifestPath, JSON.stringify([{ name: 'Late', url, skills: ['late1'] }]) + '\n');
        resetTrace();
        const first = await captured(() => commands.updateAllRepos(workspaceRoot, { interactiveSession: true }));
        const firstClones = cloneAttempts().filter(line => line.includes('Late')).length;
        makeRemote('Late', { 'skills/late1/SKILL.md': '# late1\n' });
        resetTrace();
        const second = await captured(() => commands.updateAllRepos(workspaceRoot, { interactiveSession: true }));
        const secondClones = cloneAttempts().filter(line => line.includes('Late')).length;
        const third = await captured(() => commands.updateAllRepos(workspaceRoot, { interactiveSession: true }));
        done({
            first: { record: manifestRecords(first.value)[0].outcome, decision: decision(first.value) },
            second: { records: manifestRecords(second.value).map(record => [record.outcome, record.code]), decision: decision(second.value), out: second.out },
            third: { records: manifestRecords(third.value).map(record => [record.outcome, record.code]), decision: decision(third.value) },
            firstClones, secondClones,
            late1: fs.readFileSync(path.join(workspaceRoot, '.agents', 'skills', 'late1', 'SKILL.md'), 'utf8'),
        });
    `);
    assert.equal(result.first.record, 'failed');
    assert.equal(result.first.decision.activationAllowed, false);
    assert.equal(result.firstClones, 1);
    assert.deepEqual(result.second.records, [['changed', 'exported']]);
    assert.equal(result.second.decision.exitCode, 0);
    assert.equal(result.second.decision.activationAllowed, true);
    assert.deepEqual(result.second.decision.errors, [], 'no stale failure record');
    assert.equal(result.secondClones, 1, 'exactly one clone once the source exists');
    assert.ok(result.second.out.some(line => /✓ workspace: 1 skill\(s\)/.test(line)));
    assert.deepEqual(result.third.records, [['unchanged', 'current']]);
    assert.equal(result.third.decision.exitCode, 0);
    assert.equal(result.late1, '# late1\n');
});

// ---------------------------------------------------------------------------
// Review fixes: summaries derive from the record even for a committed prune,
// and an unrefreshed source proves nothing about removals.

test('a committed prune is reported from the record even when another source is uncertain', () => {
    const result = runScenario(String.raw`
        const a = makeRemote('ASkills', { 'skills/a1/SKILL.md': '# a1\n' });
        const b = makeRemote('BSkills', { 'skills/b1/SKILL.md': '# b1\n', 'skills/b2/SKILL.md': '# b2\n' });
        const aPath = path.join(REPOS_DIR, 'ASkills');
        clone(a.remote, aPath);
        clone(b.remote, path.join(REPOS_DIR, 'BSkills'));
        const manifestPath = path.join(workspaceRoot, 'ploinky-skills-manifest.json');
        writeFile(manifestPath, JSON.stringify([
            { name: 'ASkills', url: a.remote, skills: ['a1'] },
            { name: 'BSkills', url: b.remote, skills: ['b1', 'b2'] },
        ], null, 2) + '\n');
        await quiet(() => skills.installSkillsFromManifest(manifestPath, { targetRoot: workspaceRoot, pruneMissing: true }));
        // B stops offering b2; A's checkout carries a foreign index.lock, so its update is uncertain.
        git(b.seed, 'rm', '-q', '-r', 'skills/b2');
        git(b.seed, 'commit', '-q', '-m', 'drop b2');
        git(b.seed, 'push', '-q');
        fs.writeFileSync(path.join(git(aPath, 'rev-parse', '--absolute-git-dir'), 'index.lock'), 'foreign');
        const run = await captured(() => commands.updateAllRepos(workspaceRoot, { interactiveSession: true }));
        const [record] = manifestRecords(run.value);
        done({
            record, out: run.out, decision: decision(run.value),
            manifest: JSON.parse(fs.readFileSync(manifestPath, 'utf8')).map(entry => [entry.name, entry.skills]),
            b2Link: fs.lstatSync(path.join(workspaceRoot, '.agents', 'skills', 'b2'), { throwIfNoEntry: false }) !== undefined,
        });
    `);
    assert.equal(result.record.outcome, 'uncertain');
    assert.equal(result.record.code, 'skill-source-uncertain');
    assert.deepEqual(result.record.details.uncertainSources.map(source => [source.name, source.code]), [['ASkills', 'git-lock-present']]);
    assert.deepEqual(result.manifest, [['ASkills', ['a1']], ['BSkills', ['b1']]], 'the manifest entry for the dropped skill was pruned');
    assert.equal(result.b2Link, false, 'the export transaction committed the removal');
    assert.ok(result.out.some(line => /Removed missing skill 'b2' from 'BSkills' in the manifest/.test(line)), result.out.join('\n'));
    assert.deepEqual(result.record.details.prunedSkills, [{ repository: 'BSkills', skill: 'b2' }]);
    assert.ok(result.out.some(line => /✗ workspace skills: .*ASkills/.test(line)));
});

test('update repo X never prunes a manifest entry of an unrefreshed source Y that lacks the skill locally', () => {
    const result = runScenario(String.raw`
        const x = makeRemote('XSkills', { 'skills/x1/SKILL.md': '# x1\n' });
        const y = makeRemote('YSkills', { 'skills/y1/SKILL.md': '# y1\n' });
        clone(x.remote, path.join(REPOS_DIR, 'XSkills'));
        const yPath = path.join(REPOS_DIR, 'YSkills');
        clone(y.remote, yPath);
        // Y's remote gains y2 after the local checkout was made: the checkout is behind.
        advance(y.seed, 'skills/y2/SKILL.md', '# y2\n');
        const manifestPath = path.join(workspaceRoot, 'ploinky-skills-manifest.json');
        writeFile(manifestPath, JSON.stringify([
            { name: 'XSkills', url: x.remote, skills: ['x1'] },
            { name: 'YSkills', url: y.remote, skills: ['y1', 'y2'] },
        ], null, 2) + '\n');
        const manifestBefore = fs.readFileSync(manifestPath, 'utf8');
        resetTrace();
        const run = await captured(() => commands.updateRepoResult('XSkills'));
        const [record] = manifestRecords(run.value);
        done({
            record, out: run.out, decision: decision(run.value),
            manifestKept: fs.readFileSync(manifestPath, 'utf8') === manifestBefore,
            yMutations: networkOrMutation(yPath),
            sourceStates: record.details.sourceStates.map(state => [state.name, state.state, state.missingRetained || null]),
            y1: fs.existsSync(path.join(workspaceRoot, '.agents', 'skills', 'y1', 'SKILL.md')),
        });
    `);
    assert.ok(result.manifestKept, 'the manifest still lists y2: an unrefreshed source proves nothing about removals');
    assert.deepEqual(result.sourceStates, [['XSkills', 'current', null], ['YSkills', 'not-updated', ['y2']]]);
    assert.ok(['changed', 'unchanged'].includes(result.record.outcome), 'the stale policy: retained, not failed');
    assert.deepEqual(result.record.details.prunedSkills, undefined);
    assert.deepEqual(result.yMutations, [], 'Y is still never pulled');
    assert.ok(result.y1, 'what Y does offer is exported');
    assert.equal(result.decision.exitCode, 0);
});

test('update repo X never prunes default-skill output that an unrefreshed default source no longer offers', () => {
    const result = runScenario(String.raw`
        const target = makeRemote('UnitTarget', { 'a.txt': 'a\n' });
        const targetPath = path.join(REPOS_DIR, 'UnitTarget');
        clone(target.remote, targetPath);
        const sourcePath = path.join(REPOS_DIR, 'DocumentationSkills');
        writeFile(path.join(sourcePath, 'skills', 'd2', 'SKILL.md'), '# d2\n');
        git(sourcePath, 'add', '-A');
        git(sourcePath, 'commit', '-q', '-m', 'add d2');
        await quiet(() => skills.installDefaultSkills('DocumentationSkills', { targetRoot: targetPath, pruneMissing: true }));
        const before = fs.existsSync(path.join(targetPath, '.agents', 'skills', 'd2', 'SKILL.md'));
        // The local default source stops offering d2; it is not part of this targeted update.
        git(sourcePath, 'reset', '-q', '--hard', 'HEAD~1');
        resetTrace();
        const run = await captured(() => commands.updateRepoResult('UnitTarget'));
        const record = run.value.records.find(entry => entry.phase === 'default-skills' && entry.id === 'DocumentationSkills->UnitTarget');
        done({
            before, record: [record.outcome, record.code],
            // The export is a link into the source checkout, now dangling: test the link itself.
            after: fs.lstatSync(path.join(targetPath, '.agents', 'skills', 'd2'), { throwIfNoEntry: false }) !== undefined,
            sourceState: record.details.sourceState,
            sourceMutations: networkOrMutation(sourcePath),
        });
    `);
    assert.equal(result.before, true);
    assert.equal(result.after, true, 'the output of a skill the unrefreshed source no longer offers is retained');
    assert.ok(['changed', 'unchanged'].includes(result.record[0]));
    assert.deepEqual(result.sourceMutations, []);
});

test('credentials in a failing source URL never reach the record, its source states or any printed line', () => {
    const result = runScenario(String.raw`
        const manifestPath = path.join(workspaceRoot, 'ploinky-skills-manifest.json');
        writeFile(manifestPath, JSON.stringify([{ name: 'Bad', url: 'https://user:secret@example.invalid/Bad.git', skills: ['b'] }]) + '\n');
        const run = await captured(() => commands.updateAllRepos(workspaceRoot, { interactiveSession: true }));
        done({ records: manifestRecords(run.value), out: run.out });
    `);
    assert.equal(result.records[0].outcome, 'failed');
    assert.equal(result.records[0].details.failedSources[0].name, 'Bad');
    assert.doesNotMatch(JSON.stringify(result.records), /secret/, 'neither the reason, failedSources nor sourceStates');
    assert.doesNotMatch(result.out.join('\n'), /secret/);
});

test('a prune larger than the recorded bound keeps its total and says how many lines were left out', () => {
    const result = runScenario(String.raw`
        const source = makeRemote('BigSkills', { 'skills/keep/SKILL.md': '# keep\n' });
        clone(source.remote, path.join(REPOS_DIR, 'BigSkills'));
        const gone = Array.from({ length: 150 }, (_, index) => 'gone' + String(index + 1).padStart(3, '0'));
        const manifestPath = path.join(workspaceRoot, 'ploinky-skills-manifest.json');
        writeFile(manifestPath, JSON.stringify([{ name: 'BigSkills', url: source.remote, skills: ['keep', ...gone] }]) + '\n');
        const run = await captured(() => commands.updateAllRepos(workspaceRoot, { interactiveSession: true }));
        const [record] = manifestRecords(run.value);
        done({
            outcome: record.outcome,
            count: record.details.prunedSkillCount,
            listed: record.details.prunedSkills.length,
            first: record.details.prunedSkills[0], last: record.details.prunedSkills[99],
            removedLines: run.out.filter(line => /Removed missing skill/.test(line)).length,
            more: run.out.filter(line => /and \d+ more skill\(s\) removed from the manifest/.test(line)),
            manifest: JSON.parse(fs.readFileSync(manifestPath, 'utf8'))[0].skills,
        });
    `);
    assert.equal(result.outcome, 'changed');
    assert.equal(result.count, 150, 'the total is recorded next to the bounded list');
    assert.equal(result.listed, 100, 'the list itself stays bounded');
    assert.deepEqual([result.first.skill, result.last.skill], ['gone001', 'gone100']);
    assert.equal(result.removedLines, 100);
    assert.deepEqual(result.more, ['    … and 50 more skill(s) removed from the manifest.']);
    assert.deepEqual(result.manifest, ['keep'], 'all 150 entries were pruned from the manifest');
});
