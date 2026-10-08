// Mandatory offline U6 interaction evidence (r2b_review_codex.md): the pinned
// DPU WebChat cannot raise a pending interaction without inference, so live
// interaction isolation is a recorded limitation. This actual-module fixture
// drives the real /interaction handler (cli/server/handlers/webchat/runtimeRoutes.js)
// with a principal-scoped runtime: the owner resolves its pending interaction
// with the real `interactionId` shape, and another principal replaying the
// copied tab, session and interaction IDs cannot resolve, inject or cancel it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleRuntimeRoute } from '../../../cli/server/handlers/webchat/runtimeRoutes.js';
import { buildRuntimeKey, parseWebchatInteraction, resolveRuntimePrincipal } from '../../../cli/server/handlers/webchat/runtimeState.js';

const effectiveConfig = Object.freeze({ agentName: 'dpu-research', runtimeScope: 'principal' });
const INTERACTION = 'approval_12345678';

function fixture(t) {
    const workspaceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'webchat-interaction-isolation-'));
    t.after(() => fs.rmSync(workspaceDirectory, { recursive: true, force: true }));
    const userA = { user: { id: 'principal-A' }, authMode: 'sso' };
    const userB = { user: { id: 'principal-B' }, authMode: 'sso' };
    const keyA = buildRuntimeKey(workspaceDirectory, effectiveConfig, '', resolveRuntimePrincipal(userA));
    const ttyWrites = [];
    const sseWrites = [];
    const interaction = parseWebchatInteraction({
        __webchatInteraction: 1, version: 1, id: INTERACTION, kind: 'approval', title: 'Approval', message: 'Approve?',
        options: [{ id: 'allow', label: 'Allow' }, { id: 'deny', label: 'Deny' }], defaultOptionId: 'allow',
    });
    const tabA = {
        tty: { write: (value) => ttyWrites.push(value) },
        workspaceDirectory,
        runtimePrincipal: resolveRuntimePrincipal(userA),
        pendingInteractions: new Map([[interaction.id, interaction]]),
        subscribers: new Map([['client-A', { sid: 'sid-A', tabId: 'tab-1', res: { write: (value) => sseWrites.push(value) } }]]),
    };
    const appState = { runtimes: new Map([[keyA, tabA]]), sessions: new Map([['sid-A', { tabs: new Map() }], ['sid-B', { tabs: new Map() }]]) };
    return { workspaceDirectory, appState, tabA, ttyWrites, sseWrites, userA, userB };
}

function postInteraction({ appState, workspaceDirectory, principal, sid, body }) {
    const req = new EventEmitter();
    Object.assign(req, { method: 'POST', headers: { cookie: `webchat_sid=${sid}` }, ...principal });
    const result = { status: null, body: '' };
    const res = { writeHead(status) { result.status = status; }, end(text = '') { result.body = String(text); } };
    handleRuntimeRoute({ pathname: '/interaction', req, res, parsedUrl: new URL('http://localhost/interaction?tabId=tab-1'), appState, workspaceDirectory, effectiveConfig, agentQuery: '' });
    req.emit('data', JSON.stringify(body));
    req.emit('end');
    return result;
}

test('principal interaction: the owner resolves its own pending interaction with interactionId', (t) => {
    const f = fixture(t);
    const owner = postInteraction({ ...f, principal: f.userA, sid: 'sid-A', body: { interactionId: INTERACTION, optionId: 'allow' } });
    assert.equal(owner.status, 204);
    assert.equal(f.ttyWrites.length, 1);
    assert.match(f.ttyWrites[0], /"__webchatInteractionResponse":1/);
    assert.match(f.ttyWrites[0], /"optionId":"allow"/);
    assert.equal(f.tabA.pendingInteractions.size, 0);
    assert.match(f.sseWrites.join(''), /event: interaction-resolved/);
});

test('principal interaction: another principal with copied tab, session and interaction IDs cannot resolve, inject or cancel', (t) => {
    const f = fixture(t);
    for (const [sid, body] of [
        ['sid-B', { interactionId: INTERACTION, optionId: 'allow' }],
        ['sid-A', { interactionId: INTERACTION, optionId: 'deny' }],
        ['sid-A', { interactionId: INTERACTION, cancelled: true }],
        ['sid-B', { interactionId: INTERACTION, response: 'injected' }],
    ]) {
        const result = postInteraction({ ...f, principal: f.userB, sid, body });
        assert.equal(result.status, 409, `copied IDs must resolve only B's own (absent) runtime: ${JSON.stringify(body)}`);
    }
    assert.equal(f.ttyWrites.length, 0, "nothing reached A's runtime");
    assert.equal(f.tabA.pendingInteractions.has(INTERACTION), true, "A's interaction stays pending");
    assert.equal(f.sseWrites.length, 0, "A's stream received nothing");
    // A malformed body (the old probe's `id` shape) is a 400, never isolation evidence.
    const malformed = postInteraction({ ...f, principal: f.userA, sid: 'sid-A', body: { id: INTERACTION, optionId: 'allow' } });
    assert.equal(malformed.status, 400);
    // The owner's control still works afterwards.
    assert.equal(postInteraction({ ...f, principal: f.userA, sid: 'sid-A', body: { interactionId: INTERACTION, optionId: 'deny' } }).status, 204);
});
