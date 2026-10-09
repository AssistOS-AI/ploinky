/**
 * Actual-module proof that the A7 WebChat launch arguments put the DPU in WebChat mode
 * (AssistOSExplorer dpuAgent/src/index.mjs webChatMode). The Router's own launch-argument resolution
 * produces the argv; the real DPU module is spawned with it and answers the exact envelope line the Router
 * forwards for an `/authz-...` marker. Without --forward-envelope=1 the acknowledgement must not appear.
 *
 * The DPU module's lazy `achillesAgentLib` import is resolved to PLOINKY_AGENTLIB_DIR by a test-only resolver hook
 * (the DPU checkout is read-only here). The DPU checkout is located through PLOINKY_DPU_AGENT_DIR, else the sibling AssistOSExplorer checkouts; when
 * none exists the tests are skipped with the reason (a skip is not a pass).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { webchatProbe, DPU_UNSUPPORTED_REPLY } from './webchat-probes.mjs';
import { resolveWebchatLaunchOptions } from '../../../cli/server/handlers/webchat/launchOptions.js';
import { serializeWebchatEnvelopeForAgent } from '../../../cli/server/handlers/webchat/messageEnvelope.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const candidates = [
    process.env.PLOINKY_DPU_AGENT_DIR,
    path.resolve(root, '../AssistOSExplorer/dpuAgent'),
    path.resolve(root, '../../AssistOSExplorer/dpuAgent'),
    path.resolve(root, '../../../perf-integration/AssistOSExplorer/dpuAgent'),
].filter(Boolean);
const entry = candidates.map(d => path.join(d, 'src/index.mjs')).find(f => fs.existsSync(f));
const skip = entry ? false : `DPU checkout not found (tried ${candidates.join(', ')}); set PLOINKY_DPU_AGENT_DIR`;

const launchArgs = (withForward) => {
    const params = new URLSearchParams(`agent=dpuAgent&authz-probe=x&tabId=t&${webchatProbe.launchArgs}`);
    if (!withForward) params.delete('forward-envelope');
    return resolveWebchatLaunchOptions(new URL(`/webchat/stream?${params}`, 'http://localhost')).cliArgs;
};

function runDpu(args, line, waitMs, { endStdin = false } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', registerHook, entry, ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NODE_ENV: 'test' } });
        let out = '';
        let err = '';
        child.stdout.on('data', d => { out += d; });
        child.stderr.on('data', d => { err += d; });
        child.on('error', reject);
        child.stdin.on('error', () => {});
        child.stdin.write(`${line}\n`);
        if (endStdin) child.stdin.end(); // terminal mode reads stdin to EOF before acting
        setTimeout(() => { child.kill('SIGKILL'); resolve({ out, err }); }, waitMs);
    });
}

const registerHook = path.join(here, 'webchat-dpu-launch-mode.register.mjs');
const marker = '/authz-A-proof';
const line = serializeWebchatEnvelopeForAgent({ req: { headers: {} }, effectiveConfig: null, tabId: 't', envelope: { text: marker, attachments: [], presentation: { visible: true } } });

test('the harness launch arguments put the actual DPU in WebChat mode and it writes the exact unsupported reply', { skip }, async () => {
    const args = launchArgs(true);
    assert.ok(args.includes('--forward-envelope=1') && args.includes('--authz-probe=x'));
    const { out, err } = await runDpu(args, line, 4000);
    assert.equal(err, '', 'the actual DPU started in WebChat mode without error');
    assert.equal(out, DPU_UNSUPPORTED_REPLY);
});

test('without --forward-envelope=1 the actual DPU never writes the acknowledgement', { skip }, async () => {
    const args = launchArgs(false);
    assert.ok(!args.includes('--forward-envelope=1'));
    const { out, err } = await runDpu(args, line, 4000, { endStdin: true });
    assert.ok(!out.includes(DPU_UNSUPPORTED_REPLY), out);
    // Not vacuous: the DPU ran as a terminal, took the launch flag as a research request and refused it for lack of
    // an authenticated WebChat invocation (no inference happens).
    assert.match(`${out}${err}`, /Authenticated WebChat invocation is required/);
});
