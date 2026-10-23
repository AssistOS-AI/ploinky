import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { routerInventory, routerInventoryHistorical } from './router-inventory.mjs';
import { buildLiveSessionsRouterInventory, assertLiveSessionsRouterInventory } from './router-live-sessions-inventory.mjs';

const bytes = fs.readFileSync(new URL('../../../cli/server/handlers/webtty.js', import.meta.url));

test('current Live Sessions inventory preserves historical checks and explicitly adds five administrator routes', () => {
    assert.equal(routerInventoryHistorical.length, 128);
    assert.equal(routerInventory.length, 133);
    assert.equal(assertLiveSessionsRouterInventory(routerInventory, routerInventoryHistorical, bytes), true);
    for (const id of ['webtty-live-sessions.get', 'webtty-attach-token.post', 'webtty-attachment.post',
        'webtty-close-policy.post', 'webtty-close-intents.post']) {
        const row = routerInventory.find(row => row.id === id);
        assert.ok(row);
        const line = Number(row.source.split(':')[1]);
        assert.ok(bytes.toString().split('\n')[line - 1].includes(row.anchor));
        assert.deepEqual(row.expected, { anonymous: 'deny', selfRegistered: 'deny', user: 'deny', admin: 'allow' });
        assert.throws(() => assertLiveSessionsRouterInventory(routerInventory.filter(row => row.id !== id), routerInventoryHistorical, bytes), /LIVE_SESSIONS_CONTRACT_DRIFT/);
        assert.throws(() => assertLiveSessionsRouterInventory(routerInventory.map(row => row.id === id
            ? { ...row, expected: { ...row.expected, user: 'allow' } } : row), routerInventoryHistorical, bytes), /LIVE_SESSIONS_CONTRACT_DRIFT/);
    }
    assert.throws(() => buildLiveSessionsRouterInventory(routerInventoryHistorical.slice(1), bytes), /MISSING_ROUTER_OBLIGATION/);
    assert.throws(() => buildLiveSessionsRouterInventory(routerInventoryHistorical, Buffer.concat([bytes, Buffer.from('\n')])), /UNREVIEWED_LIVE_SESSIONS_SOURCE/);
    for (const id of ['webtty-create.post', 'webtty-stream.get', 'webtty-input.post', 'webtty-resize.post', 'webtty-delete.delete']) {
        assert.throws(() => assertLiveSessionsRouterInventory(routerInventory.map(row => row.id === id ? { ...row, notes: 'weakened' } : row),
            routerInventoryHistorical, bytes), /LIVE_SESSIONS_CONTRACT_DRIFT/);
    }
});
