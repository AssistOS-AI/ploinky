import assert from 'node:assert/strict';
import test from 'node:test';

import { __testables } from '../../cli/server/webchat/messages.js';

function item(messageIndex) {
    return {
        dataset: Number.isInteger(messageIndex) ? { messageIndex: String(messageIndex) } : {},
    };
}

test('assistant output is inserted before task items that started first', () => {
    const user = item();
    const firstTask = item(2);
    const secondTask = item(3);
    const typing = item();

    assert.equal(
        __testables.findOrderedInsertionPoint(
            [user, firstTask, secondTask, typing],
            1,
            typing,
            null,
        ),
        firstTask,
    );
});

test('new task items remain ordered before the typing indicator', () => {
    const assistant = item(1);
    const firstTask = item(2);
    const typing = item();

    assert.equal(
        __testables.findOrderedInsertionPoint(
            [assistant, firstTask, typing],
            3,
            typing,
            null,
        ),
        typing,
    );
});

test('slash-command tasks wait for the command response before rendering their item', () => {
    assert.equal(__testables.shouldDeferUnindexedTask({
        event: 'started',
        task: { id: 'task-1' },
    }), true);
    assert.equal(__testables.shouldDeferUnindexedTask({
        event: 'started',
        messageIndex: 3,
        task: { id: 'task-1' },
    }), false);
    assert.equal(__testables.shouldDeferUnindexedTask({
        event: 'update',
        task: { id: 'task-1' },
    }), false);
});
