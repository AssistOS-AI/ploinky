import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { createSessionSettingsController, normalizeSessionSettingsAction } from '../../cli/server/webchat/sessionSettings.js';
import { parseWebchatSessionState, serializeSessionStateSseEvent } from '../../cli/server/handlers/webchat/runtimeState.js';

const origin = 'https://workspace.example';
const action = { label: 'Conversation settings', href: '/app/settings?conversation=saved#settings' };
const event = (id, extra = {}) => ({ event: 'selected', session: { sessionId: id }, summary: { sessionId: id }, settingsAction: action, ...extra });

test('agent-provided conversation navigation follows selected session and clears stale actions', () => {
    const link = { removeAttribute(name) { delete this[name]; } };
    const controller = createSessionSettingsController({ link, origin });
    assert.equal(link.hidden, true);
    controller.handleSessionState(event('a'), 'a');
    assert.equal(link.href, action.href);
    assert.equal(link.textContent, action.label);
    assert.equal(link.target, '_blank');
    assert.equal(link.rel, 'noopener noreferrer');
    controller.handleSessionState(event('background', { event: 'updated', settingsAction: { ...action, href: '/wrong' } }), 'a');
    assert.equal(link.href, action.href);
    controller.handleSessionState(event('b', { settingsAction: undefined }), 'b');
    assert.equal(link.hidden, true);
    assert.equal(link.href, undefined);
    controller.handleSessionState(event('b', { settingsAction: { label: '<img src=x>', href: '/valid' } }), 'b');
    assert.equal(link.textContent, '<img src=x>');
    controller.handleSessionState(event('b', { settingsAction: { ...action, href: 'javascript:alert(1)' } }), 'b');
    assert.equal(link.hidden, true);
    controller.handleSessionState(event('b', { session: { sessionId: 'other' } }), 'b');
    assert.equal(link.hidden, true);
    assert.equal(link.href, undefined);
});

test('conversation navigation rejects external origins, credentials, script schemes and malformed paths', () => {
    for (const href of ['https://evil.example/', '//evil.example/', '/\\evil.example/', 'javascript:alert(1)', 'data:text/html,x',
        'https://user:password@workspace.example/', '/valid\npath', '/valid path', '', '#settings', '/\u0000']) {
        assert.equal(normalizeSessionSettingsAction({ ...action, href }, origin), null, href);
    }
    assert.deepEqual(normalizeSessionSettingsAction(action, origin), action);
    assert.equal(normalizeSessionSettingsAction({ ...action, label: '' }, origin), null);
});

test('production WebChat menu and session event handler expose the generic action', async () => {
    const client = new URL('../../cli/server/webchat/', import.meta.url);
    const [html, index, dom, css] = await Promise.all(['chat.html', 'index.js', 'domSetup.js', 'webchat.css'].map((name) => fs.readFile(new URL(name, client), 'utf8')));
    assert.match(html, /id="sessionSettingsLink" data-menu-action hidden/);
    assert.match(dom, /sessionSettingsLink: document\.getElementById\('sessionSettingsLink'\)/);
    assert.match(index, /sessionSettingsController\.handleSessionState\(payload, selected\)/);
    assert.match(css, /\.wa-session-settings-link\[hidden\]\s*\{\s*display: none/);
    const controller = await fs.readFile(new URL('sessionSettings.js', client), 'utf8');
    assert.doesNotMatch(controller, /roboTeamAgent|copilot-session|list_achilles_skills/);
});

test('session settings survive the production protocol parser and SSE serializer without extra metadata', () => {
    const sessionId = 'caa7d510-d4a7-4e82-bb74-4c1b2e1c74fd';
    const timestamps = { createdAt: '2026-09-10T00:00:00Z', updatedAt: '2026-09-10T00:00:00Z' };
    const envelope = { __webchatSession: 1, version: 1, event: 'current',
        session: { sessionId, messages: [], ...timestamps }, summary: { sessionId, hasHistory: false, ...timestamps },
        settingsAction: { ...action, secret: 'must-not-forward' } };
    const state = parseWebchatSessionState(envelope);
    assert.deepEqual(state.settingsAction, action);
    const sse = serializeSessionStateSseEvent(state);
    const payload = JSON.parse(sse.split('\ndata: ')[1]);
    assert.deepEqual(payload.settingsAction, action);
    assert.doesNotMatch(sse, /must-not-forward/);
    const link = { removeAttribute(name) { delete this[name]; } };
    createSessionSettingsController({ link, origin }).handleSessionState(payload, sessionId);
    assert.equal(link.href, action.href);
    assert.equal(parseWebchatSessionState({ ...envelope, settingsAction: { ...action, href: '//evil.example' } }).settingsAction, undefined);
    assert.equal(parseWebchatSessionState({ ...envelope, summary: { sessionId: 'dba7d510-d4a7-4e82-bb74-4c1b2e1c74fd' } }), undefined);
});
