import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

test('retired dashboard stays absent while Router and Policy use Ploinky-owned files', async () => {
    const routingSource = await fs.readFile(path.resolve('cli/server/RoutingServer.js'), 'utf8');
    const loggerSource = await fs.readFile(path.resolve('cli/server/utils/logger.js'), 'utf8');
    const policySource = await fs.readFile(path.resolve('cli/server/policy/FileSystemPolicyAuditSink.js'), 'utf8');
    const appendLogSource = loggerSource.slice(
        loggerSource.indexOf('export function appendLog'),
        loggerSource.indexOf('export function flushPendingLogs'),
    );
    assert.doesNotMatch(routingSource, /handleDashboard|isRouteMount\(pathname, '\/dashboard'\)/);
    assert.match(loggerSource, /router\.log/);
    assert.match(loggerSource, /createAsyncLogWriter|promises\.appendFile/);
    assert.doesNotMatch(appendLogSource, /appendFileSync|mkdirSync/);
    assert.match(policySource, /policy-audit\.log|appendFileSync/);
});

test('private Router exposes one capability-bound workspace-log operation endpoint', async () => {
    const routingSource = await fs.readFile(path.resolve('cli/server/RoutingServer.js'), 'utf8');
    const planSource = await fs.readFile(path.resolve('cli/server/edgeRoutePlan.js'), 'utf8');
    const privateSource = await fs.readFile(path.resolve('cli/server/privateRouter.js'), 'utf8');
    assert.match(planSource, /pathname === '\/api\/edge\/workspace-logs'/);
    assert.match(privateSource, /workspaceLogConsumers/);
    assert.match(privateSource, /paths: \['\/api\/edge\/workspace-logs'\]/);
    assert.match(routingSource, /executeWorkspaceLogOperation/);
    assert.doesNotMatch(routingSource, /streamWorkspaceLog/);
});

test('workspace metrics collection is asynchronous and publishes a safe projection', async () => {
    const source = await fs.readFile(path.resolve('cli/server/workspaceMetrics.js'), 'utf8');
    const registrySource = await fs.readFile(path.resolve('cli/sandbox/docker/containerRegistry.js'), 'utf8');
    const statusSource = await fs.readFile(path.resolve('cli/server/handlers/status.js'), 'utf8');
    assert.match(source, /collectAgentRuntimeStatesAsync/);
    assert.doesNotMatch(source, /spawnSync|return \{ \.\.\.entry/);
    assert.match(source, /publicRuntimeEntry/);
    assert.match(source, /aggregateProcessTreeMetrics/);
    assert.match(source, /did not create a cgroup\|does not have a cgroup/);
    assert.match(registrySource, /execFileAsync\(runtime, \['inspect', \.\.\.names\]/);
    assert.match(statusSource, /cleanupWhenResponseCloses\(res, unsubscribe\)/);
    assert.doesNotMatch(statusSource, /req\.on\('close'/);
});
