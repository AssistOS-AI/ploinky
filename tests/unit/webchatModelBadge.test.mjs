import test from 'node:test';
import assert from 'node:assert/strict';
import { initDom } from '../../cli/server/webchat/domSetup.js';

test('model and effort share one badge and old effort is cleared by subsequent state', () => {
    const previousDocument = globalThis.document;
    const previousWindow = globalThis.window;
    const badge = {};
    globalThis.document = {
        body: { dataset: {}, setAttribute() {} },
        getElementById: (id) => id === 'runtimeModel' ? badge : null,
        querySelector: () => null,
    };
    globalThis.window = { location: { search: '' } };
    try {
        const dom = initDom();
        dom.setRuntimeModel('native-model', 'high');
        assert.equal(badge.textContent, 'native-model · high');
        assert.equal(badge.title, 'Selected model: native-model · high');
        assert.equal(badge.hidden, false);
        dom.setRuntimeModel('other-model', null);
        assert.equal(badge.textContent, 'other-model');
        dom.setRuntimeModel('legacy-model');
        assert.equal(badge.textContent, 'legacy-model');
        dom.setRuntimeModel(null, null);
        assert.equal(badge.hidden, true);
        assert.equal(badge.textContent, '');
    } finally {
        if (previousDocument === undefined) delete globalThis.document;
        else globalThis.document = previousDocument;
        if (previousWindow === undefined) delete globalThis.window;
        else globalThis.window = previousWindow;
    }
});
