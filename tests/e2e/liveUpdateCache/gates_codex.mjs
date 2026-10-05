import fs from 'node:fs';
import path from 'node:path';
import { AcceptanceError, LIMITS, need, parseStrictJson, boxName, smokeOrigin } from './manifest_codex.mjs';
import { gpuWiringIdentityOf } from './engine_codex.mjs';
import { runOwnedCommand, buildCommandEnvironment } from './host_command_codex.mjs';
import { readBoundedRegularFile } from './worker_codex.mjs';

// U8 canonical gates. Each gate is the repository's own smoke entrypoint run once, headless, with one worker and zero
// retries, a new run ID and a new artifact directory, against the fresh canonical fixture. A gate passes only when its
// JSON report discovers exactly one test and that test passed once with no skip, retry or recorded error.
export const GATE_SPECS = Object.freeze({
    Copilot: { spec: 'specs/05-copilot-folder-launch.spec.mjs', title: 'opens a working Copilot from a newly created folder', budgetMs: 540000, flags: {} },
    OnlyOffice: { spec: 'specs/50-onlyoffice-dpu.spec.mjs', title: 'Explorer-created Confidential document saves through callback, drains, and reopens after targeted restart', budgetMs: 840000, flags: { SMOKE_ONLYOFFICE: '1' } },
    WebMeet: { spec: 'specs/30-webmeet-room-chat.spec.mjs', title: 'two Explorer accounts can join one room and exchange chat', budgetMs: 120000, flags: { SMOKE_WEBMEET_HEADLESS: '1', SMOKE_WEBMEET_MEDIA: '1' } },
});
// Command and pipe settlement allowance added to each gate's own test budget when the remaining validity is admitted.
export const GATE_WRAPPER_ALLOWANCE_MS = 30000;
const PASSTHROUGH = Object.freeze(['SMOKE_USERNAME', 'SMOKE_PASSWORD', 'SMOKE_LOGIN_EMAIL', 'SMOKE_ACCOUNT_PASSWORD', 'SMOKE_SIGN_IN_METHOD', 'SMOKE_TOTP_SECRET', 'SMOKE_EMAIL_CODE_COMMAND',
    'SMOKE_ACCOUNT_EMAIL_DOMAIN', 'SMOKE_SECONDARY_USERNAME', 'SMOKE_SECONDARY_LOGIN_EMAIL', 'SMOKE_SECONDARY_PASSWORD', 'SMOKE_SECONDARY_ACCOUNT_PASSWORD', 'SMOKE_SECONDARY_SIGN_IN_METHOD',
    'SMOKE_SECONDARY_TOTP_SECRET', 'SMOKE_AUTH_AGENT', 'SMOKE_WEBCHAT_AGENT', 'SMOKE_DPU_DATA_ROOT']);
const REPORT_BYTES = LIMITS.readBytes;

export const remainingGateWorkMs = names => names.reduce((sum, name) => sum + GATE_SPECS[name].budgetMs + GATE_WRAPPER_ALLOWANCE_MS, 0);

// The Box contract the repository's own smoke checks need, bound to the manifest of the Box the gate runs against.
// The Router loopback sign-in is canonicalized to `localhost`, so the browser origin is `localhost`; the host-side Box evidence
// (`SMOKE_BOX_BASE_URL`) is the exact `127.0.0.1` loopback. SMOKE_PLOINKY_BOX_CONTAINER is the exact container name, never the ID.
// The GPU-grant expectation is exported only when the manifest binds an actual grant fingerprint (the Box then carries the label).
const HEX64 = /^[a-f0-9]{64}$/;
export function boxEnvironment(manifest) {
    const box = manifest?.box, publication = manifest?.publications?.[0], grant = manifest?.engine?.gpuWiringIdentity;
    need(box && boxName(box.name) && !HEX64.test(box.name) && box.name !== box.id, 'gate-box-binding');
    need(typeof box.imageRef === 'string' && box.imageRef !== '' && typeof box.imageId === 'string' && HEX64.test(box.imageId), 'gate-box-binding');
    need(publication && Number.isSafeInteger(publication.hostPort) && publication.hostPort > 0 && publication.hostPort < 65536, 'gate-box-binding');
    need(typeof grant === 'string' && HEX64.test(grant), 'gate-box-binding');
    const env = { SMOKE_PLOINKY_BOX_CONTAINER: box.name, SMOKE_BOX_BASE_URL: `http://127.0.0.1:${publication.hostPort}`, SMOKE_BASE_URL: smokeOrigin(publication),
        SMOKE_EXPECT_BOX_IMAGE_REF: box.imageRef, SMOKE_EXPECT_BOX_IMAGE_ID: `sha256:${box.imageId}` };
    if (grant !== gpuWiringIdentityOf({})) env.SMOKE_BOX_GPU_GRANT = grant;
    return env;
}

export function gateEnvironment({ manifest, inputs, gate, runId, artifactDir, processEnv }) {
    const spec = GATE_SPECS[gate]; need(spec, 'gate-unknown');
    const extra = { ...boxEnvironment(manifest), SMOKE_RUN_ID: runId, SMOKE_ARTIFACT_DIR: artifactDir,
        SMOKE_WORKSPACE_ROOT: manifest.workspace.path, ...spec.flags };
    if (gate === 'Copilot') Object.assign(extra, { SMOKE_RELEASE_MANIFEST: inputs.releaseManifest, SMOKE_SOURCE_VERIFICATION: 'release' });
    if (gate === 'OnlyOffice') Object.assign(extra, { SMOKE_DEPLOYMENT_MODE: 'box', SMOKE_PLOINKY_BIN: manifest.candidate.cliPath });
    for (const name of PASSTHROUGH) if (typeof processEnv?.[name] === 'string' && processEnv[name] !== '' && !/[\0\r\n]/.test(processEnv[name])) extra[name] = processEnv[name];
    // The browser-error guard must stay on and no timeout is widened by an environment override.
    need(processEnv?.SMOKE_ALLOW_BROWSER_ERRORS === undefined || processEnv.SMOKE_ALLOW_BROWSER_ERRORS === '', 'gate-browser-errors-allowed');
    for (const name of Object.keys(processEnv ?? {})) need(!/^SMOKE_[A-Z_]*TIMEOUT[A-Z_]*$|^SMOKE_WEBMEET_REFRESH_MAX_WAIT_MS$/.test(name), 'gate-timeout-override');
    return buildCommandEnvironment(processEnv, extra);
}

// Strictly project the Playwright JSON report: counts only, never titles, errors, attachments or output.
export function projectReport(bytes) {
    let report; try { report = parseStrictJson(bytes, REPORT_BYTES); } catch { throw new AcceptanceError('gate-report'); }
    need(report && typeof report === 'object' && report.stats && typeof report.stats === 'object' && Array.isArray(report.suites), 'gate-report');
    const tests = [], visit = suite => { for (const spec of suite.specs ?? []) for (const test of spec.tests ?? []) tests.push(test); for (const child of suite.suites ?? []) visit(child); };
    for (const suite of report.suites) visit(suite);
    const stats = report.stats, count = value => { need(Number.isSafeInteger(value) && value >= 0, 'gate-report'); return value; };
    const passed = count(stats.expected), failed = count(stats.unexpected), skipped = count(stats.skipped), flaky = count(stats.flaky);
    const results = tests.flatMap(test => Array.isArray(test.results) ? test.results : []);
    const retries = results.filter(result => Number(result.retry) > 0).length + tests.filter(test => (test.results?.length ?? 0) > 1).length;
    const errors = results.filter(result => (Array.isArray(result.errors) && result.errors.length > 0) || result.error).length;
    return Object.freeze({ discovered: tests.length, passed, failed: failed + flaky, skipped, retries, ignoredErrors: errors });
}

export function createGatePort({ manifest, inputs, deps, processEnv = process.env, io = fs, now = () => Date.now() }) {
    need(manifest && inputs && deps, 'gate-port-adapters');
    const explorer = manifest.candidate.repositories.find(repo => repo.name === 'AssistOSExplorer'); need(explorer, 'gate-explorer-repository');
    const smoke = path.join(explorer.path, 'tests', 'smoke'), stem = manifest.runId.replace(/_codex$/, '');
    return Object.freeze({
        async run(gate) {
            const spec = GATE_SPECS[gate]; need(spec, 'gate-unknown');
            const runId = `${stem}-${gate.toLowerCase()}`.replace(/[^A-Za-z0-9_-]/g, '-'), artifactDir = path.join(manifest.evidence.root, 'gates', gate.toLowerCase());
            const env = gateEnvironment({ manifest, inputs, gate, runId, artifactDir, processEnv });
            const startedAt = new Date(now()).toISOString();
            // A non-zero exit is a failed gate; its artifacts remain for diagnosis and the run stops.
            await runOwnedCommand({ operation: `gate-${gate.toLowerCase()}`, kind: 'mutation', cwd: smoke, env, deadlineMs: spec.budgetMs + GATE_WRAPPER_ALLOWANCE_MS, collect: false, tap: { push: () => true, end() {} },
                argv: [manifest.host.node.path, path.join(smoke, 'scripts', 'run-playwright.mjs'), '--project=chromium', '--workers=1', '--retries=0', '--grep', spec.title, spec.spec] }, deps);
            const finishedAt = new Date(now()).toISOString();
            let bytes; try { bytes = readBoundedRegularFile(path.join(artifactDir, 'test-results', 'results.json'), REPORT_BYTES, io); } catch { throw new AcceptanceError('gate-report'); }
            const counts = projectReport(bytes);
            return Object.freeze({ name: gate, runId, ...counts, closed: true, startedAt, finishedAt });
        },
    });
}
