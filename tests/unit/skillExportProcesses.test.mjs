import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Two real exporter processes on one consumer folder. Each child runs the
// production entry point (managedExports.syncManagedSkillExports with the
// Ploinky link factory and the real exclusion planner) with real process
// identity; barrier files make their lock acquisition overlap.

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const moduleUrl = relative => pathToFileURL(path.join(projectRoot, relative)).href;

const CHILD = String.raw`
    import fs from 'node:fs';
    import path from 'node:path';
    const { syncManagedSkillExports } = await import(process.env.EXPORT_MODULE);
    const { createSkillExclusionPlanner } = await import(process.env.EXCLUSIONS_MODULE);
    const barrier = process.env.BARRIER;
    const role = process.env.ROLE;
    const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    const waitFor = name => {
        const deadline = Date.now() + 30000;
        while (!fs.existsSync(path.join(barrier, name))) {
            if (Date.now() > deadline) throw new Error('barrier timeout: ' + name);
            sleep(5);
        }
    };
    const signal = name => fs.writeFileSync(path.join(barrier, name), String(process.pid));
    const events = [];
    const inside = path.join(barrier, 'inside');
    const hooks = {
        crash(point) {
            if (point === 'before-journal') {
                // Only one process may ever be between the lock and its release.
                try { fs.writeFileSync(inside, role, { flag: 'wx' }); } catch (error) { events.push({ violation: error.code, holder: fs.readFileSync(inside, 'utf8') }); }
                events.push({ enter: Date.now() });
                if (process.env.PARK === '1') { signal('holding-' + role); waitFor('release'); }
                else sleep(Number(process.env.DWELL_MS || 0));
            }
            if (point === 'after-commit') {
                events.push({ leave: Date.now() });
                fs.rmSync(inside, { force: true });
            }
        },
    };
    signal('ready-' + role);
    waitFor(process.env.START || 'go');
    let result;
    try {
        const exported = syncManagedSkillExports({
            folder: process.env.FOLDER, owner: process.env.OWNER,
            sources: JSON.parse(process.env.SOURCES).map(([name, directory]) => ({ name, path: directory, source: { name: 'fixture' } })),
            claude: 'root-or-skills',
            exclusions: createSkillExclusionPlanner({ containerExecutor: false }),
            lock: { waitMs: Number(process.env.WAIT_MS) },
            hooks,
        });
        result = { ok: true, installed: exported.installed, transaction: exported.transaction.status, exclusions: exported.exclusions?.status };
    } catch (error) {
        result = { ok: false, code: error.code, outcome: error.outcome, message: error.message };
    }
    process.stdout.write('RESULT:' + JSON.stringify({ ...result, pid: process.pid, events }) + '\n');
`;

function fixture(t) {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skill-export-processes-')));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const env = { ...process.env };
    for (const key of ['PLOINKY_SKILL_EXCLUDES_COMPOSE', 'GIT_CONFIG_SYSTEM', 'GIT_DIR', 'GIT_WORK_TREE']) delete env[key];
    fs.writeFileSync(path.join(base, 'gitconfig'), '');
    Object.assign(env, {
        HOME: base, XDG_CONFIG_HOME: path.join(base, 'xdg'), GIT_CONFIG_GLOBAL: path.join(base, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
        PLOINKY_WORKSPACE_ROOT: base,
        EXPORT_MODULE: moduleUrl('cli/utils/skills/managedExports.js'),
        EXCLUSIONS_MODULE: moduleUrl('cli/utils/skills/exportExclusions.mjs'),
    });
    const project = path.join(base, 'project');
    fs.mkdirSync(project);
    const git = (...args) => execFileSync('git', args, { cwd: project, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const userFiles = { 'README.md': '# user readme\n', '.gitignore': 'node_modules\n', [path.join('.agents', 'skills', 'mine', 'SKILL.md')]: '# mine\n' };
    for (const [relative, content] of Object.entries(userFiles)) {
        fs.mkdirSync(path.dirname(path.join(project, relative)), { recursive: true });
        fs.writeFileSync(path.join(project, relative), content);
    }
    git('init', '-q');
    git('add', '.');
    git('commit', '-q', '-m', 'initial');
    const skill = name => {
        const directory = path.join(base, 'sources', name);
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, 'SKILL.md'), `# ${name}\n`);
        return directory;
    };
    const barrier = path.join(base, 'barrier');
    fs.mkdirSync(barrier);
    const child = (role, extra) => {
        const proc = spawn(process.execPath, ['--input-type=module', '-e', CHILD], {
            cwd: base, env: { ...env, ...extra, ROLE: role, BARRIER: barrier, FOLDER: project }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', chunk => { stdout += chunk; });
        proc.stderr.on('data', chunk => { stderr += chunk; });
        const done = new Promise(resolve => proc.on('close', code => {
            const line = stdout.split('\n').find(item => item.startsWith('RESULT:'));
            resolve({ code, stderr, result: line ? JSON.parse(line.slice('RESULT:'.length)) : null });
        }));
        return { proc, done };
    };
    const until = async name => {
        const deadline = Date.now() + 30000;
        while (!fs.existsSync(path.join(barrier, name))) {
            if (Date.now() > deadline) throw new Error(`barrier timeout: ${name}`);
            await new Promise(resolve => setTimeout(resolve, 5));
        }
    };
    const signal = name => fs.writeFileSync(path.join(barrier, name), 'parent');
    const ledger = () => JSON.parse(fs.readFileSync(path.join(project, '.agents', '.ploinky-skill-exports.json'), 'utf8'));
    const skillsDir = path.join(project, '.agents', 'skills');
    const assertConsistent = expected => {
        const entries = ledger().entries;
        assert.deepEqual(Object.keys(entries).sort(), Object.keys(expected).sort());
        for (const [name, [owner, directory]] of Object.entries(expected)) {
            assert.equal(entries[name].owner, owner);
            assert.equal(entries[name].kind, 'symlink');
            const link = path.join(skillsDir, name);
            assert.ok(fs.lstatSync(link).isSymbolicLink(), name);
            assert.equal(fs.realpathSync(link), directory);
        }
        assert.deepEqual(fs.readdirSync(skillsDir).sort(), [...Object.keys(expected), 'mine'].sort(), 'no other published output');
        const excluded = fs.readFileSync(path.join(project, '.git', 'ploinky-skill-exports.exclude'), 'utf8');
        for (const name of Object.keys(expected)) assert.match(excluded, new RegExp(`^/\\.agents/skills/${name}$`, 'm'));
        assert.equal(git('status', '--porcelain', '--untracked-files=all'), '', 'one complete publication leaves a clean worktree');
        for (const [relative, content] of Object.entries(userFiles)) assert.equal(fs.readFileSync(path.join(project, relative), 'utf8'), content, relative);
        for (const name of ['.ploinky-skill-exports.journal.json', '.ploinky-skill-exports.lock', '.ploinky-export-quarantine']) {
            assert.equal(fs.existsSync(path.join(project, '.agents', name)), false, name);
        }
        assert.deepEqual(fs.readdirSync(path.join(project, '.agents', '.ploinky-export-staging')), [], 'no staging is left behind');
        assert.equal(fs.existsSync(path.join(project, '.git', 'ploinky-skill-exports-config.lock')), false);
        assert.equal(fs.existsSync(path.join(barrier, 'inside')), false);
    };
    return { base, project, skill, child, until, signal, assertConsistent };
}

test('a second real exporter process reports the live holder as busy and changes nothing', async t => {
    const f = fixture(t);
    const alpha = f.skill('alpha');
    const beta = f.skill('beta');
    const holder = f.child('holder', { OWNER: 'manifest', SOURCES: JSON.stringify([['alpha', alpha]]), WAIT_MS: '0', PARK: '1' });
    // The contender starts only once the holder is parked inside its lock.
    const contender = f.child('contender', { OWNER: 'defaults:other', SOURCES: JSON.stringify([['beta', beta]]), WAIT_MS: '0', START: 'holding-holder' });
    await Promise.all([f.until('ready-holder'), f.until('ready-contender')]);
    f.signal('go');
    const busy = await contender.done;
    assert.equal(busy.code, 0, busy.stderr);
    f.signal('release');
    const held = await holder.done;
    assert.equal(held.code, 0, held.stderr);

    assert.equal(busy.result.ok, false);
    assert.equal(busy.result.code, 'SKILL_EXPORT_LOCK_BUSY', busy.result.message);
    assert.equal(busy.result.outcome, 'blocked-busy');
    assert.match(busy.result.message, new RegExp(`held by pid ${held.result.pid}`));
    assert.deepEqual(busy.result.events, [], 'the contender never entered the lock');
    assert.equal(held.result.ok, true, held.result.message);
    assert.equal(held.result.transaction, 'committed');
    assert.equal(held.result.exclusions, 'published');
    assert.ok(held.result.events.every(event => !event.violation));
    f.assertConsistent({ alpha: ['manifest', alpha] });
});

test('two real exporter processes started together publish one at a time and both complete', async t => {
    const f = fixture(t);
    const alpha = f.skill('alpha');
    const beta = f.skill('beta');
    const common = { WAIT_MS: '30000', DWELL_MS: '300' };
    const first = f.child('first', { ...common, OWNER: 'manifest', SOURCES: JSON.stringify([['alpha', alpha]]) });
    const second = f.child('second', { ...common, OWNER: 'defaults:other', SOURCES: JSON.stringify([['beta', beta]]) });
    await Promise.all([f.until('ready-first'), f.until('ready-second')]);
    f.signal('go');
    const results = await Promise.all([first.done, second.done]);
    for (const { code, stderr, result } of results) {
        assert.equal(code, 0, stderr);
        assert.equal(result.ok, true, result.message);
        assert.equal(result.transaction, 'committed');
        assert.equal(result.exclusions, 'published');
        assert.ok(result.events.every(event => !event.violation), JSON.stringify(result.events));
    }
    // Exactly one writer at a time: the critical sections never overlap.
    const [a, b] = results.map(({ result }) => ({ enter: result.events.find(event => event.enter).enter, leave: result.events.find(event => event.leave).leave }))
        .sort((left, right) => left.enter - right.enter);
    assert.ok(a.leave <= b.enter, `sections overlap: ${JSON.stringify([a, b])}`);
    f.assertConsistent({ alpha: ['manifest', alpha], beta: ['defaults:other', beta] });
});
