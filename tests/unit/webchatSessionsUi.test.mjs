import assert from 'node:assert/strict';
import test from 'node:test';

import { formatRelativeTime } from '../../cli/server/webchat/sessions.js';

test('formats WebChat session activity as compact relative English time', () => {
    const now = Date.parse('2026-07-13T12:00:00.000Z');
    assert.equal(formatRelativeTime('2026-07-13T11:59:40.000Z', now), 'just now');
    assert.equal(formatRelativeTime('2026-07-13T10:00:00.000Z', now), '2 hours ago');
    assert.equal(formatRelativeTime('2026-07-12T12:00:00.000Z', now), '1 day ago');
    assert.equal(formatRelativeTime('2026-07-11T12:00:00.000Z', now), '2 days ago');
    assert.equal(formatRelativeTime('2026-07-06T12:00:00.000Z', now), '1 week ago');
});
