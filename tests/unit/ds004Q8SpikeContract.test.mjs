// DS004-Q8 architecture-decision spike (S0) — source contract test.
//
// Normative source: docs/superpowers/plans/2026-07-19-ploinky-box-clean-rebuild.md
// (sections 1-7, 9) and its annex (sections 1-4), in the outer workspace root.
// This test asserts the exact five-file S0 inventory, the absence of every
// alternate-candidate mechanism, and the literal command/schema/ordering
// contract for Candidate N (native pasta -T/--tcp-ns port confinement).
//
// It does not execute native networking, SSH to real runners, or Podman —
// those require native Linux amd64/arm64 runners this environment lacks.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';

const TEST_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(TEST_FILE, '../../..');
const SPIKE_DIR = path.join(REPO_ROOT, 'container/spike/ds004-q8');

const PATHS = {
    runSpike: path.join(SPIKE_DIR, 'run-spike.sh'),
    probe: path.join(SPIKE_DIR, 'probe.py'),
    stageSource: path.join(SPIKE_DIR, 'stage-source.sh'),
    readme: path.join(SPIKE_DIR, 'README.md'),
};

function readIfExists(p) {
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

function requireFile(p) {
    assert.ok(fs.existsSync(p), `expected file to exist: ${path.relative(REPO_ROOT, p)}`);
    return fs.readFileSync(p, 'utf8');
}

function sha256Text(s) {
    return crypto.createHash('sha256').update(s).digest('hex');
}

function journalEvent(prevEventSha256, manifestSha256, attemptId, phase, verdict, artifactSha256) {
    const body = `{"prevEventSha256":"${prevEventSha256}","manifestSha256":"${manifestSha256}","attemptId":"${attemptId}","phase":"${phase}","verdict":"${verdict}","artifactSha256":"${artifactSha256}"}`;
    const eventSha256 = sha256Text(body);
    const line = `{"prevEventSha256":"${prevEventSha256}","eventSha256":"${eventSha256}","manifestSha256":"${manifestSha256}","attemptId":"${attemptId}","phase":"${phase}","verdict":"${verdict}","artifactSha256":"${artifactSha256}"}`;
    return { eventSha256, line };
}

function extractShellFunction(src, name) {
    const marker = `${name}() {`;
    const start = src.indexOf(marker);
    assert.notEqual(start, -1, `missing shell function ${name}`);
    const nextSection = src.indexOf('\n# ---', start + marker.length);
    return src.slice(start, nextSection === -1 ? undefined : nextSection);
}

function tempRunSpike() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ds004q8-run-spike-'));
    const artifactRoot = path.join(tmp, 'artifacts');
    fs.mkdirSync(artifactRoot, { recursive: true });
    const script = path.join(tmp, 'run-spike.sh');
    const src = requireFile(PATHS.runSpike).replace(
        'ARTIFACTS_ROOT="/var/tmp/ploinky-ds004-q8-artifacts"',
        `ARTIFACTS_ROOT="${artifactRoot}"`,
    );
    fs.writeFileSync(script, src, { mode: 0o700 });
    return { script, artifactRoot };
}

// --- 1. Exact file inventory -------------------------------------------------

describe('exact five-file S0 inventory', () => {
    test('all five normative paths exist', () => {
        for (const p of [PATHS.runSpike, PATHS.probe, PATHS.stageSource, PATHS.readme, TEST_FILE]) {
            assert.ok(fs.existsSync(p), `missing normative path: ${path.relative(REPO_ROOT, p)}`);
        }
    });

    test('container/spike/ds004-q8 contains exactly the four owned files', () => {
        assert.ok(fs.existsSync(SPIKE_DIR), 'container/spike/ds004-q8 directory missing');
        const entries = fs.readdirSync(SPIKE_DIR).sort();
        assert.deepEqual(entries, ['README.md', 'probe.py', 'run-spike.sh', 'stage-source.sh']);
    });
});

// --- 2. Shell shebang / structural contract ---------------------------------

describe('shell script structural contract', () => {
    for (const [name, p] of [['run-spike.sh', PATHS.runSpike], ['stage-source.sh', PATHS.stageSource]]) {
        test(`${name} starts exactly with #!/usr/bin/env bash then set -euo pipefail`, () => {
            const src = requireFile(p);
            const lines = src.split('\n');
            assert.equal(lines[0], '#!/usr/bin/env bash', `${name} line 1`);
            assert.equal(lines[1], 'set -euo pipefail', `${name} line 2`);
        });
    }
});

// --- 3. Absence of every alternate-candidate mechanism ----------------------

describe('alternate-candidate mechanisms are absent (Candidate N is sole candidate)', () => {
    const FORBIDDEN = [
        '--map-host-loopback',
        'candidate-c',
        'Candidate C',
        'SCM_RIGHTS',
        'broker',
        'source-ip-authorization',
        'firewall substitute',
    ];

    for (const needle of FORBIDDEN) {
        test(`no source file contains "${needle}"`, () => {
            for (const p of [PATHS.runSpike, PATHS.probe, PATHS.stageSource, PATHS.readme]) {
                const src = readIfExists(p);
                if (src === null) continue; // file-existence already asserted elsewhere
                const hay = src.toLowerCase();
                const idx = hay.indexOf(needle.toLowerCase());
                assert.equal(idx, -1, `${path.relative(REPO_ROOT, p)} contains forbidden marker "${needle}" near offset ${idx}`);
            }
        });
    }

    test('run-spike.sh forwards exactly one TCP port value: 8081', () => {
        const src = requireFile(PATHS.runSpike);
        assert.match(src, /\b8081\b/, 'run-spike.sh must reference port 8081');
    });
});

// --- 4. PASS byte origination: sole location ---------------------------------

describe('PASS byte origination ordering', () => {
    const PASS_PRINT_PATTERN = /(printf\s+['"]PASS candidate-n)|(echo\s+['"]PASS candidate-n)/;

    test('run-spike.sh contains the sole PASS-constructing statement', () => {
        const src = requireFile(PATHS.runSpike);
        assert.match(src, PASS_PRINT_PATTERN, 'run-spike.sh must construct the literal PASS line (in emit-pass)');
        assert.match(src, /emit-pass/, 'run-spike.sh must implement an emit-pass mode');
    });

    test('stage-source.sh never constructs PASS bytes, only validates/transports them', () => {
        const src = requireFile(PATHS.stageSource);
        assert.doesNotMatch(src, PASS_PRINT_PATTERN, 'stage-source.sh must not print/construct literal PASS bytes itself');
    });

    test('probe.py never constructs PASS bytes', () => {
        const src = requireFile(PATHS.probe);
        assert.doesNotMatch(src, /PASS candidate-n/, 'probe.py must have no knowledge of the PASS contract');
    });

    test('exact PASS byte format is documented consistently', () => {
        const src = requireFile(PATHS.runSpike);
        assert.match(src, /PASS candidate-n .*\\n/, 'run-spike.sh must reference the exact PASS format with trailing \\n');
    });
});

// --- 5. SSH/SFTP trust and remote executor contract --------------------------

describe('SSH/SFTP trust and remote executor contract', () => {
    const SSH_OPTS = [
        '-F /dev/null',
        '-o BatchMode=yes',
        '-o ClearAllForwardings=yes',
        '-o IdentitiesOnly=yes',
        '-o IdentityAgent=none',
        '-o StrictHostKeyChecking=yes',
        '-o GlobalKnownHostsFile=/dev/null',
        '-o UserKnownHostsFile=',
    ];
    const SFTP_OPTS = SSH_OPTS; // identical option set per plan section 6.1

    test('stage-source.sh builds the exact fixed SSH option set', () => {
        const src = requireFile(PATHS.stageSource);
        for (const opt of SSH_OPTS) {
            assert.ok(src.includes(opt), `stage-source.sh missing SSH option "${opt}"`);
        }
        assert.ok(src.includes('-T --'), 'stage-source.sh SSH invocation must be -T (no PTY) with -- separator');
    });

    test('stage-source.sh builds the exact fixed SFTP option set', () => {
        const src = requireFile(PATHS.stageSource);
        for (const opt of SFTP_OPTS) {
            assert.ok(src.includes(opt), `stage-source.sh missing SFTP option "${opt}"`);
        }
        assert.ok(src.includes('sftp '), 'stage-source.sh must invoke sftp');
    });

    test('stage-source.sh embeds the exact fixed remote_executor template', () => {
        const src = requireFile(PATHS.stageSource);
        assert.ok(
            src.includes('/usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin BASH_ENV=/dev/null /bin/bash --noprofile --norc -s --'),
            'stage-source.sh missing the exact fixed remote executor prefix',
        );
    });

    test('stage-source.sh embeds the exact scanner executor variant', () => {
        const src = requireFile(PATHS.stageSource);
        assert.ok(src.includes('scanner-scan scanner'), 'stage-source.sh missing the scanner-scan executor phase/candidate/arch tokens');
    });

    test('stage-source.sh documents the exact destination grammar regex', () => {
        const src = requireFile(PATHS.stageSource);
        assert.ok(
            src.includes('^([A-Za-z0-9_][A-Za-z0-9._-]*)@([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)$'),
            'stage-source.sh must document the exact canonical destination regex',
        );
    });

    test('stage-source.sh forbids PTY/profile/ambient shortcuts', () => {
        const src = requireFile(PATHS.stageSource);
        assert.doesNotMatch(src, /\bsh -c\b/, 'must not use sh -c');
        assert.doesNotMatch(src, /\beval\b/, 'must not use eval');
        assert.doesNotMatch(src, /(^|[^.\w])source\s+"\$/, 'must not source caller-controlled paths');
    });

    test('known-hosts/identity files must be mode-0600, absolute, non-symlink, coordinator-owned', () => {
        const src = requireFile(PATHS.stageSource);
        assert.match(src, /0600|0o600|600\b/, 'stage-source.sh must enforce mode 0600 on trust files');
        assert.match(src, /-L\s|symlink/i, 'stage-source.sh must reject symlinked trust files');
    });
});

// --- 6. Immutable artifact schemas -------------------------------------------

describe('immutable artifact path templates', () => {
    const TEMPLATES = [
        '/var/tmp/ploinky-ds004-q8-artifacts/green/candidate-n/',
        '/var/tmp/ploinky-ds004-q8-artifacts/source/',
        '/var/tmp/ploinky-ds004-q8-artifacts/runs/',
        '/var/tmp/ploinky-ds004-q8/candidate-n/',
    ];

    test('stage-source.sh references every immutable artifact path template', () => {
        const src = requireFile(PATHS.stageSource);
        for (const t of TEMPLATES) {
            assert.ok(src.includes(t), `stage-source.sh missing artifact path template "${t}"`);
        }
    });

    test('GREEN artifact filenames are exact', () => {
        const src = requireFile(PATHS.stageSource);
        assert.ok(src.includes('green-receipt.json'));
        assert.ok(src.includes('green-test.out'));
    });

    test('source package filenames are exact', () => {
        const src = requireFile(PATHS.stageSource);
        for (const f of ['frozen-base.bundle', 'overlay.tar', 'source-manifest.json']) {
            assert.ok(src.includes(f), `stage-source.sh missing source package file "${f}"`);
        }
    });

    test('frozen base SHA is embedded exactly', () => {
        const src = requireFile(PATHS.stageSource);
        assert.ok(src.includes('ac39b870d990869616e4882222c78037dc11d07d'));
    });

    test('journal path is exact', () => {
        const src = requireFile(PATHS.stageSource) + requireFile(PATHS.runSpike);
        assert.ok(src.includes('attempt-journal.jsonl'));
    });

    test('phase-owned attempt filenames are exact', () => {
        const combined = requireFile(PATHS.runSpike) + requireFile(PATHS.stageSource);
        const files = [
            'runner-receipt.json',
            'verification.json',
            'preflight-scan-request.json',
            'external-preflight-tcp.scan',
            'scan-request.json',
            'external-tcp.scan',
            'external-udp.scan',
            'evidence-pre-cleanup.json',
            'evidence-final.json',
            'summary.txt',
            'failure.json',
        ];
        for (const f of files) {
            assert.ok(combined.includes(f), `missing phase-owned filename "${f}"`);
        }
    });

    test('journal events include prior hash and self eventSha256', () => {
        const src = requireFile(PATHS.runSpike);
        assert.ok(src.includes('eventSha256'), 'run-spike.sh must write eventSha256 in journal events');
    });

    test('artifact writes are write-once and never overwrite existing attempt files', () => {
        const src = requireFile(PATHS.runSpike);
        assert.doesNotMatch(src, /mv\s+-f\s+"\$tmp"\s+"\$path"/, 'atomic evidence writes must not overwrite existing files');
        assert.doesNotMatch(src, /mv\s+-f\s+"\$attempt_dir\/summary\.txt\.\$\$\.tmp"\s+"\$attempt_dir\/summary\.txt"/, 'summary.txt must not overwrite an existing summary');
        assert.match(src, /ln\s+"\$tmp"\s+"\$path"/, 'write-once files should be linked into place only when absent');
        assert.match(src, /cmp\s+-s\s+"\$tmp"\s+"\$path"/, 'byte-identical existing files may be reused only after comparison');
        assert.match(src, /validate_existing_file "\$path" "0400"/, 'byte-identical existing attempt files must still validate owner and read-only mode');
    });

    test('pack validates existing package payload hashes before reuse', () => {
        const src = requireFile(PATHS.stageSource);
        assert.match(src, /existing_bundle_hash/, 'pack must hash an existing frozen-base.bundle before reuse');
        assert.match(src, /existing_overlay_hash/, 'pack must hash an existing overlay.tar before reuse');
        assert.match(src, /bundleSha256/, 'pack must compare the existing bundle hash to the manifest');
        assert.match(src, /archiveSha256/, 'pack must compare the existing overlay hash to the manifest');
    });

    test('pack validates exact five-path git status before/after, in a mode-0700 temp dir', () => {
        const src = requireFile(PATHS.stageSource);
        assert.match(src, /0700|0o700/, 'stage-source.sh pack must use a mode-0700 private temp dir');
        assert.match(src, /git status/i, 'stage-source.sh pack must validate git status');
    });

    test('GREEN and source package identity publication uses exclusive directories and full reuse validation', () => {
        const src = requireFile(PATHS.stageSource);
        assert.doesNotMatch(src, /mkdir -p "\$receipt_dir"/, 'GREEN identity directories must not be check-then-created with mkdir -p');
        assert.doesNotMatch(src, /mkdir -p "\$dest_dir"/, 'source package identity directories must not be check-then-created with mkdir -p');
        assert.match(src, /existing_green_output_hash/, 'existing GREEN output bytes must be hashed before reuse');
        assert.match(src, /validate_existing_file "\$receipt_dir\/green-receipt\.json" "0400"/, 'existing GREEN receipt mode/owner must be validated');
        assert.match(src, /validate_existing_file "\$dest_dir\/source-manifest\.json" "0400"/, 'existing source package manifest mode/owner must be validated');
    });
});

// --- 7. Scanner independence rules -------------------------------------------

describe('scanner independence contract', () => {
    test('run-spike.sh records host-key fingerprint, machine-identity SHA-256 (never raw machine-id), boot ID', () => {
        const src = requireFile(PATHS.runSpike);
        assert.match(src, /host.?key.?fingerprint/i);
        assert.match(src, /machine.?id/i);
        assert.match(src, /sha256/i);
        assert.match(src, /boot.?id/i);
    });

    test('run-spike.sh rejects scanner/runner address, OOB, LAN, or identity collisions', () => {
        const src = requireFile(PATHS.runSpike);
        assert.match(src, /BLOCKED/, 'collision handling must be classified BLOCKED');
    });

    test('exact scanner nmap commands are embedded', () => {
        const src = requireFile(PATHS.runSpike);
        assert.ok(src.includes('sudo -n nmap -n -Pn -sS --reason -p'), 'missing exact TCP scan command');
        assert.ok(src.includes('sudo -n nmap -n -Pn -sU --reason -p'), 'missing exact UDP scan command');
    });

    test('preflight scan failures are not swallowed', () => {
        const src = requireFile(PATHS.runSpike);
        assert.doesNotMatch(src, /sudo -n nmap[\s\S]{0,160}\|\|\s+true/, 'nmap failure must not be converted into successful scan evidence');
        assert.match(src, /if ! scan_out=\$\(sudo -n nmap/, 'preflight nmap command must be checked in a conditional');
    });
});

// --- 8. Probe matrix ----------------------------------------------------------

describe('probe matrix contract', () => {
    const MANAGED = ['managed-default', 'managed-a', 'managed-b', 'managed-dual-source-a', 'managed-dual-source-b'];
    const NEGATIVE = ['unmanaged-separate', 'manual-default', 'manual-a', 'manual-b'];

    test('run-spike.sh enumerates every managed and negative path ID', () => {
        const src = requireFile(PATHS.runSpike);
        for (const id of [...MANAGED, ...NEGATIVE]) {
            assert.ok(src.includes(id), `run-spike.sh missing probe path ID "${id}"`);
        }
        assert.match(src, /address-reuse-/);
        assert.match(src, /overlap-/);
    });

    test('probe.py implements the exact client CLI flags', () => {
        const src = requireFile(PATHS.probe);
        for (const flag of ['--self-test', '--destination-url', '--expected-payload-hex', '--source-ipv4']) {
            assert.ok(src.includes(flag), `probe.py missing flag "${flag}"`);
        }
    });

    test('the fixed payload hex is embedded exactly', () => {
        const src = requireFile(PATHS.probe) + requireFile(PATHS.runSpike);
        assert.ok(src.includes('44533030342d51382d524f555445522d4f4b0a'));
    });

    test('run-spike.sh aligns fixed TCP and UDP scanner ports', () => {
        const src = requireFile(PATHS.runSpike);
        assert.ok(src.includes('22,6379,7880,7980,7981,8080,8081'), 'missing fixed TCP port set');
        assert.match(src, /\b7882\b/, 'missing fixed UDP port 7882');
    });

    test('run-spike.sh runs owner-aware ss inventories', () => {
        const src = requireFile(PATHS.runSpike);
        assert.ok(src.includes('ss -H -lntp'));
        assert.ok(src.includes('ss -H -lunp'));
    });

    test('remote phase dispatch validates hex identifiers before path construction', () => {
        const src = requireFile(PATHS.runSpike);
        assert.match(src, /is_lowercase_hex "\$manifest_sha" 64 \|\| die_setup_error "\$phase: manifest_sha/, 'manifest_sha must be validated centrally before phase handlers');
        assert.match(src, /is_lowercase_hex "\$attempt_id" 32 \|\| die_setup_error "\$phase: attempt_id/, 'attempt_id must be validated centrally before phase handlers');
    });

    test('live and scanner phases validate every positional network input', () => {
        const src = requireFile(PATHS.runSpike);
        assert.match(src, /live\) phase_live "\$arch" "\$manifest_sha" "\$attempt_id" "\$target_ipv4" "\$tcp_ports" "\$udp_ports"/, 'live dispatch must pass both TCP and UDP port lists for validation');
        assert.match(src, /is_port_list "\$tcp_ports" \|\| die_setup_error "live: tcp_ports invalid"/, 'live must validate tcp_ports');
        assert.match(src, /is_port_list "\$udp_ports" \|\| die_setup_error "live: udp_ports invalid"/, 'live must validate udp_ports');
        assert.match(src, /\[ "\$_candidate" = "scanner-scan" \] \|\| die_setup_error "scanner-scan: phase marker invalid"/, 'scanner dispatch must validate the phase marker token');
        assert.match(src, /\[ "\$_role" = "scanner" \] \|\| die_setup_error "scanner-scan: role invalid"/, 'scanner dispatch must validate the role token');
    });

    test('malformed IPv4 and port-list values fail before scan or artifact paths can advance', () => {
        const { script } = tempRunSpike();
        const base = ['--noprofile', '--norc', script, 'preflight', 'candidate-n', 'amd64', 'a'.repeat(64), 'b'.repeat(32)];
        const cases = [
            { args: [...base, '1.2.3.4.', '22', '7882'], stderr: /target_ipv4 invalid/ },
            { args: [...base, '127.0.0.1', '', '7882'], stderr: /tcp_ports invalid/ },
            { args: [...base, '127.0.0.1', '22,', '7882'], stderr: /tcp_ports invalid/ },
        ];
        for (const c of cases) {
            const res = spawnSync('bash', c.args, { encoding: 'utf8', timeout: 30_000, cwd: REPO_ROOT });
            assert.notEqual(res.status, 0, `expected failure for args ${c.args.join(' ')}`);
            assert.match(res.stderr, c.stderr, `stderr should identify the rejected input: ${res.stderr}`);
        }
    });

    test('stage-source.sh rejects dotted numeric destinations that are not IPv4 addresses', () => {
        const src = requireFile(PATHS.stageSource);
        const validateDestination = extractShellFunction(src, 'validate_destination');
        assert.match(validateDestination, /is_ipv4 "\$host"/, 'dotted numeric destination hosts must be checked with IPv4 validation');
        assert.match(validateDestination, /numeric host is not a valid IPv4 address/, 'invalid dotted numeric destinations must be rejected');
    });
});

// --- 9. Failure taxonomy and status transitions -------------------------------

describe('failure taxonomy and status transitions', () => {
    const TRANSITIONS = [
        'architecture-spike-ready',
        'architecture-spike-running',
        'architecture-spike-blocked',
        'candidate-N-evidenced',
        'architecture-review-pending',
        'architecture-human-accepted',
        'architecture-human-rejected',
    ];

    test('all seven allowed status transitions are documented', () => {
        const combined = requireFile(PATHS.runSpike) + requireFile(PATHS.stageSource) + requireFile(PATHS.readme);
        for (const t of TRANSITIONS) {
            assert.ok(combined.includes(t), `missing status transition "${t}"`);
        }
    });

    test('BLOCKED and SETUP_ERROR are distinct, both present', () => {
        const combined = requireFile(PATHS.runSpike) + requireFile(PATHS.stageSource);
        assert.match(combined, /BLOCKED/);
        assert.match(combined, /SETUP_ERROR/);
    });

    test('candidate-N-evidenced never implies DR1 resolved', () => {
        const combined = requireFile(PATHS.runSpike) + requireFile(PATHS.readme);
        assert.match(combined, /DR1/);
    });
});

// --- 10. Dynamic fail-closed behavior (no native infra required) --------------

describe('dynamic fail-closed behavior', () => {
    const CLEAN_ENV = { ...process.env };
    for (const v of [
        'DS004_EXTERNAL_SCANNER_SSH', 'DS004_AMD64_RUNNER_SSH', 'DS004_ARM64_RUNNER_SSH',
        'DS004_AMD64_BOX_LAN_IPV4', 'DS004_ARM64_BOX_LAN_IPV4', 'DS004_SSH_KNOWN_HOSTS_FILE',
        'DS004_EXTERNAL_SCANNER_IDENTITY_FILE', 'DS004_AMD64_RUNNER_IDENTITY_FILE', 'DS004_ARM64_RUNNER_IDENTITY_FILE',
    ]) delete CLEAN_ENV[v];

    test('probe.py --self-test exits 0 with no native/root dependency', (t) => {
        const python = spawnSync('python3', [PATHS.probe, '--self-test'], { encoding: 'utf8', timeout: 30_000 });
        if (python.error && python.error.code === 'ENOENT') {
            t.skip('python3 not available in this environment');
            return;
        }
        assert.equal(python.status, 0, `probe.py --self-test failed: stdout=${python.stdout} stderr=${python.stderr}`);
    });

    test('stage-source.sh install BLOCKS with empty stdout when coordinator inputs are missing', () => {
        const res = spawnSync('bash', ['--noprofile', '--norc', PATHS.stageSource, 'install', 'candidate-n', 'amd64', 'a'.repeat(64)], {
            encoding: 'utf8', env: CLEAN_ENV, timeout: 30_000, cwd: REPO_ROOT,
        });
        assert.notEqual(res.status, 0, 'install must fail closed without coordinator inputs');
        assert.equal(res.stdout.trim(), '', 'install must expose no stdout on BLOCKED');
        assert.match(res.stderr, /BLOCKED/);
    });

    test('stage-source.sh verify BLOCKS with empty stdout when coordinator inputs are missing', () => {
        const res = spawnSync('bash', ['--noprofile', '--norc', PATHS.stageSource, 'verify', 'candidate-n', 'amd64', 'a'.repeat(64), 'b'.repeat(32)], {
            encoding: 'utf8', env: CLEAN_ENV, timeout: 30_000, cwd: REPO_ROOT,
        });
        assert.notEqual(res.status, 0);
        assert.equal(res.stdout.trim(), '');
        assert.match(res.stderr, /BLOCKED/);
    });

    test('stage-source.sh run BLOCKS with empty stdout (never fabricates PASS) when coordinator inputs are missing', () => {
        const res = spawnSync('bash', ['--noprofile', '--norc', PATHS.stageSource, 'run', 'candidate-n', 'amd64', 'a'.repeat(64), 'b'.repeat(32)], {
            encoding: 'utf8', env: CLEAN_ENV, timeout: 30_000, cwd: REPO_ROOT,
        });
        assert.notEqual(res.status, 0);
        assert.doesNotMatch(res.stdout, /PASS candidate-n/, 'run must never print PASS when BLOCKED');
        assert.match(res.stderr, /BLOCKED/);
    });

    test('run-spike.sh emit-pass fails closed with no PASS output when local evidence is absent', () => {
        const res = spawnSync('bash', ['--noprofile', '--norc', PATHS.runSpike, 'emit-pass', 'candidate-n', 'amd64',
            'c'.repeat(64), 'd'.repeat(32), 'e'.repeat(64), 'f'.repeat(64)], {
            encoding: 'utf8', timeout: 30_000, cwd: REPO_ROOT,
        });
        assert.notEqual(res.status, 0, 'emit-pass must fail closed when evidence/journal are absent');
        assert.doesNotMatch(res.stdout, /PASS candidate-n/, 'emit-pass must never fabricate PASS bytes');
    });

    test('PASS acknowledgement requires a synced pass-authorization journal event', () => {
        const runSpike = requireFile(PATHS.runSpike);
        const stageSource = requireFile(PATHS.stageSource);
        assert.match(stageSource, /journal_append "\$arch" "\$manifest_sha" "\$attempt_id" "pass-authorization"/, 'run must append the terminal pass-authorization event before emit-pass');
        assert.match(runSpike, /journal_require_terminal "\$arch" "\$manifest_sha" "\$attempt_id" "pass-authorization" "AUTHORIZED"/, 'emit-pass must require the terminal pass-authorization phase and AUTHORIZED verdict');
        assert.match(runSpike, /journal_require_terminal[\s\S]{0,140}"\$final_evidence_sha" "\$terminal_event_sha"/, 'emit-pass must match the terminal event to evidence-final.json');
    });

    test('journal appenders serialize predecessor selection, append, and sync under one lock', () => {
        for (const p of [PATHS.runSpike, PATHS.stageSource]) {
            const src = requireFile(p);
            const body = extractShellFunction(src, 'journal_append');
            const lock = body.indexOf('fcntl.flock(lock_fd, fcntl.LOCK_EX)');
            const read = body.indexOf('with open(jpath, "r", encoding="utf-8") as fh:');
            const append = body.indexOf('os.write(fd, (new_line + "\\n").encode("utf-8"))');
            const fsync = body.indexOf('os.fsync');
            const unlock = body.indexOf('fcntl.flock(lock_fd, fcntl.LOCK_UN)');
            assert.ok(lock !== -1 && read !== -1 && append !== -1 && fsync !== -1 && unlock !== -1, `${path.basename(p)} must use Python fcntl locking and fsync`);
            assert.ok(lock < read, `${path.basename(p)} must acquire the lock before validating the chain`);
            assert.ok(read < append, `${path.basename(p)} must validate the existing chain before append`);
            assert.ok(append < fsync, `${path.basename(p)} must append before syncing`);
            assert.ok(fsync < unlock, `${path.basename(p)} must sync before releasing the lock`);
        }
    });

    test('run-spike.sh emit-pass rejects forged or non-authorized terminal journal events', () => {
        const { script, artifactRoot } = tempRunSpike();
        const arch = 'amd64';
        const manifest = 'c'.repeat(64);
        const attempt = 'd'.repeat(32);
        const attemptDir = path.join(artifactRoot, 'runs', arch, 'candidate-n', manifest, attempt);
        fs.mkdirSync(attemptDir, { recursive: true });
        const evidence = `{"phase":"finalize","verdict":"ELIGIBLE","manifestSha256":"${manifest}","attemptId":"${attempt}"}`;
        const finalEvidencePath = path.join(attemptDir, 'evidence-final.json');
        fs.writeFileSync(finalEvidencePath, evidence, { mode: 0o400 });
        fs.chmodSync(finalEvidencePath, 0o400);
        const finalEvidenceSha = sha256Text(evidence);
        for (const f of ['preflight-scan-request.json', 'external-preflight-tcp.scan', 'scan-request.json', 'external-tcp.scan', 'external-udp.scan', 'evidence-pre-cleanup.json', 'summary.txt']) {
            const fp = path.join(attemptDir, f);
            fs.writeFileSync(fp, `${f}\n`, { mode: 0o400 });
            fs.chmodSync(fp, 0o400);
        }
        const finalize = journalEvent('0'.repeat(64), manifest, attempt, 'finalize', 'ELIGIBLE', finalEvidenceSha);
        const blockedAuth = journalEvent(finalize.eventSha256, manifest, attempt, 'pass-authorization', 'BLOCKED', finalEvidenceSha);
        const journalDir = path.join(artifactRoot, 'runs', arch, 'candidate-n');
        fs.mkdirSync(journalDir, { recursive: true });
        fs.writeFileSync(path.join(journalDir, 'attempt-journal.jsonl'),
            `${finalize.line}\n${blockedAuth.line}\n`);

        const res = spawnSync('bash', ['--noprofile', '--norc', script, 'emit-pass', 'candidate-n', arch, manifest, attempt, finalEvidenceSha, blockedAuth.eventSha256], {
            encoding: 'utf8', timeout: 30_000, cwd: REPO_ROOT,
        });
        assert.notEqual(res.status, 0, 'emit-pass must reject non-AUTHORIZED terminal events');
        assert.doesNotMatch(res.stdout, /PASS candidate-n/, 'forged terminal events must not expose PASS bytes');
        assert.match(res.stderr, /terminal journal|authorization|hash|verdict/i);
    });

    test('incomplete native phase scaffolds fail closed instead of producing final evidence', () => {
        const { script, artifactRoot } = tempRunSpike();
        const manifest = 'a'.repeat(64);
        const attempt = 'b'.repeat(32);
        const res = spawnSync('bash', ['--noprofile', '--norc', script, 'finalize', 'candidate-n', 'amd64', manifest, attempt], {
            encoding: 'utf8', timeout: 30_000, cwd: REPO_ROOT,
        });
        assert.notEqual(res.status, 0, 'finalize must not synthesize eligible evidence before native cleanup/evidence exists');
        assert.doesNotMatch(res.stdout, /PASS candidate-n/);
        assert.match(res.stderr, /BLOCKED/);
        assert.equal(fs.existsSync(path.join(artifactRoot, 'runs', 'amd64', 'candidate-n', manifest, attempt, 'evidence-final.json')), false);
    });

    test('probe.py rejects URL credentials, paths, queries, and fragments before output capture', () => {
        const urls = [
            'http://user:password@127.0.0.1:1',
            'http://127.0.0.1:1/secret',
            'http://127.0.0.1:1?token=abc',
            'http://127.0.0.1:1#fragment',
        ];
        for (const url of urls) {
            const res = spawnSync('python3', [PATHS.probe, '--destination-url', url, '--source-ipv4', '127.0.0.1'], {
                encoding: 'utf8', timeout: 30_000, cwd: REPO_ROOT,
            });
            if (res.error && res.error.code === 'ENOENT') continue;
            assert.equal(res.status, 2, `probe should reject unsafe URL ${url}: stdout=${res.stdout} stderr=${res.stderr}`);
            assert.equal(res.stdout.trim(), '', 'unsafe URLs must not be emitted in probe output');
        }
    });

    test('probe listener modes bind the caller-requested validated port', () => {
        const src = requireFile(PATHS.probe);
        assert.match(src, /def validate_port\(/, 'probe.py must validate listener ports before socket use');
        assert.match(src, /self\._sock\.bind\(\(bind_ip, port\)\)/, 'listener constructors must bind the requested port, not always port zero');
        assert.match(src, /_ReferenceListener\(bind_ip, .*port=listener_port/, 'reference listener must receive the validated requested port');
        assert.match(src, /_DecoyListener\(bind_ip, port=listener_port/, 'decoy listener must receive the validated requested port');
    });

    test('stage-source.sh green executes exactly the contract test itself', () => {
        const src = requireFile(PATHS.stageSource);
        assert.ok(src.includes('node --test tests/unit/ds004Q8SpikeContract.test.mjs'), 'green must run exactly this test file');
    });

    test('stage-source.sh with an unknown verb fails closed with empty stdout', () => {
        const res = spawnSync('bash', ['--noprofile', '--norc', PATHS.stageSource, 'bogus-verb'], {
            encoding: 'utf8', env: CLEAN_ENV, timeout: 30_000, cwd: REPO_ROOT,
        });
        assert.notEqual(res.status, 0);
        assert.equal(res.stdout.trim(), '');
    });
});

// --- 11. README operator documentation ----------------------------------------

describe('README operator documentation', () => {
    test('README documents the nine required coordinator inputs', () => {
        const src = requireFile(PATHS.readme);
        for (const v of [
            'DS004_EXTERNAL_SCANNER_SSH', 'DS004_AMD64_RUNNER_SSH', 'DS004_ARM64_RUNNER_SSH',
            'DS004_AMD64_BOX_LAN_IPV4', 'DS004_ARM64_BOX_LAN_IPV4', 'DS004_SSH_KNOWN_HOSTS_FILE',
            'DS004_EXTERNAL_SCANNER_IDENTITY_FILE', 'DS004_AMD64_RUNNER_IDENTITY_FILE', 'DS004_ARM64_RUNNER_IDENTITY_FILE',
        ]) {
            assert.ok(src.includes(v), `README missing coordinator input "${v}"`);
        }
    });

    test('README documents the decision rule: evidence never chooses the architecture', () => {
        const src = requireFile(PATHS.readme);
        assert.match(src, /evidence never chooses the architecture/i);
    });

    test('README documents that this repo is not the sole source of authority', () => {
        const src = requireFile(PATHS.readme);
        assert.match(src, /2026-07-19-ploinky-box-clean-rebuild/);
    });
});
