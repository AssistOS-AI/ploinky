import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildAgentImagesRouterInventory } from './router-agent-images-inventory.mjs';
import { routerInventoryBaseline } from './router-inventory.mjs';

const bytes = fs.readFileSync(new URL('../../../cli/server/edgeRoutePlan.js', import.meta.url));

test('agent image inventory adds exactly one private GET while preserving all historical obligations', () => {
    assert.equal(routerInventoryBaseline.length, 128);
    const rows = buildAgentImagesRouterInventory(routerInventoryBaseline, bytes);
    assert.equal(rows.length, 129);
    assert.deepEqual(rows.slice(0, 128), routerInventoryBaseline);
    const row = rows.at(-1);
    assert.equal(row.id, 'private-agent-images.get');
    assert.deepEqual(row.expected, { anonymous: 'deny', selfRegistered: 'deny', user: 'deny', admin: 'deny' });
    assert.ok(bytes.toString().split('\n')[Number(row.source.split(':')[1]) - 1].includes(row.anchor));
    assert.throws(() => buildAgentImagesRouterInventory(rows, bytes), /DUPLICATE_ROUTER_OBLIGATION/);
    assert.throws(() => buildAgentImagesRouterInventory(routerInventoryBaseline, Buffer.concat([bytes, Buffer.from('\n')])),
        /UNREVIEWED_AGENT_IMAGES_SOURCE/);
});
