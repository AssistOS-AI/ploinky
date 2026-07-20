import { spawnSync } from 'node:child_process';

const argumentsSet = new Set(process.argv.slice(2));
const files = [
    'tests/integration/runtimeRelayContainer.test.mjs',
    'tests/integration/privateListenerExposure.test.mjs',
    'tests/e2e/routingProxy/networkBoundary.test.mjs',
    'tests/e2e/routingProxy/capacityAndFailure.test.mjs',
    'tests/e2e/routingProxy/browserBasePath.test.mjs',
];
if (argumentsSet.has('--livekit')) files.push('tests/e2e/routingProxy/livekitRouting.test.mjs');
const result = spawnSync(process.execPath, ['--test', '--test-timeout=180000', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
