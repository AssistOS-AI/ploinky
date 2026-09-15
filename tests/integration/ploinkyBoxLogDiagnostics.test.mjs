import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { BOX_READY_LINE } from '../../ploinky-box/constants.mjs';
import { startContainerAndWaitReady } from '../../ploinky-box/lifecycle/container.mjs';
import { createProcessRunner } from '../../ploinky-box/process.mjs';

// Opt in with the immutable ID of an existing local image containing /bin/sh.
// The fixture has no host mounts, network, publications or downloaded images.
const image = process.env.PLOINKY_LOG_TEST_IMAGE;

for (const driver of ['journald', 'k8s-file']) {
    test(`readiness with changing host warnings and ${driver} logs`, { skip: !image }, async (t) => {
        assert.match(image, /^(?:sha256:)?[a-f0-9]{64}$/);
        const token = randomUUID();
        const name = `ploinky-log-test-${token}`;
        const label = 'io.assistos.ploinky-log-test';
        const native = createProcessRunner({
            env: {
                ...process.env,
                DBUS_SESSION_BUS_ADDRESS: `unix:path=/tmp/${name}-absent-bus`,
            },
        });
        const engineArgs = (args) => ['--cgroup-manager=systemd', ...args];
        const runner = {
            query(command, args) { return native.query(command, engineArgs(args)); },
            run(command, args) {
                const result = native.run(command, engineArgs(args));
                if (args[1] === 'start') {
                    // Ensure the next query regenerates warnings with a new second.
                    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);
                }
                return result;
            },
        };
        const boot = [
            'if [ -e /tmp/log-test-booted ]; then',
            '  printf "second boot without readiness\\n"',
            'else',
            '  touch /tmp/log-test-booted',
            '  printf "time=\\\"stored\\\" level=warning msg=\\\"application warning\\\"\\n" >&2',
            `  printf "first boot\\n${BOX_READY_LINE}\\n"`,
            'fi',
            'sleep 120',
        ].join('\n');
        const id = String(runner.run('podman', [
            'container', 'create', '--pull=never', '--name', name,
            '--label', `${label}=${token}`, '--init', '--network', 'none',
            '--cap-drop', 'all', '--security-opt', 'no-new-privileges',
            '--log-driver', driver, '--entrypoint', '/bin/sh', image, '-c', boot,
        ])).trim();
        assert.match(id, /^[a-f0-9]{64}$/);
        t.after(() => {
            const record = JSON.parse(String(runner.run('podman', ['container', 'inspect', id])))[0];
            assert.equal(record.Id, id);
            assert.equal(record.Config.Labels[label], token);
            runner.run('podman', ['container', 'rm', '-f', id]);
        });
        const warnings = runner.query('podman', ['container', 'logs', '--timestamps', id]);
        assert.equal(warnings.ok, true);
        assert.match(warnings.stderr, /no systemd user session available/);
        const stdout = { value: '', write(chunk) { this.value += chunk; } };
        const stderr = { value: '', write(chunk) { this.value += chunk; } };
        await startContainerAndWaitReady({ name: 'podman' }, id, runner, {
            stdout, stderr, timeoutMs: 5000,
        });
        assert.equal(stdout.value, `first boot\n${BOX_READY_LINE}\n`);
        assert.match(stderr.value, /time="stored" level=warning msg="application warning"/);
        assert.equal(stderr.value.match(/no systemd user session available/g)?.length, 1);
        runner.run('podman', ['container', 'stop', '--time', '1', id]);
        stdout.value = '';
        stderr.value = '';
        await assert.rejects(() => startContainerAndWaitReady({ name: 'podman' }, id, runner, {
            stdout, stderr, timeoutMs: 500,
        }), { code: 'PLOINKY_BOX_READY_TIMEOUT' });
        assert.equal(stdout.value, 'second boot without readiness\n');
        assert.equal(stdout.value.includes(BOX_READY_LINE), false);
    });
}
