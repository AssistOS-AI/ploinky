import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readUpdateReport, createUpdateReportNonce, UPDATE_REPORT_CONTEXT_ENV, UPDATE_REPORT_NONCE_ENV } from '../../cli/commands/updateOutcome.js';
import { parseUpdateRequest } from '../../cli/commands/updateRequest.js';

// End-to-end core -> host update report protocol without a live Box. The real
// in-Box core (`ploinky-local update` through launchCli and the core
// dispatcher) runs in a child process inside a simulated Box, with the nonce
// and context environment exactly as `runBoundedUpdateCommand` sets them. The
// host side reads the report with the same reader and arguments as
// `executeCoreUpdate`: readUpdateReport(<workspace>/.ploinky, nonce,
// { expectedContext }), and compares the process exit with the report.
//
// The context mirrors supervisor.mjs `updateContext()` (not exported); the
// request is built with the same `parseUpdateRequest` the supervisor uses.

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const moduleUrl = rel => pathToFileURL(path.join(projectRoot, rel)).href;

function hostContext({ workspaceRoot, coreArgv }) {
    const request = parseUpdateRequest(coreArgv.slice(1), { cwd: workspaceRoot });
    return JSON.parse(JSON.stringify({
        schema: 'ploinky-update-context',
        version: 1,
        workspace: { instance: 'ploinky-box-workspace-0123456789ab', workspaceRoot },
        request,
        coreArgv: [...coreArgv],
        scope: { relative: '.', boxPath: workspaceRoot },
        box: { containerId: 'c0ffee', action: 'reused', imageId: 'sha256:' + '1'.repeat(64) },
        source: {
            workspacePloinky: null,
            agentLib: { changed: false, mode: 'local', fingerprint: 'a'.repeat(64) },
        },
    }));
}

function runCore(setup, { container = false } = {}) {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-update-protocol-'));
    try {
        const workspaceRoot = path.join(scratch, 'workspace');
        fs.mkdirSync(path.join(workspaceRoot, '.ploinky'), { recursive: true });
        // The mounted Ploinky source lives outside the workspace, as in the Box.
        fs.mkdirSync(path.join(scratch, 'runtime-root'), { recursive: true });
        const globalConfig = path.join(scratch, 'gitconfig');
        fs.writeFileSync(globalConfig, '[user]\n\tname = Ploinky Test\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n');
        const coreArgv = ['update', workspaceRoot];
        const context = hostContext({ workspaceRoot, coreArgv });
        const nonce = createUpdateReportNonce();
        const env = {
            ...process.env,
            HOME: scratch,
            GIT_CONFIG_GLOBAL: globalConfig,
            GIT_CONFIG_NOSYSTEM: '1',
            PLOINKY_WORKSPACE_ROOT: workspaceRoot,
            PLOINKY_ROOT: path.join(scratch, 'runtime-root'),
            PLOINKY_TEST_SCRATCH: scratch,
            PLOINKY_TEST_CONTAINER: container ? '1' : '',
            [UPDATE_REPORT_NONCE_ENV]: nonce,
            [UPDATE_REPORT_CONTEXT_ENV]: JSON.stringify(context),
        };
        const script = String.raw`
            import fs from 'node:fs';
            import path from 'node:path';
            import { execFileSync } from 'node:child_process';
            // Simulated Box marker: the core runs as the in-Box writer.
            const originalStat = fs.statSync;
            fs.statSync = (target, options) => (target === '/etc/ploinky-box' ? { isFile: () => true, isDirectory: () => false } : originalStat(target, options));
            if (process.env.PLOINKY_TEST_CONTAINER === '1') {
                // The container marker that makes skill exclusions defer to the host.
                const originalExists = fs.existsSync;
                fs.existsSync = target => (target === '/.dockerenv' ? true : originalExists(target));
            }
            const scratch = process.env.PLOINKY_TEST_SCRATCH;
            const workspaceRoot = process.env.PLOINKY_WORKSPACE_ROOT;
            const git = (cwd, ...args) => String(execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim();
            function makeRemote(name, files) {
                const remote = path.join(scratch, 'remotes', name + '.git');
                const seed = path.join(scratch, 'remotes', name + '-seed');
                fs.mkdirSync(path.dirname(remote), { recursive: true });
                execFileSync('git', ['init', '-q', '--bare', remote]);
                fs.mkdirSync(seed, { recursive: true });
                git(seed, 'init', '-q', '-b', 'main');
                for (const [rel, content] of Object.entries(files)) {
                    fs.mkdirSync(path.dirname(path.join(seed, rel)), { recursive: true });
                    fs.writeFileSync(path.join(seed, rel), content);
                }
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
                fs.writeFileSync(path.join(seed, rel), content);
                git(seed, 'add', rel);
                git(seed, 'commit', '-q', '-m', 'advance');
                git(seed, 'push', '-q');
            }
            const { REPOS_DIR, PLOINKY_DIR } = await import(${JSON.stringify(moduleUrl('cli/utils/config.js'))});
            for (const name of ['AchillesCopilotBasicSkills', 'DocumentationSkills', 'PloinkySkills']) {
                const source = makeRemote(name, { ['skills/' + name + '-skill/SKILL.md']: '# ' + name + '\n' });
                clone(source.remote, path.join(REPOS_DIR, name));
            }
            const required = makeRemote('RequiredRepo', { 'demo/manifest.json': '{"container":"node:20-alpine"}', 'a.txt': 'a1\n' });
            const requiredPath = path.join(REPOS_DIR, 'RequiredRepo');
            clone(required.remote, requiredPath);
            fs.writeFileSync(path.join(PLOINKY_DIR, 'agents.json'), JSON.stringify({
                ploinky_required_demo: { type: 'agent', repoName: 'RequiredRepo', agentName: 'demo' },
            }));
            advance(required.seed, 'a.txt', 'a2\n');
            const scenario = ${JSON.stringify(setup)};
            if (scenario === 'dirty-required') fs.writeFileSync(path.join(requiredPath, 'a.txt'), 'local edit\n');
            if (scenario === 'optional-failure') {
                const optional = makeRemote('optional', { 'a.txt': 'a1\n' });
                const optionalPath = path.join(workspaceRoot, 'projects', 'optional');
                clone(optional.remote, optionalPath);
                advance(optional.seed, 'new.txt', 'upstream\n');
                fs.writeFileSync(path.join(optionalPath, 'new.txt'), 'local untracked\n');
            }
            const { launchCli } = await import(${JSON.stringify(moduleUrl('cli/index.js'))});
            const { handleCommand } = await import(${JSON.stringify(moduleUrl('cli/commands/cli.js'))});
            const code = await launchCli(['update', workspaceRoot], {
                env: process.env,
                // In the Box the host owns AgentLib; the core only validates it.
                bootstrapAgentLibImpl: async () => ({ owned: false, selection: null }),
                importCoreImpl: async () => ({ runCoreCli: (args, options) => handleCommand(args, options) }),
                spawnActivationImpl: () => { throw new Error('the in-Box core never activates AgentLib'); },
            });
            process.exitCode = code;
        `;
        const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
            cwd: workspaceRoot, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
        });
        // The host side: the exact reader call of executeCoreUpdate.
        const report = readUpdateReport(path.join(workspaceRoot, '.ploinky'), nonce, { expectedContext: context });
        return { status: child.status, stdout: child.stdout, stderr: child.stderr, report, nonce, workspaceRoot: fs.realpathSync(workspaceRoot) };
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
}

function summarize(run) {
    assert.equal(run.report.ok, true, `report accepted by the host reader: ${run.report.code || ''} ${run.report.reason || ''}\n${run.stderr}`);
    assert.equal(run.status, run.report.result.exitCode, 'the process exit equals the reported exit code (no exit-status-mismatch)');
    assert.equal(run.stdout.includes(run.nonce), false, 'the control report never appears on stdout');
    return {
        exitCode: run.report.result.exitCode,
        activationAllowed: run.report.result.activationAllowed,
        status: run.report.result.status,
        records: run.report.result.records.map(record => [record.phase, record.id, record.outcome, record.code, record.required]),
    };
}

test('host protocol: a clean in-Box update reports success the host accepts', () => {
    const result = summarize(runCore('clean'));
    assert.equal(result.exitCode, 0, JSON.stringify(result.records));
    assert.equal(result.activationAllowed, true);
    assert.equal(result.status, 'complete-with-skips');
    assert.deepEqual(result.records.find(record => record[1] === 'RequiredRepo'), ['registered-repository', 'RequiredRepo', 'changed', 'fast-forward', true]);
    assert.deepEqual(result.records.find(record => record[0] === 'agentlib'), ['agentlib', 'achillesAgentLib', 'deferred', 'owned-by-host', false]);
});

test('host protocol: a dirty required repository is a valid report with nonzero exit and activation blocked', () => {
    const result = summarize(runCore('dirty-required'));
    assert.equal(result.exitCode, 1);
    assert.equal(result.activationAllowed, false);
    assert.equal(result.status, 'failed');
    assert.deepEqual(result.records.find(record => record[1] === 'RequiredRepo'), ['registered-repository', 'RequiredRepo', 'skipped', 'dirty-worktree', true]);
});

test('host protocol: an optional failure is a valid report with nonzero exit that still allows activation', () => {
    const result = summarize(runCore('optional-failure'));
    assert.equal(result.exitCode, 1);
    assert.equal(result.activationAllowed, true);
    assert.equal(result.status, 'partial');
    const optional = result.records.find(record => record[0] === 'workspace-repository');
    assert.deepEqual(optional.slice(2), ['failed', 'untracked-would-be-overwritten', false]);
});

test('host protocol: exclusions deferred by a container run are listed in the published report', () => {
    const run = runCore('clean', { container: true });
    const result = summarize(run);
    assert.equal(result.exitCode, 0);
    const folders = run.report.result.deferredExclusionFolders;
    assert.ok(Array.isArray(folders), 'deferredExclusionFolders is a top-level report field');
    assert.ok(folders.some(folder => folder.endsWith(path.join('.ploinky', 'repos', 'RequiredRepo'))),
        `the default-skills target is listed: ${JSON.stringify(folders)}`);
    const exclusion = run.report.result.records.find(record => record.phase === 'default-skills'
        && record.details?.target === 'RequiredRepo')?.details?.exclusions;
    assert.equal(exclusion?.code, 'exclusions-executor-view-unverified');
});
