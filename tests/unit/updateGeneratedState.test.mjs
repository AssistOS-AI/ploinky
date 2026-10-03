import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Every verified Git update caller runs the P4 generated-state assessment
// before dirty classification: a `.gitignore` block without a matching write
// receipt is a named skip with its bytes untouched; a receipt-proven block is
// restored and the update proceeds.

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const moduleUrl = rel => pathToFileURL(path.join(projectRoot, rel)).href;

function runScenario(body) {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-update-generated-'));
    try {
        const workspaceRoot = path.join(scratch, 'workspace');
        fs.mkdirSync(path.join(workspaceRoot, '.ploinky'), { recursive: true });
        const globalConfig = path.join(scratch, 'gitconfig');
        fs.writeFileSync(globalConfig, '[user]\n\tname = Ploinky Test\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n');
        const env = {
            ...process.env,
            HOME: scratch,
            XDG_CONFIG_HOME: path.join(scratch, 'xdg'),
            GIT_CONFIG_GLOBAL: globalConfig,
            GIT_CONFIG_NOSYSTEM: '1',
            PLOINKY_WORKSPACE_ROOT: workspaceRoot,
            PLOINKY_ROOT: path.join(scratch, 'runtime-root'),
            PLOINKY_TEST_SCRATCH: scratch,
        };
        delete env.PLOINKY_SKILL_EXCLUDES_COMPOSE;
        delete env.GIT_CONFIG_SYSTEM;
        const script = String.raw`
            import crypto from 'node:crypto';
            import fs from 'node:fs';
            import path from 'node:path';
            import { execFileSync } from 'node:child_process';
            const scratch = process.env.PLOINKY_TEST_SCRATCH;
            const workspaceRoot = process.env.PLOINKY_WORKSPACE_ROOT;
            const git = (cwd, ...args) => String(execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim();
            const { REPOS_DIR } = await import(${JSON.stringify(moduleUrl('cli/utils/config.js'))});
            const repos = await import(${JSON.stringify(moduleUrl('cli/utils/repos.js'))});
            const { updatePloinkySelf } = await import(${JSON.stringify(moduleUrl('cli/commands/updateService.js'))});
            const exclusions = await import(${JSON.stringify(moduleUrl('cli/utils/skills/exportExclusions.mjs'))});
            const BASE = 'node_modules\n';
            const BLOCK = exclusions.IGNORE_MARKER_START + '\n.claude\n.agents/skills/demo/\n' + exclusions.IGNORE_MARKER_END + '\n';
            const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
            function checkout(name, destination) {
                const remote = path.join(scratch, name + '.git');
                const seed = path.join(scratch, name + '-seed');
                execFileSync('git', ['init', '-q', '--bare', remote]);
                fs.mkdirSync(seed, { recursive: true });
                git(seed, 'init', '-q', '-b', 'main');
                fs.writeFileSync(path.join(seed, '.gitignore'), BASE);
                fs.writeFileSync(path.join(seed, 'a.txt'), 'a1\n');
                git(seed, 'add', '.');
                git(seed, 'commit', '-q', '-m', 'initial');
                git(seed, 'remote', 'add', 'origin', remote);
                git(seed, 'push', '-q', '-u', 'origin', 'main');
                fs.mkdirSync(path.dirname(destination), { recursive: true });
                execFileSync('git', ['clone', '-q', remote, destination]);
                fs.writeFileSync(path.join(seed, 'a.txt'), 'a2\n');
                git(seed, 'commit', '-q', '-am', 'advance');
                git(seed, 'push', '-q');
                return git(seed, 'rev-parse', 'HEAD');
            }
            function unverified(repo) {
                fs.writeFileSync(path.join(repo, '.gitignore'), BASE + BLOCK);
            }
            function receiptProven(repo) {
                const current = BASE + BLOCK;
                fs.writeFileSync(path.join(repo, '.gitignore'), current);
                fs.mkdirSync(path.join(repo, '.agents'), { recursive: true });
                fs.writeFileSync(path.join(repo, exclusions.IGNORE_RECEIPT), JSON.stringify({
                    protocol: 'ploinky-skill-exclusions', path: '.gitignore', block: BLOCK,
                    after: sha256(current), before: sha256(BASE), beforeAbsent: false,
                }));
            }
            const state = repo => ({
                head: git(repo, 'rev-parse', 'HEAD'),
                ignore: fs.readFileSync(path.join(repo, '.gitignore'), 'utf8'),
                receipt: fs.existsSync(path.join(repo, exclusions.IGNORE_RECEIPT)),
            });
            const out = {};
            const lockManager = { async acquire() { return { assertHeld() {}, release() {} }; } };
            for (const [label, prepare] of [['unverified', unverified], ['receipt', receiptProven]]) {
                const registered = path.join(REPOS_DIR, 'Reg-' + label);
                const upstream = checkout('reg-' + label, registered);
                prepare(registered);
                const before = state(registered);
                const record = repos.updateRegisteredRepository('Reg-' + label);
                out['registered-' + label] = { outcome: record.outcome, code: record.code, before, after: state(registered), upstream,
                    restored: record.details.restoredGeneratedPaths || null };

                const workspaceRepo = path.join(workspaceRoot, 'ws-' + label);
                const wsUpstream = checkout('ws-' + label, workspaceRepo);
                prepare(workspaceRepo);
                const wsBefore = state(workspaceRepo);
                const wsRecord = repos.updateWorkspaceRepository(workspaceRepo);
                out['workspace-' + label] = { outcome: wsRecord.outcome, code: wsRecord.code, before: wsBefore, after: state(workspaceRepo), upstream: wsUpstream };

                const ploinky = path.join(scratch, 'ploinky-' + label);
                const ploinkyUpstream = checkout('ploinky-' + label, ploinky);
                prepare(ploinky);
                const pBefore = state(ploinky);
                let selfResult;
                try {
                    selfResult = await updatePloinkySelf({ repoPath: ploinky, sourceLockManager: lockManager, boxMarkerPath: path.join(scratch, 'no-box'), logger: { warn() {} } });
                } catch (error) {
                    selfResult = { error: error.message };
                }
                out['ploinky-' + label] = { outcome: selfResult.record?.outcome || null, code: selfResult.record?.code || selfResult.error,
                    before: pBefore, after: state(ploinky), upstream: ploinkyUpstream };
            }
            process.stdout.write('RESULT:' + JSON.stringify(out) + '\n');
        `;
        const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
            cwd: workspaceRoot, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        });
        return JSON.parse(output.split('\n').find(line => line.startsWith('RESULT:')).slice('RESULT:'.length));
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
}

test('registered, workspace and Ploinky writers all run the generated-state assessment before dirty classification', () => {
    const result = runScenario();
    for (const caller of ['registered', 'workspace', 'ploinky']) {
        const unverified = result[`${caller}-unverified`];
        assert.equal(unverified.outcome, 'skipped', caller);
        assert.equal(unverified.code, 'unverified-ignore-block-preserved', `${caller}: named skip from the assessor, not dirty-worktree`);
        assert.deepEqual(unverified.after, unverified.before, `${caller}: HEAD and .gitignore bytes untouched`);

        const receipt = result[`${caller}-receipt`];
        assert.equal(receipt.outcome, 'changed', `${caller}: a receipt-proven block is restored and the update proceeds`);
        assert.equal(receipt.after.head, receipt.upstream);
        assert.equal(receipt.after.ignore, 'node_modules\n', `${caller}: the committed .gitignore bytes are restored`);
        assert.equal(receipt.after.receipt, false, `${caller}: the consumed receipt is removed`);
    }
    assert.deepEqual(result['registered-receipt'].restored, ['.gitignore']);
});
