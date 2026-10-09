import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoomListingFixture, decodeAgentMcp } from './agent-probes.mjs';

const ROOM_ID = 'room_11111111-1111-4111-8111-111111111111';
const OTHER_ID = 'room_22222222-2222-4222-8222-222222222222';
const NAME = 'authz-cleanup-test-listing-room';
const reply = (status, json) => ({ status, json, headers: {}, text: JSON.stringify(json) });
const success = value => ({ ...decodeAgentMcp(reply(200, { result: { content: [{ type: 'text', text: JSON.stringify(value) }] } })), stage: 'tools/call' });
const missing = () => ({ ...decodeAgentMcp(reply(200, { result: { isError: true, content: [{ type: 'text', text: 'Meeting not found.' }] } })), stage: 'tools/call' });

function environment(options = {}) {
    const rooms = new Map((options.baseline || []).map(room => [room.id, { ...room }]));
    const calls = [], cleanups = [], failures = [];
    let attempted = false, deleted = false;
    const ctx = {
        prefix: 'authz-cleanup-test',
        async guard() { calls.push({ guard: true }); },
        cleanup(fn) { cleanups.push(fn); },
        async check(id, fn) { try { await fn(); } catch (error) { failures.push({ id, error }); } },
    };
    const mcp = { async rpc(actor, agent, method, params) {
        assert.equal(actor, 'admin');
        assert.equal(agent, 'webmeetAgent');
        assert.equal(method, 'tools/call');
        calls.push(params);
        if (params.name === 'webmeet_room_list') {
            if (attempted && options.reconcileError) throw options.reconcileError;
            return success({ rooms: [...rooms.values()], canManageRooms: true });
        }
        if (params.name === 'webmeet_room_create') {
            attempted = true;
            rooms.set(ROOM_ID, { id: ROOM_ID, name: params.arguments.name });
            options.afterPersist?.(rooms);
            if (options.createError) throw options.createError;
            return options.createReply || success({ roomId: ROOM_ID, name: params.arguments.name });
        }
        if (params.name === 'webmeet_room_get') {
            if (deleted && options.afterDeleteReply) return options.afterDeleteReply;
            const room = rooms.get(params.arguments.roomId);
            return room ? success({ meeting: room }) : missing();
        }
        if (params.name === 'webmeet_room_delete') {
            assert.equal(params.arguments.confirmed, true);
            if (!options.noopDelete) rooms.delete(params.arguments.roomId);
            deleted = true;
            return options.deleteReply || success({ ok: true, deleted: true, roomId: params.arguments.roomId });
        }
        throw new Error('Unexpected fixture operation');
    } };
    return { ctx, mcp, rooms, calls, cleanups, failures };
}

test('persisted room creation with a lost response still has a reconciled cleanup', async () => {
    for (const options of [
        { createError: new Error('private response artifact write failed after persistence') },
        { createReply: success({}) },
    ]) {
        const state = environment(options);
        assert.equal(await createRoomListingFixture(state.ctx, state.mcp), undefined);
        assert.equal(state.failures.length, 1);
        assert.equal(state.cleanups.length, 1, 'cleanup armed before create');
        await state.cleanups[0]();
        assert.equal(state.rooms.size, 0);
        assert.equal(state.calls.filter(call => call.name === 'webmeet_room_delete').length, 1);
    }
});

test('room deletion must return its exact contract and prove authoritative absence', async () => {
    for (const options of [
        { deleteReply: success({}) },
        { deleteReply: success({ ok: true, deleted: false, roomId: ROOM_ID }) },
        { deleteReply: success({ ok: false, deleted: true, roomId: ROOM_ID }) },
        { deleteReply: success({ ok: true, deleted: true, roomId: OTHER_ID }) },
        { noopDelete: true },
    ]) {
        const state = environment(options);
        assert.ok(await createRoomListingFixture(state.ctx, state.mcp));
        await assert.rejects(state.cleanups[0](), /cleanup delete|cleanup absence/, 'a false contract or retained room cannot count as clean');
    }
});

test('uncertain creation refuses ambiguous, preexisting or unavailable ownership reconciliation', async () => {
    for (const options of [
        { afterPersist(rooms) { rooms.set(OTHER_ID, { id: OTHER_ID, name: NAME }); } },
        { baseline: [{ id: ROOM_ID, name: 'preexisting room' }] },
        { reconcileError: new Error('listing transport failed') },
        { afterPersist(rooms) { rooms.clear(); } },
    ]) {
        const state = environment({ ...options, createError: new Error('lost create response') });
        assert.equal(await createRoomListingFixture(state.ctx, state.mcp), undefined);
        assert.equal(state.cleanups.length, 1);
        await assert.rejects(state.cleanups[0]());
        assert.equal(state.calls.some(call => call.name === 'webmeet_room_delete'), false);
    }
});

test('cleanup refuses a mismatched name on the authoritative get even after listing reconciliation', async () => {
    const state = environment();
    assert.ok(await createRoomListingFixture(state.ctx, state.mcp));
    const mcpRpc = state.mcp.rpc;
    state.mcp.rpc = async (...args) => args[3].name === 'webmeet_room_get'
        ? success({ meeting: { id: ROOM_ID, name: 'someone else' } }) : mcpRpc(...args);
    await assert.rejects(state.cleanups[0](), /name mismatch/);
    assert.equal(state.calls.some(call => call.name === 'webmeet_room_delete'), false);
});

test('room fixture refuses a preexisting run name before attempting creation', async () => {
    const state = environment({ baseline: [{ id: OTHER_ID, name: NAME }] });
    assert.equal(await createRoomListingFixture(state.ctx, state.mcp), undefined);
    assert.equal(state.failures.length, 1);
    assert.equal(state.calls.some(call => call.name === 'webmeet_room_create'), false);
    assert.equal(state.calls.some(call => call.name === 'webmeet_room_delete'), false);
});

test('cleanup cannot use authentication, transport, initialization or generic errors as room absence', async () => {
    for (const afterDeleteReply of [
        { ...decodeAgentMcp(reply(403, { error: 'forbidden' })), stage: 'tools/call' },
        { ...decodeAgentMcp(reply(503, { error: 'unavailable' })), stage: 'tools/call' },
        { ...decodeAgentMcp(reply(404, { error: 'Meeting not found.' })), stage: 'tools/call' },
        { ...missing(), stage: 'initialize' },
        { ...decodeAgentMcp(reply(200, { result: { isError: true, content: [{ type: 'text', text: 'not found' }] } })), stage: 'tools/call' },
        { ...decodeAgentMcp(reply(200, { result: { isError: true, content: [{ type: 'text', text: 'MCP error -32003: Meeting not found.' }] } })), stage: 'tools/call' },
        { ...decodeAgentMcp(reply(200, { result: { isError: true, content: [{ type: 'text', text: 'Meeting not found. Authentication required.' }] } })), stage: 'tools/call' },
        success({}),
    ]) {
        const state = environment({ afterDeleteReply });
        assert.ok(await createRoomListingFixture(state.ctx, state.mcp));
        await assert.rejects(state.cleanups[0]());
    }
});

test('cleanup accepts the production SDK InternalError carrier for the exact missing-meeting result', async () => {
    const { types: { McpError, ErrorCode } } = await import('mcp-sdk');
    const message = new McpError(ErrorCode.InternalError, 'Meeting not found.').message;
    const afterDeleteReply = { ...decodeAgentMcp(reply(200, { result: { isError: true, content: [{ type: 'text', text: message }] } })), stage: 'tools/call' };
    const state = environment({ afterDeleteReply });
    assert.ok(await createRoomListingFixture(state.ctx, state.mcp));
    await state.cleanups[0]();
    assert.equal(state.rooms.size, 0);
});

test('successful fixture cleanup removes only the owned room and is safe to call again', async () => {
    const state = environment({ baseline: [{ id: OTHER_ID, name: 'preexisting room' }] });
    assert.ok(await createRoomListingFixture(state.ctx, state.mcp));
    await state.cleanups[0]();
    assert.deepEqual([...state.rooms.values()], [{ id: OTHER_ID, name: 'preexisting room' }]);
    await state.cleanups[0]();
    assert.equal(state.calls.filter(call => call.name === 'webmeet_room_delete').length, 1);
    for (const [index, call] of state.calls.entries()) if (call.name) assert.equal(state.calls[index - 1]?.guard, true, 'Every fixture operation must be guarded');
});
