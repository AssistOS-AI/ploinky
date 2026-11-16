import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveSeatbeltRuntimeLayout, applySeatbeltRuntimeEnvironment } from '../../cli/sandbox/seatbelt/seatbeltServiceManager.js';
import { PLOINKY_WORKSPACE_ROOT } from '../../cli/utils/config.js';

test('seatbelt explicit HOME and data environment use canonical host paths', () => {
    const manifest = { volumes: { '.data/dpu-data': '/root', '.data': '/workspace-data' } };
    const layout = resolveSeatbeltRuntimeLayout({ agentName: 'store', cwd: PLOINKY_WORKSPACE_ROOT, manifest });
    assert.equal(layout.agentWorkDir, path.join(PLOINKY_WORKSPACE_ROOT, '.data/dpu-data'));
    const env = applySeatbeltRuntimeEnvironment({ DPU_DATA_ROOT: '/root', DPU_WORKSPACE_DATA_ROOT: '/workspace-data', FILE: '/root/secrets.json', UNRELATED: '/rooted' }, layout, manifest);
    assert.equal(env.HOME, layout.agentWorkDir);
    assert.equal(env.DPU_DATA_ROOT, layout.agentWorkDir);
    assert.equal(env.DPU_WORKSPACE_DATA_ROOT, path.join(PLOINKY_WORKSPACE_ROOT, '.data'));
    assert.equal(env.FILE, path.join(layout.agentWorkDir, 'secrets.json'));
    assert.equal(env.UNRELATED, '/rooted');
});
