import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const candidateWorkflow = fs.readFileSync(
    new URL('../../.github/workflows/verify-ploinky-box-candidate.yml', import.meta.url),
    'utf8',
);
const releaseWorkflow = fs.readFileSync(
    new URL('../../.github/workflows/release.yml', import.meta.url),
    'utf8',
);

test('candidate artifact paths resolve on the runner before later steps consume them', (t) => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate paths '));
    t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
    const jobEnvironment = candidateWorkflow.match(/\n    env:\n([\s\S]*?)\n    steps:/)[1];
    assert.doesNotMatch(jobEnvironment, /\$\{\{\s*runner\./);
    const step = candidateWorkflow.match(/- name: Set candidate artifact paths\n[\s\S]*?run: \|\n([\s\S]*?)(?=\n      - name:)/)[1];
    const script = step.split('\n').map((line) => line.replace(/^ {10}/, '')).join('\n');
    for (const host of ['macos-podman-machine-arm64', 'native-linux-amd64']) {
        const environmentFile = path.join(folder, `${host}.env`);
        const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: {
            ...process.env, RUNNER_TEMP: folder, GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '2',
            CANDIDATE_HOST: host, GITHUB_ENV: environmentFile,
        } });
        assert.equal(result.status, 0, result.stderr);
        const values = Object.fromEntries(fs.readFileSync(environmentFile, 'utf8').trim().split('\n').map((line) => {
            const separator = line.indexOf('=');
            return [line.slice(0, separator), line.slice(separator + 1)];
        }));
        assert.deepEqual(values, {
            PLOINKY_BOX_EVIDENCE_DIR: `${folder}/ploinky-box-candidate-evidence/42-2/${host}`,
            PLOINKY_BOX_CANDIDATE_LOG_DIR: `${folder}/ploinky-box-candidate-logs/42-2/${host}`,
            SMOKE_GRAPH_EDGE_DESIRED_FILE: `${folder}/ploinky-box-smoke-desired-42-2-${host}.json`,
        });
    }
});

test('candidate workflow requires one digest and exact graph pins on both supported host forms', () => {
    assert.match(candidateWorkflow, /box_digest:\n\s+description:[^\n]+\n\s+required: true/);
    assert.match(candidateWorkflow,
        /smoke_graph_revisions_json:\n\s+description:[^\n]+\n\s+required: true/);
    assert.match(candidateWorkflow,
        /\["self-hosted","macOS","ARM64","ploinky-box-candidate"\]/);
    assert.match(candidateWorkflow,
        /\["self-hosted","Linux","X64","ploinky-box-candidate"\]/);
    assert.match(candidateWorkflow, /PLOINKY_BOX_REQUIRE_PODMAN: '1'/);
    assert.match(candidateWorkflow, /PLOINKY_BOX_CANDIDATE_DIGEST: \$\{\{ inputs\.box_digest \}\}/);
    assert.match(candidateWorkflow,
        /SMOKE_GRAPH_ARGS_JSON: '\["start","AchillesIDE\/explorer","19090"\]'/);
    assert.doesNotMatch(candidateWorkflow, /continue-on-error:/);
});

test('each candidate host runs native and packed CLI gates and retains exact evidence', () => {
    assert.match(candidateWorkflow,
        /node --test tests\/integration\/ploinkyBoxNative\.test\.mjs/);
    assert.match(candidateWorkflow,
        /node --test tests\/e2e\/ploinkyBox\/publicCli\.test\.mjs/);
    assert.match(candidateWorkflow, /Require both evidence records/);
    assert.match(candidateWorkflow, /native-stop-start-\*\.json/);
    assert.match(candidateWorkflow, /public-cli-stop-start-\*\.json/);
    assert.match(candidateWorkflow, /evidence\.outerContainer\?\.sameId !== true/);
    assert.match(candidateWorkflow, /evidence\.restart\?\.pullObserved/);
    assert.match(candidateWorkflow,
        /\/tmp:rw,exec,nosuid,nodev,mode=1777,notmpcopyup/);
    assert.match(candidateWorkflow,
        /\["rw","exec","nosuid","nodev","mode=1777","rprivate"\]/);
    assert.match(candidateWorkflow, /Object\.keys\(evidence\.verified\)\.length === 0/);
    assert.match(candidateWorkflow, /uses: actions\/upload-artifact@v4/);
    assert.match(candidateWorkflow, /if: always\(\)/);
    assert.match(candidateWorkflow, /if-no-files-found: error/);
});

test('package publication cannot run until the cross-platform candidate workflow succeeds', () => {
    assert.match(releaseWorkflow, /verify-box-candidate:[\s\S]*uses: \.\/\.github\/workflows\/verify-ploinky-box-candidate\.yml/);
    assert.match(releaseWorkflow, /release:\n\s+name: Build, tag, and publish\n\s+needs: verify-box-candidate/);
    for (const input of ['box_digest', 'smoke_graph_revisions_json']) {
        assert.match(releaseWorkflow, new RegExp(`${input}:\\n\\s+description:[^\\n]+\\n\\s+required: true`));
    }
    assert.doesNotMatch(releaseWorkflow, /smoke_graph_args_json/);
});
