import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-branch-'));
const originalCwd = process.cwd();
process.chdir(tempDir);
process.env.PLOINKY_MASTER_KEY = '5'.repeat(64);
process.env.GIT_AUTHOR_NAME = 'Ploinky Tests';
process.env.GIT_AUTHOR_EMAIL = 'tests@ploinky.invalid';
process.env.GIT_COMMITTER_NAME = 'Ploinky Tests';
process.env.GIT_COMMITTER_EMAIL = 'tests@ploinky.invalid';

const moduleSuffix = `?test=${Date.now()}`;
const reposUrl = new URL('../../cli/services/repos.js', import.meta.url);
const bootstrapManifestUrl = new URL('../../cli/services/bootstrapManifest.js', import.meta.url);
const ploinkybootUrl = new URL('../../cli/services/ploinkyboot.js', import.meta.url);

const reposMod = await import(`${reposUrl.href}${moduleSuffix}`);
const bootstrapManifestMod = await import(`${bootstrapManifestUrl.href}${moduleSuffix}`);
const ploinkybootMod = await import(`${ploinkybootUrl.href}${moduleSuffix}`);

const {
    parseBranchPolicy,
    parseStartArgs,
    resolveBranchForRepo,
    remoteBranchExists,
    ensureRepoInstalled,
    ensureRepoOnBranch,
    loadEnabledRepos,
} = reposMod;
const { applyManifestDirectives, manifestEnableEntries } = bootstrapManifestMod;
const { bootstrap } = ploinkybootMod;

// ---------------------------------------------------------------------------
// Fixture helpers: create local bare repos with branches
// ---------------------------------------------------------------------------

function createBareRepo(name, { branches = [] } = {}) {
    const barePath = path.join(tempDir, 'remotes', name + '.git');
    fs.mkdirSync(barePath, { recursive: true });
    execFileSync('git', ['init', '--bare', barePath], { stdio: 'ignore' });

    const workPath = path.join(tempDir, 'work', name);
    fs.mkdirSync(workPath, { recursive: true });
    execFileSync('git', ['clone', barePath, workPath], { stdio: 'ignore' });
    execFileSync('git', ['-C', workPath, 'checkout', '-b', 'main'], { stdio: 'ignore' });
    execFileSync('git', ['-C', workPath, 'commit', '--allow-empty', '-m', 'init'], { stdio: 'ignore' });
    execFileSync('git', ['-C', workPath, 'push', 'origin', 'main'], { stdio: 'ignore' });
    execFileSync('git', ['--git-dir', barePath, 'symbolic-ref', 'HEAD', 'refs/heads/main'], { stdio: 'ignore' });

    for (const br of branches) {
        execFileSync('git', ['-C', workPath, 'checkout', '-b', br], { stdio: 'ignore' });
        execFileSync('git', ['-C', workPath, 'commit', '--allow-empty', '-m', `branch ${br}`], { stdio: 'ignore' });
        execFileSync('git', ['-C', workPath, 'push', 'origin', br], { stdio: 'ignore' });
    }

    fs.rmSync(workPath, { recursive: true, force: true });
    return barePath;
}

function createBareAgentRepo(name, agentName, { branches = [] } = {}) {
    const barePath = path.join(tempDir, 'remotes', name + '.git');
    fs.mkdirSync(barePath, { recursive: true });
    execFileSync('git', ['init', '--bare', barePath], { stdio: 'ignore' });

    const workPath = path.join(tempDir, 'work', name);
    fs.mkdirSync(path.dirname(workPath), { recursive: true });
    execFileSync('git', ['clone', barePath, workPath], { stdio: 'ignore' });
    execFileSync('git', ['-C', workPath, 'checkout', '-b', 'main'], { stdio: 'ignore' });
    const manifestDir = path.join(workPath, agentName);
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(path.join(manifestDir, 'manifest.json'), JSON.stringify({
        container: 'node:20',
        network: { mode: 'host' },
    }, null, 2));
    execFileSync('git', ['-C', workPath, 'add', '.'], { stdio: 'ignore' });
    execFileSync('git', ['-C', workPath, 'commit', '-m', 'agent manifest'], { stdio: 'ignore' });
    execFileSync('git', ['-C', workPath, 'push', 'origin', 'main'], { stdio: 'ignore' });
    execFileSync('git', ['--git-dir', barePath, 'symbolic-ref', 'HEAD', 'refs/heads/main'], { stdio: 'ignore' });

    for (const br of branches) {
        execFileSync('git', ['-C', workPath, 'checkout', '-b', br], { stdio: 'ignore' });
        execFileSync('git', ['-C', workPath, 'commit', '--allow-empty', '-m', `branch ${br}`], { stdio: 'ignore' });
        execFileSync('git', ['-C', workPath, 'push', 'origin', br], { stdio: 'ignore' });
    }

    fs.rmSync(workPath, { recursive: true, force: true });
    return barePath;
}

function writeAgentManifest(repoName, agentName, manifest) {
    const agentDir = path.join(tempDir, '.ploinky', 'repos', repoName, agentName);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'manifest.json'), JSON.stringify({
        network: { mode: 'host' },
        ...manifest,
    }, null, 2));
}

function writeRepoSource(repoName, url, branch = null) {
    const sourcesPath = path.join(tempDir, '.ploinky', 'repo_sources.json');
    fs.mkdirSync(path.dirname(sourcesPath), { recursive: true });
    let sources = {};
    try {
        sources = JSON.parse(fs.readFileSync(sourcesPath, 'utf8'));
    } catch (_) {}
    sources[repoName] = branch ? { url, branch } : { url };
    fs.writeFileSync(sourcesPath, JSON.stringify(sources, null, 2));
}

function initManagedRepo(name, { branches = [] } = {}) {
    const repoPath = path.join(tempDir, '.ploinky', 'repos', name);
    fs.mkdirSync(repoPath, { recursive: true });
    execFileSync('git', ['init', '-b', 'main', repoPath], { stdio: 'ignore' });
    execFileSync('git', ['-C', repoPath, 'commit', '--allow-empty', '-m', 'init'], { stdio: 'ignore' });
    for (const br of branches) {
        execFileSync('git', ['-C', repoPath, 'checkout', '-b', br], { stdio: 'ignore' });
        execFileSync('git', ['-C', repoPath, 'commit', '--allow-empty', '-m', br], { stdio: 'ignore' });
        execFileSync('git', ['-C', repoPath, 'checkout', 'main'], { stdio: 'ignore' });
    }
    return repoPath;
}

// ---------------------------------------------------------------------------
// parseBranchPolicy tests
// ---------------------------------------------------------------------------

test('parseBranchPolicy: empty args returns defaults', () => {
    const policy = parseBranchPolicy([]);
    assert.equal(policy.branch, null);
    assert.deepEqual(policy.repoBranches, {});
    assert.equal(policy.fallback, 'default');
    assert.equal(policy.resetRepos, false);
});

test('parseBranchPolicy: --branch value', () => {
    const policy = parseBranchPolicy(['--branch', 'feat-x']);
    assert.equal(policy.branch, 'feat-x');
});

test('parseBranchPolicy: --branch=value', () => {
    const policy = parseBranchPolicy(['--branch=feat-y']);
    assert.equal(policy.branch, 'feat-y');
});

test('parseBranchPolicy: repeated --repo-branch', () => {
    const policy = parseBranchPolicy([
        '--repo-branch', 'proxies=embedded',
        '--repo-branch', 'webmeetInfra=main',
    ]);
    assert.equal(policy.repoBranches.proxies, 'embedded');
    assert.equal(policy.repoBranches.webmeetInfra, 'main');
});

test('parseBranchPolicy: --repo-branch=repo=branch', () => {
    const policy = parseBranchPolicy(['--repo-branch=basic=develop']);
    assert.equal(policy.repoBranches.basic, 'develop');
});

test('parseBranchPolicy: malformed --repo-branch throws', () => {
    assert.throws(
        () => parseBranchPolicy(['--repo-branch', 'noequalssign']),
        /Malformed --repo-branch/,
    );
});

test('parseBranchPolicy: --branch-fallback fail', () => {
    const policy = parseBranchPolicy(['--branch-fallback', 'fail']);
    assert.equal(policy.fallback, 'fail');
});

test('parseBranchPolicy: invalid fallback throws', () => {
    assert.throws(
        () => parseBranchPolicy(['--branch-fallback', 'ignore']),
        /Invalid --branch-fallback/,
    );
});

test('parseBranchPolicy: --reset-repos', () => {
    const policy = parseBranchPolicy(['--reset-repos']);
    assert.equal(policy.resetRepos, true);
});

// ---------------------------------------------------------------------------
// parseStartArgs tests
// ---------------------------------------------------------------------------

test('parseStartArgs: positional agent and port', () => {
    const result = parseStartArgs(['AchillesIDE/explorer', '8080']);
    assert.equal(result.staticAgent, 'AchillesIDE/explorer');
    assert.equal(result.port, '8080');
});

test('parseStartArgs: rejects start-tail --port value before start mutation', () => {
    assert.throws(
        () => parseStartArgs(['AchillesIDE/explorer', '--port', '8097']),
        (error) => error.message.includes('start-tail --port')
            && error.message.includes('ploinky --port PORT start AGENT')
            && error.message.includes('ploinky start AGENT PORT'),
    );
});

test('parseStartArgs: rejects start-tail --port=value before start mutation', () => {
    assert.throws(
        () => parseStartArgs(['AchillesIDE/explorer', '--port=8097']),
        /start-tail --port/,
    );
});

test('parseStartArgs: agent with --branch', () => {
    const result = parseStartArgs(['AchillesIDE/explorer', '8080', '--branch', 'feat']);
    assert.equal(result.staticAgent, 'AchillesIDE/explorer');
    assert.equal(result.port, '8080');
    assert.equal(result.branchPolicy.branch, 'feat');
});

test('parseStartArgs: agent only, no port', () => {
    const result = parseStartArgs(['explorer', '--branch=main']);
    assert.equal(result.staticAgent, 'explorer');
    assert.equal(result.port, null);
    assert.equal(result.branchPolicy.branch, 'main');
});

test('parseStartArgs: full example with --repo-branch and --reset-repos', () => {
    const result = parseStartArgs([
        'AchillesIDE/explorer', '8097',
        '--branch', 'embedded-soul-gateway',
        '--repo-branch', 'webmeetInfra=main',
        '--branch-fallback', 'fail',
        '--reset-repos',
    ]);
    assert.equal(result.staticAgent, 'AchillesIDE/explorer');
    assert.equal(result.port, '8097');
    assert.equal(result.branchPolicy.branch, 'embedded-soul-gateway');
    assert.equal(result.branchPolicy.repoBranches.webmeetInfra, 'main');
    assert.equal(result.branchPolicy.fallback, 'fail');
    assert.equal(result.branchPolicy.resetRepos, true);
});

test('parseStartArgs: consumes --profile NAME before positional values', () => {
    const result = parseStartArgs(['--profile', 'DEV', 'AchillesIDE/explorer', '8097']);
    assert.equal(result.staticAgent, 'AchillesIDE/explorer');
    assert.equal(result.port, '8097');
    assert.equal(result.profile, 'dev');
});

test('parseStartArgs: consumes --profile=NAME after positional values', () => {
    const result = parseStartArgs(['AssistOSExplorer/explorer', '8097', '--profile=Prod']);
    assert.equal(result.staticAgent, 'AssistOSExplorer/explorer');
    assert.equal(result.port, '8097');
    assert.equal(result.profile, 'prod');
});

test('parseStartArgs: profile omission preserves direct in-box persisted-profile behavior', () => {
    const result = parseStartArgs(['explorer', '8080']);
    assert.equal(result.profile, null);
});

test('parseStartArgs: rejects --profile without a value instead of consuming an agent positional', () => {
    assert.throws(
        () => parseStartArgs(['explorer', '--profile']),
        /--profile needs a value/,
    );
});

// ---------------------------------------------------------------------------
// resolveBranchForRepo tests
// ---------------------------------------------------------------------------

test('resolveBranchForRepo: explicit repo-branch wins', () => {
    const branch = resolveBranchForRepo('proxies', { branch: 'manifest-br' }, {
        branch: 'global-br',
        repoBranches: { proxies: 'explicit-br' },
        fallback: 'default',
        resetRepos: false,
    });
    assert.equal(branch, 'explicit-br');
});

test('resolveBranchForRepo: manifest branch second priority', () => {
    const branch = resolveBranchForRepo('proxies', { branch: 'manifest-br' }, {
        branch: 'global-br',
        repoBranches: {},
        fallback: 'default',
        resetRepos: false,
    });
    assert.equal(branch, 'manifest-br');
});

test('resolveBranchForRepo: global --branch as fallback', () => {
    const branch = resolveBranchForRepo('proxies', null, {
        branch: 'global-br',
        repoBranches: {},
        fallback: 'default',
        resetRepos: false,
    });
    assert.equal(branch, 'global-br');
});

test('resolveBranchForRepo: null when no policy', () => {
    const branch = resolveBranchForRepo('proxies', null, null);
    assert.equal(branch, null);
});

// ---------------------------------------------------------------------------
// remoteBranchExists tests
// ---------------------------------------------------------------------------

test('remoteBranchExists: detects existing branch', () => {
    const barePath = createBareRepo('test-remote-exists', { branches: ['feat-a'] });
    assert.equal(remoteBranchExists(barePath, 'feat-a'), true);
    assert.equal(remoteBranchExists(barePath, 'no-such-branch'), false);
});

// ---------------------------------------------------------------------------
// ensureRepoInstalled tests (using local git fixtures)
// ---------------------------------------------------------------------------

test('ensureRepoInstalled: clones at requested branch', () => {
    const barePath = createBareRepo('test-install-branch', { branches: ['dev'] });
    const reposDir = path.join(tempDir, '.ploinky', 'repos');
    fs.mkdirSync(reposDir, { recursive: true });

    const result = ensureRepoInstalled('test-install-branch', barePath, {
        branchPolicy: { branch: 'dev', repoBranches: {}, fallback: 'default', resetRepos: false },
        stdio: 'ignore',
    });
    assert.equal(result.status, 'cloned');
    assert.equal(result.branch, 'dev');

    const clonedBranch = String(execFileSync('git', [
        '-C', path.join(reposDir, 'test-install-branch'),
        'rev-parse', '--abbrev-ref', 'HEAD',
    ])).trim();
    assert.equal(clonedBranch, 'dev');
});

test('ensureRepoInstalled: missing branch with fallback=default clones default', () => {
    const barePath = createBareRepo('test-install-fallback', { branches: [] });
    const reposDir = path.join(tempDir, '.ploinky', 'repos');
    fs.mkdirSync(reposDir, { recursive: true });

    const result = ensureRepoInstalled('test-install-fallback', barePath, {
        branchPolicy: { branch: 'no-such', repoBranches: {}, fallback: 'default', resetRepos: false },
        stdio: 'ignore',
    });
    assert.equal(result.status, 'cloned');
});

test('ensureRepoInstalled: missing branch with fallback=fail throws', () => {
    const barePath = createBareRepo('test-install-fail', { branches: [] });
    const reposDir = path.join(tempDir, '.ploinky', 'repos');
    fs.mkdirSync(reposDir, { recursive: true });

    assert.throws(
        () => ensureRepoInstalled('test-install-fail', barePath, {
            branchPolicy: { branch: 'nope', repoBranches: {}, fallback: 'fail', resetRepos: false },
            stdio: 'ignore',
        }),
        /Aborting/,
    );
});

test('ensureRepoInstalled: existing repo fallback records the actual current branch', () => {
    const barePath = createBareRepo('test-existing-record', { branches: [] });
    const repoPath = path.join(tempDir, '.ploinky', 'repos', 'test-existing-record');
    ensureRepoInstalled('test-existing-record', barePath, { stdio: 'ignore' });

    const result = ensureRepoInstalled('test-existing-record', barePath, {
        branchPolicy: { branch: 'ghost', repoBranches: {}, fallback: 'default', resetRepos: false },
        stdio: 'ignore',
    });

    const sources = JSON.parse(fs.readFileSync(path.join(tempDir, '.ploinky', 'repo_sources.json'), 'utf8'));
    const current = String(execFileSync('git', [
        '-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD',
    ])).trim();
    assert.equal(current, 'main');
    assert.equal(result.branch, 'main');
    assert.equal(sources['test-existing-record'].branch, 'main');
});

// ---------------------------------------------------------------------------
// ensureRepoOnBranch tests
// ---------------------------------------------------------------------------

test('ensureRepoOnBranch: switches clean repo to new branch', () => {
    const barePath = createBareRepo('test-switch-clean', { branches: ['feature'] });
    const repoPath = path.join(tempDir, '.ploinky', 'repos', 'test-switch-clean');
    fs.mkdirSync(path.dirname(repoPath), { recursive: true });
    execFileSync('git', ['clone', barePath, repoPath], { stdio: 'ignore' });

    ensureRepoOnBranch('test-switch-clean', { branch: 'feature', stdio: 'ignore' });

    const current = String(execFileSync('git', ['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    assert.equal(current, 'feature');
});

test('ensureRepoOnBranch: dirty repo without --reset-repos throws', () => {
    const barePath = createBareRepo('test-dirty-reject', { branches: ['other'] });
    const repoPath = path.join(tempDir, '.ploinky', 'repos', 'test-dirty-reject');
    fs.mkdirSync(path.dirname(repoPath), { recursive: true });
    execFileSync('git', ['clone', barePath, repoPath], { stdio: 'ignore' });
    fs.writeFileSync(path.join(repoPath, 'dirty.txt'), 'uncommitted');

    assert.throws(
        () => ensureRepoOnBranch('test-dirty-reject', { branch: 'other', resetRepos: false, stdio: 'ignore' }),
        /uncommitted changes/,
    );
});

test('ensureRepoOnBranch: dirty repo with --reset-repos succeeds', () => {
    const barePath = createBareRepo('test-dirty-reset', { branches: ['other'] });
    const repoPath = path.join(tempDir, '.ploinky', 'repos', 'test-dirty-reset');
    fs.mkdirSync(path.dirname(repoPath), { recursive: true });
    execFileSync('git', ['clone', barePath, repoPath], { stdio: 'ignore' });
    fs.writeFileSync(path.join(repoPath, 'dirty.txt'), 'uncommitted');

    ensureRepoOnBranch('test-dirty-reset', { branch: 'other', resetRepos: true, stdio: 'ignore' });

    const current = String(execFileSync('git', ['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    assert.equal(current, 'other');
    assert.equal(fs.existsSync(path.join(repoPath, 'dirty.txt')), false);
});

test('ensureRepoOnBranch: missing branch with fallback=fail throws', () => {
    const barePath = createBareRepo('test-missing-fail', { branches: [] });
    const repoPath = path.join(tempDir, '.ploinky', 'repos', 'test-missing-fail');
    fs.mkdirSync(path.dirname(repoPath), { recursive: true });
    execFileSync('git', ['clone', barePath, repoPath], { stdio: 'ignore' });

    assert.throws(
        () => ensureRepoOnBranch('test-missing-fail', { branch: 'ghost', fallback: 'fail', stdio: 'ignore' }),
        /does not exist/,
    );
});

test('ensureRepoOnBranch: missing branch with fallback=default keeps current', () => {
    const barePath = createBareRepo('test-missing-default', { branches: [] });
    const repoPath = path.join(tempDir, '.ploinky', 'repos', 'test-missing-default');
    fs.mkdirSync(path.dirname(repoPath), { recursive: true });
    execFileSync('git', ['clone', barePath, repoPath], { stdio: 'ignore' });

    ensureRepoOnBranch('test-missing-default', { branch: 'ghost', fallback: 'default', stdio: 'ignore' });

    const current = String(execFileSync('git', ['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    assert.equal(current, 'main');
});

// ---------------------------------------------------------------------------
// startup integration guards
// ---------------------------------------------------------------------------

test('bootstrap: global branch policy only applies to the static repo among default boot repos', () => {
    const basicPath = initManagedRepo('basic');
    const idePath = initManagedRepo('AchillesIDE', { branches: ['feature-start'] });
    const cliPath = initManagedRepo('AchillesCLI');
    initManagedRepo('copilot-agents');

    assert.doesNotThrow(() => bootstrap({
        staticAgent: 'AchillesIDE/explorer',
        branchPolicy: {
            branch: 'feature-start',
            repoBranches: {},
            fallback: 'fail',
            resetRepos: false,
        },
    }));

    const basicBranch = String(execFileSync('git', ['-C', basicPath, 'rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    const ideBranch = String(execFileSync('git', ['-C', idePath, 'rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    const cliBranch = String(execFileSync('git', ['-C', cliPath, 'rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    assert.equal(basicBranch, 'main');
    assert.equal(ideBranch, 'feature-start');
    assert.equal(cliBranch, 'main');
});

test('bootstrap: a bare static agent name resolves its own repo for the global branch', () => {
    // Isolate from the prior bootstrap test which reuses these default-repo names.
    for (const r of ['basic', 'AchillesIDE', 'AchillesCLI', 'copilot-agents']) {
        fs.rmSync(path.join(tempDir, '.ploinky', 'repos', r), { recursive: true, force: true });
    }
    fs.rmSync(path.join(tempDir, '.ploinky', 'enabled_repos.json'), { force: true });

    const idePath = initManagedRepo('AchillesIDE', { branches: ['feature-start'] });
    const basicPath = initManagedRepo('basic');
    initManagedRepo('AchillesCLI');
    initManagedRepo('copilot-agents');

    // findAgent('explorer') must resolve to AchillesIDE; commit the manifest so
    // the repo is clean for the branch checkout.
    const explorerDir = path.join(idePath, 'explorer');
    fs.mkdirSync(explorerDir, { recursive: true });
    fs.writeFileSync(path.join(explorerDir, 'manifest.json'), JSON.stringify({ container: 'node:20' }, null, 2));
    execFileSync('git', ['-C', idePath, 'add', '.'], { stdio: 'ignore' });
    execFileSync('git', ['-C', idePath, 'commit', '-m', 'add explorer manifest'], { stdio: 'ignore' });

    bootstrap({
        // BARE agent name (no repo prefix) — must still place AchillesIDE on the branch.
        staticAgent: 'explorer',
        branchPolicy: { branch: 'feature-start', repoBranches: {}, fallback: 'fail', resetRepos: false },
    });

    const ideBranch = String(execFileSync('git', ['-C', idePath, 'rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    const basicBranch = String(execFileSync('git', ['-C', basicPath, 'rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    assert.equal(ideBranch, 'feature-start');
    // The static repo's branch must NOT bleed onto unrelated boot repos.
    assert.equal(basicBranch, 'main');
});

test('applyManifestDirectives: strict branch policy aborts manifest repo fallback', async () => {
    const barePath = createBareRepo('manifest-strict-remote', { branches: [] });
    writeAgentManifest('staticStrict', 'app', {
        container: 'node:20',
        repos: {
            manifestStrictDep: barePath,
        },
    });

    await assert.rejects(
        () => applyManifestDirectives('staticStrict/app', {
            branchPolicy: {
                branch: 'missing-branch',
                repoBranches: {},
                fallback: 'fail',
                resetRepos: false,
            },
        }),
        /Failed to install repo 'manifestStrictDep'/,
    );

    assert.equal(fs.existsSync(path.join(tempDir, '.ploinky', 'repos', 'manifestStrictDep')), false);
    assert.equal(loadEnabledRepos().includes('manifestStrictDep'), false);
});

test('applyManifestDirectives: profile enable auto-installs missing prefixed repo', async () => {
    const barePath = createBareAgentRepo('profileAutoRepo', 'worker', { branches: ['feature-profile'] });
    writeRepoSource('profileAutoRepo', barePath);
    fs.mkdirSync(path.join(tempDir, '.ploinky'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, '.ploinky', 'profile'), 'embedded');
    writeAgentManifest('staticProfile', 'app', {
        container: 'node:20',
        profiles: {
            default: {},
            embedded: {
                enable: ['profileAutoRepo/worker'],
            },
        },
    });

    await applyManifestDirectives('staticProfile/app', {
        branchPolicy: {
            branch: 'feature-profile',
            repoBranches: {},
            fallback: 'fail',
            resetRepos: false,
        },
    });

    const repoPath = path.join(tempDir, '.ploinky', 'repos', 'profileAutoRepo');
    const current = String(execFileSync('git', ['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    assert.equal(current, 'feature-profile');
    assert.equal(loadEnabledRepos().includes('profileAutoRepo'), true);
    fs.writeFileSync(path.join(tempDir, '.ploinky', 'profile'), 'default');
});

test('manifestEnableEntries: default profile enable is used when active profile is absent', (t) => {
    const profilePath = path.join(tempDir, '.ploinky', 'profile');
    fs.mkdirSync(path.dirname(profilePath), { recursive: true });
    fs.writeFileSync(profilePath, 'embedded');
    t.after(() => fs.writeFileSync(profilePath, 'default'));

    const entries = manifestEnableEntries({
        enable: ['base-agent'],
        profiles: {
            default: {
                enable: ['default-profile-agent'],
            },
        },
    });

    assert.deepEqual(entries, ['base-agent', 'default-profile-agent']);
});

test('applyManifestDirectives: child manifest repos are applied before recursive enables resolve', async () => {
    const workerRemote = createBareAgentRepo('childWorkerRepo', 'worker');
    writeAgentManifest('toolRepo', 'tool', {
        container: 'node:20',
        repos: {
            childWorkerRepo: workerRemote,
        },
        enable: ['childWorkerRepo/worker global'],
    });
    writeAgentManifest('staticChildRepos', 'app', {
        container: 'node:20',
        enable: ['toolRepo/tool global'],
    });

    await applyManifestDirectives('staticChildRepos/app');

    const workerRepoPath = path.join(tempDir, '.ploinky', 'repos', 'childWorkerRepo');
    assert.equal(fs.existsSync(workerRepoPath), true);
    assert.equal(loadEnabledRepos().includes('childWorkerRepo'), true);

    const agentsPath = path.join(tempDir, '.ploinky', 'agents.json');
    const agents = JSON.parse(fs.readFileSync(agentsPath, 'utf8'));
    assert.ok(
        Object.values(agents).some((record) => (
            record
            && record.type === 'agent'
            && record.repoName === 'childWorkerRepo'
            && record.agentName === 'worker'
            && record.runMode === 'global'
        ))
    );
});

test('applyManifestDirectives: duplicate aliased child enables are idempotent under strict policy', async () => {
    writeAgentManifest('leafRepo', 'leaf', {
        container: 'node:20',
    });
    writeAgentManifest('diamondARepo', 'a', {
        container: 'node:20',
        enable: ['leafRepo/leaf as diamondLeaf global'],
    });
    writeAgentManifest('diamondBRepo', 'b', {
        container: 'node:20',
        enable: ['leafRepo/leaf as diamondLeaf global'],
    });
    writeAgentManifest('staticDiamond', 'app', {
        container: 'node:20',
        enable: [
            'diamondARepo/a global',
            'diamondBRepo/b global',
        ],
    });

    await assert.doesNotReject(() => applyManifestDirectives('staticDiamond/app', {
        branchPolicy: {
            branch: 'main',
            repoBranches: {},
            fallback: 'fail',
            resetRepos: false,
        },
    }));

    const agentsPath = path.join(tempDir, '.ploinky', 'agents.json');
    const agents = JSON.parse(fs.readFileSync(agentsPath, 'utf8'));
    const leafRecords = Object.values(agents).filter((record) => (
        record
        && record.type === 'agent'
        && record.repoName === 'leafRepo'
        && record.agentName === 'leaf'
        && record.alias === 'diamondLeaf'
    ));
    assert.equal(leafRecords.length, 1);
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

test.after(() => {
    try {
        const records = JSON.parse(fs.readFileSync(path.join(tempDir, '.ploinky', 'agents.json'), 'utf8'));
        for (const containerName of Object.keys(records).filter((name) => name.startsWith('ploinky_'))) {
            execFileSync('podman', ['rm', '-f', '--time', '0', containerName], { stdio: 'ignore' });
        }
    } catch (_) {}
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
});
