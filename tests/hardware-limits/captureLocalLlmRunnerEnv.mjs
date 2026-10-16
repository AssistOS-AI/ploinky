// Regenerates localLlmRunnerEnv.json from the local-llm sources themselves:
//   node tests/hardware-limits/captureLocalLlmRunnerEnv.mjs --candidate <local-llms repository root> > tests/hardware-limits/localLlmRunnerEnv.json
// The candidate is a clean git checkout of local-llms. It is never written to: the tool runs it through the harness's
// scratch layout (prepareLocalLlmsLayout), which archives the exact candidate commit, installs the pworker engine with the
// uniform command (npm --prefix local-llm install --ignore-scripts --no-bin-links --no-package-lock) in that copy, and
// records the pworker commit and the digest of the installed package. The scratch copy is removed afterwards. A candidate
// that is not clean is refused, so the commit written below is the whole candidate.
// The environment a runner process holds is what the engine's controller composes (lib/local-llm/controller/deployments.mjs in the
// installed pworker: PATH, HOME, LANG, CUDA_CACHE_PATH, the adapter's launch environment without the MPS
// names, then the saved share's MPS environment), built here from the adapters' real buildLaunch output and the real
// mpsRunnerEnvironment. Per-start secrets are recorded by name only; every other value is recorded as the fixed
// inputs below produced it. The engine has no default host, so the agent's own host (src/agentHost.mjs) and the agent's own
// seed catalog (catalog/models.json) are given to it explicitly. The engine is imported by path from the scratch copy's
// node_modules, never by the package name, which a script of this repository would resolve against its own tree.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { randomRunId } from './fixtures.mjs';
import { assertLocalLlmsLayoutUnchanged, candidateDigest, prepareLocalLlmsLayout } from './verify.mjs';

const at = process.argv.indexOf('--candidate');
if (at < 0 || !process.argv[at + 1]) throw new Error('Usage: --candidate <local-llms repository root>');
const candidate = fs.realpathSync(path.resolve(process.argv[at + 1]));
const sourceDigest = candidateDigest(candidate);
if (!sourceDigest.startsWith('git-tree:')) throw new Error(`The local-llms candidate ${candidate} is not clean; commit or remove its changes first`);
const commit = execFileSync('git', ['-C', candidate, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const stageParent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hwl-capture-'));
try {
    const layout = prepareLocalLlmsLayout({ candidateRoot: candidate, sourceDigest, stageParent, runId: randomRunId() });
    const tree = path.join(layout.root, 'local-llm');
    const engine = path.join(tree, 'node_modules', 'pworker', 'lib', 'local-llm');
    const load = file => import(pathToFileURL(file).href);
    const { agentHost, agentSeedCatalogFile } = await load(path.join(tree, 'src', 'agentHost.mjs'));
    const { createLlamaCppRunners } = await load(path.join(engine, 'runners', 'llamaCpp.mjs'));
    const { createVllmRunner } = await load(path.join(engine, 'runners', 'vllm.mjs'));
    const { loadSeedCatalog } = await load(path.join(engine, 'controller', 'catalog.mjs'));
    const { mpsRunnerEnvironment, MPS_VARIABLES } = await load(path.join(tree, 'src', 'controller', 'ploinkyBudget.mjs'));
    const host = agentHost({});
    const { llamaCpp: llamaCppRunner } = createLlamaCppRunners({ host });
    const vllmRunner = createVllmRunner({ host });
    const models = loadSeedCatalog(agentSeedCatalogFile());
    const modelOf = id => { const found = models.find(entry => entry.id === id); if (!found) throw new Error(`The seed catalog has no ${id}`); return found; };

    const PER_START_SECRETS = new Set(['VLLM_API_KEY']);
    const dataDir = '/data/local-llm';
    const containerEnv = { CUDA_MPS_PIPE_DIRECTORY: '/run/ploinky-mps-pipe', CUDA_MPS_ACTIVE_THREAD_PERCENTAGE: '50', CUDA_MPS_PINNED_DEVICE_MEM_LIMIT: '0=3072M' };
    // deployments.mjs runnerEnv(launchEnv, profile)
    const runnerEnv = (launchEnv, profile) => {
        const adapter = { ...launchEnv };
        for (const key of MPS_VARIABLES) delete adapter[key];
        return { PATH: '/usr/local/nvidia/bin:/usr/local/bin:/usr/bin:/bin', HOME: path.join(dataDir, 'home'), LANG: 'C.UTF-8', CUDA_CACHE_PATH: path.join('/opt/runners', '.cuda-cache'), ...adapter, ...mpsRunnerEnvironment(containerEnv, profile) };
    };
    const common = { artifactPath: '/data/models/model.bin', port: 8100, apiKey: 'k'.repeat(43), profile: 'dedicated' };
    const launches = {
        'llama.cpp': llamaCppRunner.buildLaunch({ ...common, model: modelOf('qwen2.5-0.5b-instruct-q4_k_m'), params: {}, runnerDir: '/opt/llama.cpp' }),
        vllm: vllmRunner.buildLaunch({ ...common, model: modelOf('qwen3-4b-awq'), params: {}, runnerDir: '/opt/runners/vllm/0.30.0', gpuMemoryUtilization: 0.81, cacheDir: '/opt/runners/.cache/vllm', rpcDir: '/dev/shm/local-llm-rpc' }),
    };
    // What was imported must be what was installed and archived: nothing in the copy changed while the modules loaded.
    assertLocalLlmsLayoutUnchanged(layout);
    const out = { schema: 1, source: { repository: 'local-llms', commit, pworkerCommit: layout.install.pworkerCommit, pworkerTreeDigest: layout.install.pworkerTreeDigest, files: ['node_modules/pworker/lib/local-llm/controller/deployments.mjs', 'node_modules/pworker/lib/local-llm/runners/llamaServer.mjs', 'node_modules/pworker/lib/local-llm/runners/llamaCpp.mjs', 'node_modules/pworker/lib/local-llm/runners/vllm.mjs', 'src/controller/ploinkyBudget.mjs', 'src/agentHost.mjs'] }, runners: {} };
    for (const [id, launch] of Object.entries(launches)) {
        const env = runnerEnv(launch.env, 'dedicated');
        out.runners[id] = Object.fromEntries(Object.keys(env).sort().map(name => [name, PER_START_SECRETS.has(name) ? { perStartSecret: true } : { value: env[name] }]));
    }
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
} finally {
    fs.rmSync(stageParent, { recursive: true, force: true });
}
