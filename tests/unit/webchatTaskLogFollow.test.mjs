import assert from 'node:assert/strict';
import test from 'node:test';

import { createTaskLogFollower } from '../../cli/server/webchat/taskLogFollow.js';

function createLogElement() {
    const listeners = new Map();
    return {
        scrollHeight: 300,
        scrollTop: 200,
        clientHeight: 100,
        addEventListener(type, listener) {
            listeners.set(type, listener);
        },
        dispatch(type) {
            listeners.get(type)?.();
        },
    };
}

test('task log follows live output until the operator scrolls up', () => {
    const log = createLogElement();
    const follower = createTaskLogFollower(log);

    log.scrollHeight = 340;
    follower.restoreAfterRender(200);
    assert.equal(log.scrollTop, 340);

    log.scrollTop = 339;
    log.dispatch('scroll');
    log.scrollHeight = 380;
    follower.restoreAfterRender(339);
    assert.equal(log.scrollTop, 339);
});

test('task log resumes following after the operator returns to the end', () => {
    const log = createLogElement();
    const follower = createTaskLogFollower(log);

    log.scrollTop = 120;
    log.dispatch('scroll');
    log.scrollHeight = 320;
    follower.restoreAfterRender(120);
    assert.equal(log.scrollTop, 120);

    log.scrollTop = 220;
    log.dispatch('scroll');

    log.scrollHeight = 360;
    follower.restoreAfterRender(220);
    assert.equal(log.scrollTop, 360);
});
