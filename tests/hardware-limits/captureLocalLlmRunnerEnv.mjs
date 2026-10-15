// Regenerates localLlmRunnerEnv.json from the local-llm sources themselves:
//   node tests/hardware-limits/captureLocalLlmRunnerEnv.mjs --tree <local-llm directory> > tests/hardware-limits/localLlmRunnerEnv.json
// It reads (never writes) the tree, which must be a git checkout whose local-llm directory has the pworker engine installed
// by the harness's uniform command (npm --prefix local-llm install --ignore-scripts --no-bin-links --no-package-lock).
// The environment a runner process holds is what the engine's controller composes (lib/local-llm/controller/deployments.mjs in the
// installed pworker: PATH, HOME, LANG, CUDA_CACHE_PATH, the adapter's launch environment without the MPS
// names, then the saved share's MPS environment), built here from the adapters' real buildLaunch output and the real
// mpsRunnerEnvironment. Per-start secrets are recorded by name only; every other value is recorded as the fixed
// inputs below produced it. The engine has no default host, so the agent's own host (src/agentHost.mjs) and the agent's own
// seed catalog (catalog/models.json) are given to it explicitly. The engine is imported by path from the tree's own
// node_modules, never by the package name, which a script of this repository would resolve against its own tree.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const at = process.argv.indexOf('--tree');
if (at < 0 || !process.argv[at + 1]) throw new Error('Usage: --tree <local-llm directory>');
const tree = path.resolve(process.argv[at + 1]);
const engine = path.join(tree, 'node_modules', 'pworker', 'lib', 'local-llm');
if (!fs.existsSync(engine)) throw new Error(`The pworker engine is not installed in ${tree}; install it with: npm --prefix local-llm install --ignore-scripts --no-bin-links --no-package-lock`);
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
function runnerEnv(launchEnv, profile) {
    const adapter = { ...launchEnv };
    for (const key of MPS_VARIABLES) delete adapter[key];
    return { PATH: '/usr/local/nvidia/bin:/usr/local/bin:/usr/bin:/bin', HOME: path.join(dataDir, 'home'), LANG: 'C.UTF-8', CUDA_CACHE_PATH: path.join('/opt/runners', '.cuda-cache'), ...adapter, ...mpsRunnerEnvironment(containerEnv, profile) };
}
const common = { artifactPath: '/data/models/model.bin', port: 8100, apiKey: 'k'.repeat(43), profile: 'dedicated' };
const launches = {
    'llama.cpp': llamaCppRunner.buildLaunch({ ...common, model: modelOf('qwen2.5-0.5b-instruct-q4_k_m'), params: {}, runnerDir: '/opt/llama.cpp' }),
    vllm: vllmRunner.buildLaunch({ ...common, model: modelOf('qwen3-4b-awq'), params: {}, runnerDir: '/opt/runners/vllm/0.30.0', gpuMemoryUtilization: 0.81, cacheDir: '/opt/runners/.cache/vllm', rpcDir: '/dev/shm/local-llm-rpc' }),
};
const out = { schema: 1, source: { repository: 'local-llms', commit: execFileSync('git', ['-C', tree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), files: ['node_modules/pworker/lib/local-llm/controller/deployments.mjs', 'node_modules/pworker/lib/local-llm/runners/llamaServer.mjs', 'node_modules/pworker/lib/local-llm/runners/llamaCpp.mjs', 'node_modules/pworker/lib/local-llm/runners/vllm.mjs', 'src/controller/ploinkyBudget.mjs', 'src/agentHost.mjs'] }, runners: {} };
for (const [id, launch] of Object.entries(launches)) {
    const env = runnerEnv(launch.env, 'dedicated');
    out.runners[id] = Object.fromEntries(Object.keys(env).sort().map(name => [name, PER_START_SECRETS.has(name) ? { perStartSecret: true } : { value: env[name] }]));
}
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
