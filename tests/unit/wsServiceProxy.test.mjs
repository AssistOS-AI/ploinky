import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildStatusLine,
    closeSocket,
    createCapturingRes,
} from '../../cli/server/wsServiceProxy.js';

test('upgrade response capture preserves auth refresh headers without a public response object', () => {
    const response = createCapturingRes();
    response.setHeader('Set-Cookie', 'session=fresh');
    response.writeHead(401, { 'Cache-Control': 'no-store' });
    response.end();
    assert.equal(response.statusCode, 401);
    assert.equal(response.getHeader('set-cookie'), 'session=fresh');
    assert.equal(response.getHeader('cache-control'), 'no-store');
    assert.equal(response.finished, true);
});
test('upgrade status serialization and rejection are bounded HTTP/1.1 responses', () => {
    assert.equal(
        buildStatusLine(403, 'Forbidden', { 'cache-control': 'no-store' }),
        'HTTP/1.1 403 Forbidden\r\ncache-control: no-store\r\n\r\n',
    );
    const writes = [];
    let destroyed = false;
    closeSocket({
        write: value => writes.push(value),
        destroy: () => { destroyed = true; },
    }, 503, 'Service Unavailable');
    assert.match(writes[0], /^HTTP\/1\.1 503 Service Unavailable/);
    assert.equal(destroyed, true);
});
