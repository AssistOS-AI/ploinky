import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const workflow = fs.readFileSync(
    new URL('../../.github/workflows/verify-local-agentlib-dev-deployment.yml', import.meta.url),
    'utf8',
);

test('Ubuntu development deployment starts from an absent AgentLib checkout in local mode', () => {
    assert.match(workflow, /runs-on: ubuntu-24\.04/);
    assert.match(workflow, /timeout-minutes: 240/);
    assert.doesNotMatch(workflow, /PLOINKY_DEV_WORKSPACE: \$\{\{ runner\.temp \}\}/);
    assert.match(workflow, /submodules: false/);
    assert.match(workflow, /test ! -e "\$GITHUB_WORKSPACE\/node_modules\/achillesAgentLib\/package\.json"/);
    assert.doesNotMatch(workflow, /^\s+PLOINKY_PROD:/m);
    assert.doesNotMatch(workflow, /^\s+PLOINKY_AGENTLIB_REF:/m);
    assert.match(workflow, /unset PLOINKY_PROD PLOINKY_AGENTLIB_REF PLOINKY_WORKSPACE_ROOT PLOINKY_CWD/);
    assert.match(workflow, /^\s+timeout --kill-after=30s 125m ploinky start explorer$/m);
});

test('Ubuntu development deployment proves readiness and local AgentLib propagation', () => {
    for (const requiredProof of [
        "test \"$(podman info --format '{{.Host.Security.Rootless}}')\" = true",
        'All ${running} background runtimes reached running state.',
        'Router: listening (127.0.0.1:8080)',
        'Exactly one Explorer runtime must be recorded',
        'Managed graph differs from the expected Explorer graph',
        'Status has no unambiguous agent runtime section',
        '/^local:([a-f0-9]{64})$/',
        'independent pack of the cloned checkout',
        'npm pack',
        'achillesAgentLib-${archiveSha}.tgz',
        'Explorer has no installed AchillesAgentLib package',
        'Installed AgentLib file differs from the archive',
        'http://127.0.0.1:8080/',
    ]) {
        assert.ok(workflow.includes(requiredProof), `workflow is missing proof: ${requiredProof}`);
    }
});

test('Ubuntu development deployment keeps diagnostics bounded and always cleans its exact workspace', () => {
    assert.doesNotMatch(workflow, /actions\/upload-artifact/);
    assert.match(workflow, /Print bounded failure diagnostics[\s\S]*\.slice\(0, 500\)/);
    assert.match(workflow, /if: always\(\)[\s\S]*cd "\$PLOINKY_DEV_WORKSPACE"[\s\S]*ploinky destroy --delete-cache/);
});
