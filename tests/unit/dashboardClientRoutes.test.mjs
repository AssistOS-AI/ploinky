import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getLogPath } from '../../cli/commands/logUtils.js';
import { LOGS_DIR, PLOINKY_DIR } from '../../cli/utils/config.js';

test('dashboard log sources resolve through the canonical Ploinky directories', () => {
    assert.equal(getLogPath('router'), path.join(LOGS_DIR, 'router.log'));
    assert.equal(getLogPath('policy'), path.join(PLOINKY_DIR, 'data', 'router-security', 'policy-audit.log'));
    assert.equal(getLogPath('unknown'), null);
});

test('router dashboard exposes only generic read-only monitoring contracts', async () => {
    const source = await fs.readFile(path.resolve('cli/server/handlers/dashboard.js'), 'utf8');
    assert.doesNotMatch(source, /Location|resolveDashboardLocation|appConfig\.routes/);
    assert.match(source, /readOnly: true/);
    assert.match(source, /pathname === '\/tail'/);
    assert.match(source, /'router', 'policy'/);
    assert.match(source, /!follow && !fs\.existsSync\(logPath\)/);
    assert.match(source, /follow \? \['-F'\] : \[\]/);
    assert.match(source, /cleanupWhenResponseCloses\(res,/);
    assert.doesNotMatch(source, /req\.on\('close'/);
    assert.doesNotMatch(source, /pathname === '\/run'/);
    assert.doesNotMatch(source, /DIRECT_CLI_PATH|readJsonBody|resolveAssetPath/);
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
