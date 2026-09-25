import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runOuterCli } from '../../ploinky-box/bin/ploinky-box.mjs';
import { parseOuterArguments } from '../../ploinky-box/command/parse.mjs';
import { routeOuterCommand } from '../../ploinky-box/command/route.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FORMS = [['deps'], ['deps', 'status'], ['deps', 'prepare', 'repo/agent'], ['deps', 'clean', '--all']];

// `deps` has no command of its own any more: the host routes it exactly like
// any other unknown command (the generic in-Box forward), with no special case.
test('host routes deps like any other unknown command', () => {
    for (const argv of FORMS) {
        const route = routeOuterCommand(parseOuterArguments(argv));
        const unknown = routeOuterCommand(parseOuterArguments(['frobnicate', ...argv.slice(1)]));
        assert.equal(route.kind, 'generic', argv.join(' '));
        assert.deepEqual(Object.keys(route).sort(), Object.keys(unknown).sort(), argv.join(' '));
    }
});

function bufferStream() {
    let value = '';
    return { write(chunk) { value += String(chunk); return true; }, value: () => value };
}

// Records the first supervisor access and refuses it, so the trace shows how
// far the host got toward Box discovery or preparation.
async function hostTrace(argv) {
    const touched = [];
    const supervisor = new Proxy({}, { get(_target, property) {
        touched.push(`supervisor.${String(property)}`);
        throw new Error(`supervisor.${String(property)} refused by the test`);
    } });
    let rejected = null;
    try {
        await runOuterCli(argv, {
            env: {}, output: bufferStream(), errorOutput: bufferStream(), input: { isTTY: false },
            supervisor,
            execute() { touched.push('execute'); return 0; },
            executeStreaming() { touched.push('executeStreaming'); return 0; },
            relaunch() { touched.push('relaunch'); return 0; },
            updateHostSource() { touched.push('updateHostSource'); return {}; },
        });
    } catch (error) {
        rejected = error.message;
    }
    return { touched, rejected };
}

test('host runOuterCli treats deps exactly like an unknown command', async () => {
    for (const argv of FORMS) {
        const deps = await hostTrace(argv);
        const unknown = await hostTrace(['frobnicate', ...argv.slice(1)]);
        assert.deepEqual(deps, unknown, argv.join(' '));
        assert.ok(deps.touched.length > 0, 'an unknown command reaches the generic Box route');
    }
});

test('direct-core deps is an unknown command and touches no cache, runtime or npm', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-deps-unknown-'));
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
        // No provider keys and no .env above the scratch cwd, so the unknown
        // command path cannot reach an LLM.
        const env = {
            PATH: `${stubBin}${path.delimiter}/usr/bin${path.delimiter}/bin`,
            HOME: scratch,
            TMPDIR: os.tmpdir(),
            PLOINKY_WORKSPACE_ROOT: workspace,
            ...(process.env.PLOINKY_AGENTLIB_DIR ? { PLOINKY_AGENTLIB_DIR: process.env.PLOINKY_AGENTLIB_DIR } : {}),
        };
        const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
            const { handleCommand } = await import(${JSON.stringify(cliUrl)});
            const forms = ${JSON.stringify(FORMS)};
            const results = [];
            for (const form of forms) {
                try { results.push({ form, value: await handleCommand(form) ?? null }); }
                catch (error) { results.push({ form, error: error.message }); }
            }
            process.stdout.write('RESULTS:' + JSON.stringify(results) + '\\n');
        `], { cwd: workspace, env, encoding: 'utf8', timeout: 60_000 });
        const results = JSON.parse(output.split('RESULTS:')[1]);
        assert.deepEqual(results, FORMS.map(form => ({ form, value: null })));
        assert.equal(output.match(/Command 'deps' is not recognized as a Ploinky command or system executable/g)?.length, FORMS.length);
        assert.equal(fs.existsSync(log), false, 'no runtime or npm invocation');
        assert.equal(fs.existsSync(path.join(workspace, '.ploinky', 'deps')), false, 'no dependency cache touched');
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
});
