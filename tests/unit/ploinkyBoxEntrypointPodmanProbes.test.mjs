import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// The notice Podman 5 prints on stderr for every command on a cgroup v1 host,
// in the logrus format it uses when stderr is not a terminal.
const CGROUPS_V1_WARNING = 'time="2026-11-03T09:14:07Z" level=warning msg="Using cgroups-v1 which is deprecated'
    + ' in favor of cgroups-v2 with Podman v5 and will be removed in a future version. Set environment variable'
    + ' `PODMAN_IGNORE_CGROUPSV1_WARNING` to hide this warning."\n';
const ROOTLESS_PROBE = 'podman info --format {{.Host.Security.Rootless}}';
const NETWORK_BACKEND_PROBE = 'podman info --format {{.Host.NetworkBackend}}';
const MANAGED_CONTAINERS_PROBE = 'podman ps --all --quiet --filter label=io.assistos.ploinky.managed=1';
const UID_MAPPING_PROBE = 'podman unshare cat /proc/self/uid_map';
const FULL_UID_MAPPING = '         0       1000          1\n         1     100000      65534\n';

// Each fake program answers one exact command line with an ordered sequence
// of stdout and stderr writes, so a test controls how the streams interleave.
const FAKE_PROGRAM = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const spec = JSON.parse(fs.readFileSync(process.env.FAKE_PROBE_SPEC, 'utf8'));
const key = [path.basename(process.argv[1]), ...process.argv.slice(2)].join(' ');
const response = spec[key];
if (!response) {
    fs.writeSync(2, 'unexpected probe: ' + key + '\\n');
    process.exit(127);
}
for (const [stream, text] of response.output) fs.writeSync(stream === 'stdout' ? 1 : 2, text);
process.exit(response.status);
`;

function entrypointSource() {
    const entrypoint = path.resolve(import.meta.dirname, '../../ploinky-box/entrypoint/ploinky-box-entrypoint');
    return fs.readFileSync(entrypoint, 'utf8');
}

function sourceText(source, pattern, label) {
    const match = source.match(pattern);
    assert.ok(match, `${label} is defined`);
    return match[0];
}

function functionText(source, name) {
    return sourceText(source, new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}\\n`, 'm'), name);
}

function constantText(source, name) {
    return sourceText(source, new RegExp(`^${name}=.*$`, 'm'), name);
}

function answer(stdout, { status = 0, warnings = 'interleaved' } = {}) {
    const output = {
        before: [['stderr', CGROUPS_V1_WARNING], ['stdout', stdout]],
        after: [['stdout', stdout], ['stderr', CGROUPS_V1_WARNING]],
        interleaved: [['stderr', CGROUPS_V1_WARNING], ['stdout', stdout], ['stderr', CGROUPS_V1_WARNING]],
    }[warnings];
    assert.ok(output, `known warning placement ${warnings}`);
    return { output, status };
}

/**
 * Runs the exact entrypoint functions under the entrypoint's shell options,
 * with fake `podman` and `pasta` programs first on PATH. `prelude` replaces
 * facts outside the Podman probe, such as host-owned subordinate ID files.
 */
function runProbe(t, { functions, call, responses, prelude = [] }) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-podman-probe-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'package.json'), '{ "type": "commonjs" }\n');
    for (const program of ['podman', 'pasta']) {
        fs.writeFileSync(path.join(bin, program), FAKE_PROGRAM, { mode: 0o755 });
    }
    const specPath = path.join(root, 'responses.json');
    fs.writeFileSync(specPath, JSON.stringify(responses));

    const source = entrypointSource();
    const script = [
        'set -euo pipefail',
        ...['MANAGED_LABEL', 'EXPECTED_SUBORDINATE_IDS', 'EXPECTED_MAPPED_IDS', 'MINIMUM_PODMAN_VERSION']
            .map((name) => constantText(source, name)),
        ...['fail', 'inner_podman_stdout', ...functions].map((name) => functionText(source, name)),
        ...prelude,
        call,
        'echo probe-ok',
    ].join('\n');
    return spawnSync('bash', ['-c', script], {
        env: {
            PATH: [bin, path.dirname(process.execPath), process.env.PATH].join(path.delimiter),
            FAKE_PROBE_SPEC: specPath,
        },
        encoding: 'utf8',
    });
}

function assertPassed(result) {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'probe-ok\n');
    assert.doesNotMatch(result.stderr, /SELF-CHECK FAILED/);
}

function assertSelfCheckFailure(result, message) {
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `[ploinky-box] SELF-CHECK FAILED: ${message}\n`);
}

function runRootlessProbe(t, response) {
    return runProbe(t, {
        functions: ['require_rootless_inner_podman'],
        call: 'require_rootless_inner_podman',
        responses: { [ROOTLESS_PROBE]: response },
    });
}

test('the rootless self-check detects rootless inner Podman behind cgroups-v1 warnings on stderr', (t) => {
    for (const warnings of ['before', 'after', 'interleaved']) {
        assertPassed(runRootlessProbe(t, answer('true\n', { warnings })));
    }
});

test('a genuine rootful or empty rootless answer still fails the self-check without warning text', (t) => {
    assertSelfCheckFailure(runRootlessProbe(t, answer('false\n')), 'inner Podman must be rootless (observed false)');
    assertSelfCheckFailure(runRootlessProbe(t, answer('')), 'inner Podman must be rootless (observed unknown)');
    // Stdout must be exactly `true`; a final line of `true` is not enough.
    assertSelfCheckFailure(
        runRootlessProbe(t, answer('false\ntrue\n')),
        'inner Podman must be rootless (observed false\ntrue)',
    );
});

test('a failing rootless probe keeps Podman\'s own stderr diagnostic', (t) => {
    const error = 'Error: cannot set up namespace using "/usr/bin/newuidmap": exit status 1\n';
    const result = runRootlessProbe(t, {
        output: [['stderr', CGROUPS_V1_WARNING], ['stderr', error]],
        status: 125,
    });
    assertSelfCheckFailure(
        result,
        `cannot inspect inner Podman rootless state: ${CGROUPS_V1_WARNING}${error.trimEnd()}`,
    );
});

test('the network backend self-check compares only stdout behind cgroups-v1 warnings', (t) => {
    const run = (backend) => runProbe(t, {
        functions: ['require_managed_network_stack'],
        call: 'require_managed_network_stack',
        responses: {
            'podman --version': answer('podman version 5.8.9\n', { warnings: 'before' }),
            [NETWORK_BACKEND_PROBE]: answer(backend),
            'pasta --version': { output: [['stdout', 'pasta 2025_01_21.4f2c8e7\n']], status: 0 },
        },
    });
    assertPassed(run('netavark\n'));
    assertSelfCheckFailure(run('cni\n'), 'inner Podman network backend must be netavark (observed cni)');
});

test('the retained-container self-check ignores cgroups-v1 warnings and still rejects a real record', (t) => {
    const run = (stdout) => runProbe(t, {
        functions: ['reject_retained_managed_containers'],
        call: 'reject_retained_managed_containers',
        responses: { [MANAGED_CONTAINERS_PROBE]: answer(stdout) },
    });
    assertPassed(run(''));
    const retained = run('3f1c2a9e8b7d\n');
    assert.notEqual(retained.status, 0);
    assert.match(
        retained.stderr,
        /^\[ploinky-box\] SELF-CHECK FAILED: retained Ploinky-managed nested containers were found;/,
    );
});

test('the identity-mapping self-check sums only mapping rows behind cgroups-v1 warnings', (t) => {
    const run = (mapping) => runProbe(t, {
        functions: ['mapped_id_count', 'require_full_mapping'],
        // The subordinate ID file is host-owned; this test covers the Podman probe.
        prelude: ['configured_subid_count() { echo "$EXPECTED_SUBORDINATE_IDS"; }'],
        call: 'require_full_mapping uid',
        responses: { [UID_MAPPING_PROBE]: answer(mapping) },
    });
    assertPassed(run(FULL_UID_MAPPING));
    assertSelfCheckFailure(
        run('         0       1000          1\n         1     100000      65533\n'),
        'Podman UID mapping must contain exactly 65535 IDs (observed 65534)',
    );
});

test('no entrypoint self-check captures inner Podman stderr into an observed value', () => {
    const source = entrypointSource();
    // The helper alone captures stderr, and only to append it on failure.
    const probes = source.replace(functionText(source, 'inner_podman_stdout'), '');
    assert.match(functionText(source, 'inner_podman_stdout'), /2>&1 1>&3 3>&-/);
    assert.doesNotMatch(probes, /\$\(podman\b[^)]*2>&1/);
    const rootlessCheck = source.indexOf('\nrequire_rootless_inner_podman\n');
    assert.ok(rootlessCheck > 0 && rootlessCheck < source.indexOf('\nrequire_managed_network_stack\n'));
});
