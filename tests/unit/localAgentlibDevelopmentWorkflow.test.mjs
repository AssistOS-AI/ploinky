import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const workflow = fs.readFileSync(
    new URL('../../.github/workflows/verify-local-agentlib-dev-deployment.yml', import.meta.url),
    'utf8',
);

test('Ubuntu development deployment starts from an absent AgentLib checkout in local mode', () => {
    assert.match(workflow, /runs-on: ubuntu-24\.04/);
    assert.match(workflow, /timeout-minutes: 360/);
    assert.doesNotMatch(workflow, /PLOINKY_DEV_WORKSPACE: \$\{\{ runner\.temp \}\}/);
    assert.match(workflow, /submodules: false/);
    assert.match(workflow, /test ! -e "\$GITHUB_WORKSPACE\/node_modules\/achillesAgentLib\/package\.json"/);
    assert.doesNotMatch(workflow, /^\s+PLOINKY_PROD:/m);
    assert.doesNotMatch(workflow, /^\s+PLOINKY_AGENTLIB_REF:/m);
    assert.match(workflow, /unset PLOINKY_PROD PLOINKY_AGENTLIB_REF PLOINKY_WORKSPACE_ROOT PLOINKY_CWD/);
    assert.equal(workflow.match(/^\s+umask 0002$/gm)?.length, 3);
    assert.match(workflow, /test "\$\(stat -c '%a' "\$dev_workspace"\)" = 775/);
    assert.equal(workflow.match(/^\s+ploinky start explorer$/gm)?.length, 2);
});

test('Ubuntu development deployment proves readiness and local AgentLib propagation', () => {
    for (const requiredProof of [
        "test \"$(podman info --format '{{.Host.Security.Rootless}}')\" = true",
        'All ${running} background runtimes reached running state.',
        'Router: listening (127.0.0.1:8080)',
        'Exactly one Explorer runtime must be recorded',
        'Managed graph differs from the expected Explorer graph',
        "'AchillesIDE/workspaceMonitorAgent'",
        'Status has no unambiguous agent runtime section',
        '/^local:([a-f0-9]{64})$/',
        'independent pack of the cloned checkout',
        'npm pack',
        'achillesAgentLib-${archiveSha}.tgz',
        'Explorer has no installed AchillesAgentLib package',
        'Installed AgentLib file differs from the archive',
        'http://127.0.0.1:8080/',
        "record?.type === 'agent'",
        'PLOINKY_INITIAL_AGENTLIB_SHA',
        'PLOINKY_INITIAL_EXPLORER_CONTAINER_ID',
        'PLOINKY_EDIT_MARKER',
        'test "$edited_archive_sha" != "$PLOINKY_INITIAL_AGENTLIB_SHA"',
        'The second literal start did not replace the already-running Explorer container',
        'The exact uncommitted AgentLib edit did not reach the final Explorer dependency mount',
        "path.basename(bind.source) === 'node_modules'",
    ]) {
        assert.ok(workflow.includes(requiredProof), `workflow is missing proof: ${requiredProof}`);
    }

    for (const privateDirectory of [
        '.ploinky',
        '.ploinky/running',
        '.ploinky/running/no-wait',
        '.ploinky/logs',
        '.ploinky/logs/no-wait',
    ]) {
        assert.ok(workflow.includes(privateDirectory), `workflow does not verify ${privateDirectory}`);
    }
    assert.ok(workflow.includes(`test "$(stat -c '%a' .)" = 755`));
    assert.equal(workflow.match(/^\s+test "\$\(stat -c '%a' \.\)" = 755$/gm)?.length, 2);
    assert.match(workflow, /test "\$\(stat -c '%a' "\$private_dir"\)" = 700/);
    assert.equal(workflow.match(/^\s+test "\$\(stat -c '%a' "\$private_dir"\)" = 700$/gm)?.length, 2);
    assert.match(workflow, /const agentEntries = Object\.entries\(agents\)[\s\S]*record\?\.type === 'agent'/);

    const firstStart = workflow.indexOf('      - name: Start Explorer through the default development path');
    const firstProof = workflow.indexOf('      - name: Verify Explorer and local AgentLib provenance');
    const edit = workflow.indexOf('      - name: Make an uncommitted edit in the local AgentLib checkout');
    const secondStart = workflow.indexOf('      - name: Redeploy the edited AgentLib while Explorer is already running');
    const secondWait = workflow.indexOf('      - name: Wait for the redeployed background runtimes');
    const secondProof = workflow.indexOf('      - name: Verify the uncommitted edit reached the running Explorer graph');
    for (const [label, index] of Object.entries({ firstStart, firstProof, edit, secondStart, secondWait, secondProof })) {
        assert.ok(index >= 0, `workflow step is missing: ${label}`);
    }
    assert.ok(firstStart < firstProof
        && firstProof < edit
        && edit < secondStart
        && secondStart < secondWait
        && secondWait < secondProof);
    const redeployWaiter = workflow.slice(secondWait, secondProof);
    assert.match(redeployWaiter, /error\?\.code === 'ENOENT'/);
    assert.match(redeployWaiter, /pending\.push\(containerName\)/);
    assert.match(redeployWaiter, /const bounded = .*\.slice\(0, 500\)/);
    assert.match(redeployWaiter, /bounded\(status\.error\?\.message \|\| status\.phase\)/);

    const firstVerifier = workflow.slice(firstProof, edit);
    assert.match(firstVerifier, /\.filter\(\(\[, record\]\) => record\?\.type === 'agent'\)/);
    assert.match(firstVerifier, /PLOINKY_INITIAL_EXPLORER_CONTAINER_ID=/);
    assert.match(firstVerifier, /test "\$\(stat -c '%a' \.\)" = 755/);
    assert.match(firstVerifier, /test "\$\(stat -c '%a' "\$private_dir"\)" = 700/);

    const diagnostics = workflow.indexOf('      - name: Print bounded failure diagnostics');
    assert.ok(diagnostics > secondProof, 'bounded diagnostics must follow the second verifier');
    const secondVerifier = workflow.slice(secondProof, diagnostics);
    assert.match(secondVerifier, /\.filter\(\(\[, record\]\) => record\?\.type === 'agent'\)/);
    assert.match(secondVerifier, /agentEntries\.length === 18/);
    assert.match(secondVerifier, /const initialExplorerContainerId = String\(process\.argv\[6\]\)/);
    assert.match(secondVerifier, /const marker = String\(process\.argv\[7\]\)/);
    assert.match(secondVerifier, /finalExplorerContainerId !== initialExplorerContainerId/);
    assert.match(secondVerifier, /finalExplorerRecord\.config\?\.binds\?\.filter/);
    assert.match(secondVerifier, /bind\?\.ro === true/);
    assert.match(secondVerifier, /bind\.source === bind\.target/);
    assert.match(secondVerifier, /path\.relative\('\/workspace', mountedSource\)/);
    assert.match(secondVerifier, /!relativeMountedSource\.startsWith\('\.\.'\)/);
    assert.match(secondVerifier, /!path\.isAbsolute\(relativeMountedSource\)/);
    assert.match(secondVerifier, /fs\.readFileSync\(mountedIndex, 'utf8'\)\.includes\(markerLine\)/);
    assert.match(secondVerifier, /test "\$\(stat -c '%a' \.\)" = 755/);
    assert.match(secondVerifier, /test "\$\(stat -c '%a' "\$private_dir"\)" = 700/);
});

test('Ubuntu development deployment keeps diagnostics bounded and always cleans its exact workspace', () => {
    assert.doesNotMatch(workflow, /actions\/upload-artifact/);
    assert.match(workflow, /Print bounded failure diagnostics[\s\S]*\.slice\(0, 500\)/);
    assert.match(workflow, /if: always\(\)[\s\S]*cd "\$PLOINKY_DEV_WORKSPACE"[\s\S]*ploinky destroy --delete-cache/);
});
