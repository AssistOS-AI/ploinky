import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { __testHooks } from '../../cli/sandbox/docker/healthProbes.js';

const runner = fs.readFileSync(new URL('../../Agent/server/HealthProbeRunner.sh', import.meta.url), 'utf8');
const modeOffset = runner.indexOf('mode="${1:-}"');
assert.ok(modeOffset > 0, 'the broker definitions must precede mode dispatch');
const brokerDefinitions = runner.slice(0, modeOffset);

function resumePreviouslyInspectedRequest(controlPath, token) {
    // Resume the actual broker after its request existence checks, at the
    // claim operation. Missing requests exercise its real failure publisher.
    const script = `${brokerDefinitions}
control_path="$1"
token="$2"
if mkdir "$control_path/$PROBE_CLAIM_DIR" 2>/dev/null; then
    run_broker_request "$control_path" "$token"
    printf 'claimed'
else
    printf 'blocked'
fi
`;
    const child = spawnSync('sh', ['-c', script, 'stale-broker', controlPath, token], {
        encoding: 'utf8', timeout: 5000,
    });
    assert.equal(child.status, 0, child.stderr);
    return child.stdout;
}

function completedRequest(control, probe, grace) {
    __testHooks.submitProbeRequest(control, probe, grace);
    fs.mkdirSync(path.join(control.hostPath, 'claimed'));
    fs.writeFileSync(path.join(control.hostPath, 'probe-stdout'), 'ready\n');
    fs.writeFileSync(path.join(control.hostPath, 'result'), '0\n');
}

test('completed probe retirement prevents a pending broker claim from replacing success', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-retirement-race-'));
    const originalRm = fs.rmSync;
    let controlPath;
    let claim;
    let scannedNames;
    fs.rmSync = function (target, options) {
        if (target === controlPath) {
            // Force a valid ordering of the old recursive cleanup: claimed is
            // gone before the outer directory, allowing the pending claim.
            for (const entry of fs.readdirSync(target)) {
                originalRm(path.join(target, entry), { recursive: true, force: true });
            }
            claim = resumePreviouslyInspectedRequest(controlPath, 'completed');
            return fs.rmdirSync(target);
        }
        assert.equal(fs.existsSync(controlPath), false, 'old broker path must already be absent');
        assert.equal(fs.statSync(target).mode & 0o777, 0o700);
        assert.equal(fs.readFileSync(path.join(target, 'control/result'), 'utf8'), '0\n');
        const scan = spawnSync('sh', ['-c',
            'for item in "$1"/*; do [ -d "$item" ] || continue; printf "%s\\n" "${item##*/}"; done',
            'broker-scan', path.dirname(controlPath)], { encoding: 'utf8', timeout: 5000 });
        assert.equal(scan.status, 0, scan.stderr);
        scannedNames = scan.stdout;
        claim = resumePreviouslyInspectedRequest(controlPath, 'completed');
        return originalRm(target, options);
    };
    try {
        const result = __testHooks.runProbeOnce('fixture', 'container', { script: 'health.sh', timeout: 1 }, {
            probeControlHostRoot: root,
            tokenFactory: () => 'completed',
            submitProbeRequestImpl(control, probe, grace) {
                controlPath = control.hostPath;
                completedRequest(control, probe, grace);
            },
        });
        assert.equal(result.success, true);
        assert.equal(result.stdout, 'ready');
        assert.equal(claim, 'blocked');
        assert.equal(scannedNames, '', 'new broker scans must exclude retired requests');
        assert.deepEqual(fs.readdirSync(path.dirname(controlPath)), []);
    } finally {
        fs.rmSync = originalRm;
        originalRm(root, { recursive: true, force: true });
    }
});

test('unlinking a request alone does not revoke a previously inspected broker claim', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-unlink-race-'));
    const controlPath = path.join(root, 'completed');
    try {
        fs.mkdirSync(controlPath);
        completedRequest({ hostPath: controlPath, token: 'completed' }, { script: 'health.sh', timeout: 1 }, 1);
        assert.equal(fs.statSync(path.join(controlPath, 'request')).isFile(), true);
        fs.unlinkSync(path.join(controlPath, 'request'));
        fs.rmdirSync(path.join(controlPath, 'claimed'));
        assert.equal(resumePreviouslyInspectedRequest(controlPath, 'completed'), 'claimed');
        assert.equal(fs.readFileSync(path.join(controlPath, 'result'), 'utf8'), '125\n');
        assert.match(fs.readFileSync(path.join(controlPath, 'runner-stderr'), 'utf8'),
            /^ploinky health probe broker: request (?:is incomplete|has an invalid field count)\n$/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('failed atomic retirement preserves the original completed request and its error', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-retirement-failure-'));
    const originalRename = fs.renameSync;
    const renameError = Object.assign(new Error('retirement denied'), { code: 'EACCES' });
    let controlPath;
    fs.renameSync = function (source, destination) {
        if (source === controlPath) throw renameError;
        return originalRename(source, destination);
    };
    try {
        assert.throws(() => __testHooks.runProbeOnce('fixture', 'container', { script: 'health.sh', timeout: 1 }, {
            probeControlHostRoot: root,
            tokenFactory: () => 'completed',
            submitProbeRequestImpl(control, probe, grace) {
                controlPath = control.hostPath;
                completedRequest(control, probe, grace);
            },
        }), (error) => error === renameError);
        assert.deepEqual(fs.readdirSync(path.dirname(controlPath)), ['completed']);
        assert.equal(fs.readFileSync(path.join(controlPath, 'result'), 'utf8'), '0\n');
        assert.equal(fs.statSync(path.join(controlPath, 'claimed')).isDirectory(), true);
    } finally {
        fs.renameSync = originalRename;
        fs.rmSync(root, { recursive: true, force: true });
    }
});
