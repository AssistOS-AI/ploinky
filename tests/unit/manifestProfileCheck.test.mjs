import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Exit codes 0/1/2 of the standalone checker, the shared rules, `ploinky
// profile check`, and the behaviour-neutrality tool.

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const checker = path.join(repoRoot, 'cli', 'tools', 'checkManifestProfiles.mjs');
const equivalence = path.join(repoRoot, 'tests', 'tools', 'profileEquivalence.mjs');
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-profile-check-')));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const FULL = { default: {}, dev: {}, qa: {}, prod: {} };

function makeRepo(name, agents) {
    const root = path.join(scratch, name);
    fs.mkdirSync(root, { recursive: true });
    for (const [agent, manifest] of Object.entries(agents)) {
        fs.mkdirSync(path.join(root, agent), { recursive: true });
        fs.writeFileSync(
            path.join(root, agent, 'manifest.json'),
            typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2),
        );
    }
    return root;
}

function run(script, args) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    return { status: result.status, out: result.stdout, err: result.stderr };
}

test('exit 0 with OK N manifests when every manifest declares the four profiles', () => {
    const root = makeRepo('good', { a: { profiles: FULL }, b: { profiles: { ...FULL, embedded: {} } } });
    const result = run(checker, ['--require', 'default,dev,qa,prod', root]);
    assert.equal(result.status, 0, result.err);
    assert.match(result.out, /^OK 2 manifests$/m);
    // The default requirement is the four names.
    assert.equal(run(checker, [root]).status, 0);
    // Several roots add up.
    const second = makeRepo('good2', { c: { profiles: FULL } });
    assert.match(run(checker, [root, second]).out, /^OK 3 manifests$/m);
});

test('exit 1 for any failing manifest, naming it', () => {
    const cases = {
        missingQa: { profiles: { default: {}, dev: {}, prod: {} } },
        nullProd: { profiles: { default: {}, dev: {}, qa: {}, prod: null } },
        arrayProfiles: { profiles: [] },
        noProfiles: { container: 'x' },
        emptyProfiles: { profiles: {} },
        notObject: '[1,2]',
        malformed: '{ "profiles": ',
    };
    for (const [name, manifest] of Object.entries(cases)) {
        const root = makeRepo(`bad-${name}`, { ok: { profiles: FULL }, bad: manifest });
        const result = run(checker, ['--require', 'default,dev,qa,prod', root]);
        assert.equal(result.status, 1, `${name}: ${result.out}${result.err}`);
        assert.match(result.err, new RegExp(`bad-${name}/bad`), name);
        assert.doesNotMatch(result.out, /^OK/m);
    }
});

test('exit 2 when nothing was found, never a pass', () => {
    const empty = makeRepo('empty', {});
    assert.equal(run(checker, [empty]).status, 2);
    assert.equal(run(checker, [path.join(scratch, 'missing-root')]).status, 2);
    assert.equal(run(checker, []).status, 2);
    assert.equal(run(checker, ['--require', '', empty]).status, 2);
    assert.equal(run(checker, ['--bogus', empty]).status, 2);
    // node_modules and dot directories are not agents.
    const hidden = makeRepo('hidden', {});
    fs.mkdirSync(path.join(hidden, 'node_modules', 'x'), { recursive: true });
    fs.writeFileSync(path.join(hidden, 'node_modules', 'x', 'manifest.json'), '{}');
    fs.mkdirSync(path.join(hidden, '.git'), { recursive: true });
    fs.writeFileSync(path.join(hidden, '.git', 'manifest.json'), '{}');
    assert.equal(run(checker, [hidden]).status, 2);
});

test('--require limits the check to the named profiles', () => {
    const root = makeRepo('partial', { a: { profiles: { default: {}, qa: {} } } });
    assert.equal(run(checker, ['--require', 'default,qa', root]).status, 0);
    assert.equal(run(checker, ['--require=default,qa,prod', root]).status, 1);
    assert.equal(run(checker, [root]).status, 1);
});

function git(root, ...args) {
    return execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { encoding: 'utf8' }).trim();
}

test('equivalence tool: added empty profiles are neutral, a changed profile is a difference, an allowlisted one is listed', () => {
    const root = makeRepo('equiv', {
        plain: { profiles: { default: { env: ['A=1'], install: 'npm ci' } } },
        legacy: { install: 'make', env: ['B=2'] },
        webmeetScribeAgent: { profiles: { default: { env: ['C=3'] }, prod: { env: ['C=4'] } } },
    });
    git(root, 'init', '-q');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'base');
    const base = git(root, 'rev-parse', 'HEAD');
    // Add the three missing profiles as `{}` to every manifest.
    for (const agent of ['plain', 'legacy', 'webmeetScribeAgent']) {
        const file = path.join(root, agent, 'manifest.json');
        const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
        manifest.profiles = { default: {}, ...manifest.profiles };
        for (const name of ['dev', 'qa', 'prod']) manifest.profiles[name] = manifest.profiles[name] || {};
        fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
    }
    // The scribe's prod profile changes on purpose: allowlisted by default.
    const scribe = path.join(root, 'webmeetScribeAgent', 'manifest.json');
    const scribeManifest = JSON.parse(fs.readFileSync(scribe, 'utf8'));
    scribeManifest.profiles.prod = { env: ['C=5'] };
    fs.writeFileSync(scribe, JSON.stringify(scribeManifest, null, 2));

    const neutral = run(equivalence, ['--base', base, root]);
    assert.equal(neutral.status, 0, `${neutral.out}${neutral.err}`);
    assert.match(neutral.out, /ALLOWED webmeetScribeAgent\/prod/);
    assert.match(neutral.out, /^EQUIVALENT 3 manifests/m);

    // Without the allowlist the same change fails.
    const strict = run(equivalence, ['--base', base, '--allow', 'none/none', root]);
    assert.equal(strict.status, 1);
    assert.match(strict.err, /FAIL webmeetScribeAgent\/prod/);

    // A new profile that changes behaviour for its own name is a difference.
    const plain = path.join(root, 'plain', 'manifest.json');
    const plainManifest = JSON.parse(fs.readFileSync(plain, 'utf8'));
    plainManifest.profiles.qa = { env: ['A=2'] };
    fs.writeFileSync(plain, JSON.stringify(plainManifest, null, 2));
    const changed = run(equivalence, ['--base', base, root]);
    assert.equal(changed.status, 1);
    assert.match(changed.err, /FAIL plain\/qa: 'env' differs/);

    // Usage errors are 2.
    assert.equal(run(equivalence, [root]).status, 2);
    assert.equal(run(equivalence, ['--base', 'no-such-rev', root]).status, 2);
});

test('ploinky profile check: registry and graph scope, exit semantics', async () => {
    const workspace = fs.realpathSync(fs.mkdtempSync(path.join(scratch, 'ws-')));
    const child = `
        import fs from 'node:fs';
        import path from 'node:path';
        const root = process.env.PLOINKY_WORKSPACE_ROOT;
        const repo = (name, manifest) => {
            const dir = path.join(root, '.ploinky', 'repos', 'r', name);
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'manifest.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
        };
        const FULL = ${JSON.stringify(FULL)};
        const { handleProfileCommand } = await import(${JSON.stringify(new URL('../../cli/commands/profileCommands.js', import.meta.url).href)});
        const { saveAgents } = await import(${JSON.stringify(new URL('../../cli/utils/workspace.js', import.meta.url).href)});
        const outcome = {};
        const attempt = async (label, args) => {
            const log = console.log; const err = console.error;
            console.log = () => {}; console.error = () => {};
            try { await handleProfileCommand(args); outcome[label] = 'ok'; }
            catch (error) { outcome[label] = 'throws:' + String(error.message).slice(0, 40); }
            finally { console.log = log; console.error = err; }
        };
        // Nothing enabled: never a pass.
        await attempt('empty', ['check']);
        repo('good', { container: 'x', profiles: FULL });
        repo('weak', { container: 'x', profiles: { default: {}, qa: {} } });
        repo('broken', '{ nope');
        const record = (agentName) => ({ type: 'agent', repoName: 'r', agentName });
        saveAgents({ ploinky_r_good: record('good') });
        await attempt('good', ['check']);
        await attempt('goodRequireTwo', ['check', '--require', 'default,qa']);
        saveAgents({ ploinky_r_good: record('good'), ploinky_r_weak: record('weak') });
        await attempt('weak', ['check']);
        await attempt('weakTwo', ['check', '--require=default,qa']);
        saveAgents({ ploinky_r_good: record('good'), ploinky_r_broken: record('broken') });
        await attempt('broken', ['check']);
        saveAgents({ ploinky_r_good: record('good'), ploinky_r_ghost: record('ghost') });
        await attempt('ghost', ['check']);
        await attempt('usage', ['check', '--bogus']);
        console.log('RESULT ' + JSON.stringify(outcome));
    `;
    const result = spawnSync(process.execPath, ['--import', path.join(repoRoot, 'tests/helpers/agentlibTestContract.mjs'), '--input-type=module', '-e', child], {
        cwd: workspace,
        encoding: 'utf8',
        env: { ...process.env, PLOINKY_WORKSPACE_ROOT: workspace, PLOINKY_MASTER_KEY: randomUUID().replaceAll('-', '').padEnd(64, 'c') },
    });
    assert.equal(result.status, 0, result.stderr);
    const outcome = JSON.parse(result.stdout.split('\n').find((line) => line.startsWith('RESULT ')).slice(7));
    assert.match(outcome.empty, /^throws:/);
    assert.equal(outcome.good, 'ok');
    assert.equal(outcome.goodRequireTwo, 'ok');
    assert.match(outcome.weak, /^throws:/);
    assert.equal(outcome.weakTwo, 'ok');
    assert.match(outcome.broken, /^throws:/);
    assert.match(outcome.ghost, /^throws:/);
    assert.match(outcome.usage, /^throws:/);
});
