import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { withDependencyRefresh, dependencyRefreshOperation, hasAgentPackageJson } from '../../cli/utils/dependencies/dependencyRefresh.mjs';

test('dependency refresh recognizes root and code/ package manifests', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deps-refresh-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    assert.equal(hasAgentPackageJson(root), false);
    fs.writeFileSync(path.join(root, 'package.json'), '{}');
    assert.equal(hasAgentPackageJson(root), true);
    fs.mkdirSync(path.join(root, 'code'));
    assert.equal(hasAgentPackageJson(root), false);
    fs.writeFileSync(path.join(root, 'code/package.json'), '{}');
    assert.equal(hasAgentPackageJson(root), true);
});

test('dependency refresh state is isolated per command and shared across nested graph visits', async () => {
    for (const command of ['start', 'enable', 'reinstall']) {
        await withDependencyRefresh(command, async () => {
            const state = dependencyRefreshOperation();
            assert.equal(state.size, 0);
            state.set('repo/agent', 'installed');
            await withDependencyRefresh('enable', async () => {
                assert.equal(dependencyRefreshOperation().get('repo/agent'), 'installed');
            });
        });
        assert.equal(dependencyRefreshOperation(), undefined);
    }
    // `update` changes sources only; lifecycle commands prepare dependencies.
    for (const command of ['update', 'status']) {
        withDependencyRefresh(command, () => assert.equal(dependencyRefreshOperation(), undefined));
    }
});
