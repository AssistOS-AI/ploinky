// Regenerates localLlmRunnerEnv.json from the local-llm sources themselves:
//   node tests/hardware-limits/captureLocalLlmRunnerEnv.mjs --tree <local-llm directory> > tests/hardware-limits/localLlmRunnerEnv.json
// It reads (never writes) the tree. The environment a runner process holds is what the controller's runnerEnv composes
// (src/controller/deployments.mjs: PATH, HOME, LANG, CUDA_CACHE_PATH, the adapter's launch environment without the MPS
// names, then the saved share's MPS environment), built here from the adapters' real buildLaunch output and the real
// mpsRunnerEnvironment. Per-start secrets are recorded by name only; every other value is recorded as the fixed
// inputs below produced it.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const at = process.argv.indexOf('--tree');
if (at < 0 || !process.argv[at + 1]) throw new Error('Usage: --tree <local-llm directory>');
const tree = path.resolve(process.argv[at + 1]);
const load = file => import(pathToFileURL(path.join(tree, file)).href);
const { llamaCppRunner } = await load('src/runners/llamaCpp.mjs');
const { vllmRunner } = await load('src/runners/vllm.mjs');
const { mpsRunnerEnvironment, MPS_VARIABLES } = await load('src/controller/ploinkyBudget.mjs');
const { loadSeedCatalog } = await load('src/controller/catalog.mjs');
const models = loadSeedCatalog();
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
const out = { schema: 1, source: { repository: 'local-llms', commit: execFileSync('git', ['-C', tree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), files: ['src/controller/deployments.mjs', 'src/runners/llamaServer.mjs', 'src/runners/vllm.mjs', 'src/controller/ploinkyBudget.mjs'] }, runners: {} };
for (const [id, launch] of Object.entries(launches)) {
    const env = runnerEnv(launch.env, 'dedicated');
    out.runners[id] = Object.fromEntries(Object.keys(env).sort().map(name => [name, PER_START_SECRETS.has(name) ? { perStartSecret: true } : { value: env[name] }]));
}
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
