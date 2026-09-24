import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runOuterCli } from '../../ploinky-box/bin/ploinky-box.mjs';
import { RETIRED_DEPS_MESSAGE } from '../../cli/retiredCommands.js';
import { launchCli } from '../../cli/index.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FORMS = [['deps'], ['deps', 'status'], ['deps', 'prepare'], ['deps', 'prepare', 'repo/agent'],
    ['deps', 'clean', '--all'], ['deps', 'clean', 'repo/agent'], ['deps', 'bogus']];

function bufferStream() {
    let value = '';
    return { write(chunk) { value += String(chunk); return true; }, value: () => value };
}

// Any supervisor access would mean Box discovery, preparation or engine work.
function forbiddenSupervisor(touched) {
    return new Proxy({}, { get(_target, property) { touched.push(String(property)); throw new Error(`supervisor.${String(property)} must not be used`); } });
}

test('host deps forms print the migration hint and exit nonzero without Box or engine work', async () => {
    for (const argv of [...FORMS, ['--dry-run', 'deps', 'status']]) {
        const touched = [];
        const output = bufferStream();
        const errorOutput = bufferStream();
        const code = await runOuterCli(argv, {
            env: {}, output, errorOutput, input: { isTTY: false },
            supervisor: forbiddenSupervisor(touched),
            execute() { touched.push('execute'); return 0; },
            executeStreaming() { touched.push('executeStreaming'); return 0; },
            relaunch() { touched.push('relaunch'); return 0; },
            updateHostSource() { touched.push('updateHostSource'); return {}; },
        });
        assert.equal(code, 1, argv.join(' '));
        assert.deepEqual(touched, [], argv.join(' '));
        assert.equal(errorOutput.value(), `${RETIRED_DEPS_MESSAGE}\n`);
        assert.doesNotMatch(errorOutput.value() + output.value(), /destroy/);
    }
});

test('direct-core deps forms fail with the same hint and touch no cache, runtime or npm', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-retired-deps-'));
    try {
        const workspace = path.join(scratch, 'workspace');
        const stubBin = path.join(scratch, 'stub-bin');
        const log = path.join(scratch, 'runtime.log');
        fs.mkdirSync(path.join(workspace, '.ploinky'), { recursive: true });
        fs.mkdirSync(stubBin);
        for (const name of ['podman', 'docker', 'npm']) {
            fs.writeFileSync(path.join(stubBin, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\nexit 125\n`);
            fs.chmodSync(path.join(stubBin, name), 0o755);
        }
        const cliUrl = pathToFileURL(path.join(projectRoot, 'cli/commands/cli.js')).href;
        const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
            const { handleCommand } = await import(${JSON.stringify(cliUrl)});
            const forms = ${JSON.stringify(FORMS)};
            const results = [];
            for (const form of forms) {
                try { await handleCommand(form); results.push({ form, ok: true }); }
                catch (error) { results.push({ form, code: error.code, exitCode: error.exitCode, message: error.message }); }
            }
            process.stdout.write(JSON.stringify(results));
        `], {
            cwd: workspace,
            env: { ...process.env, PATH: `${stubBin}${path.delimiter}${process.env.PATH}`, PLOINKY_WORKSPACE_ROOT: workspace },
            encoding: 'utf8',
        });
        for (const result of JSON.parse(output)) {
            assert.equal(result.code, 'PLOINKY_COMMAND_RETIRED', result.form.join(' '));
            assert.equal(result.exitCode, 1);
            assert.equal(result.message, RETIRED_DEPS_MESSAGE);
        }
        assert.equal(fs.existsSync(log), false, 'no runtime or npm invocation');
        assert.equal(fs.existsSync(path.join(workspace, '.ploinky', 'deps')), false, 'no dependency cache touched');
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
});

test('direct-core launch answers deps before AgentLib bootstrap or any core import', async () => {
    for (const argv of [['deps'], ['--debug', 'deps', 'prepare'], ['deps', 'clean', '--all']]) {
        const touched = [];
        const errorOutput = bufferStream();
        const code = await launchCli(argv, {
            env: {},
            errorOutput,
            bootstrapAgentLibImpl: async () => { touched.push('bootstrap'); throw new Error('no bootstrap'); },
            importCoreImpl: async () => { touched.push('core'); throw new Error('no core'); },
            importConfigImpl: async () => { touched.push('config'); throw new Error('no config'); },
        });
        assert.equal(code, 1, argv.join(' '));
        assert.deepEqual(touched, []);
        assert.equal(errorOutput.value(), `${RETIRED_DEPS_MESSAGE}\n`);
    }
});
