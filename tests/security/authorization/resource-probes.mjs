import assert from 'node:assert/strict';
import path from 'node:path';

// References are relative to the pinned AssistOSExplorer source checkout.
export const resourceProbeSources = Object.freeze({
    confidential: 'dpuAgent/lib/dpu-store.mjs:1206-1486',
    confidentialPolicy: 'dpuAgent/lib/dpu-store.mjs:463-517',
    tasks: 'tasksAgent/tools/tasks_tool.mjs:110-134,429-692',
    files: 'explorer/utils/server/tool-handlers.mjs:606-755',
    rooms: 'webmeetAgent/lib/webmeetStore.mjs:461-518; webmeetAgent/lib/services/roomDeletion.mjs:7-40',
    roomPolicy: 'webmeetAgent/lib/store/accessPolicy.mjs:43-53,109-128',
    git: 'gitAgent/tools/git_tool.mjs:104-130',
    mcp: 'tests/smoke/lib/mcp.mjs:1-115',
});

function header(response, name) {
    return response.headers?.get?.(name) || response.headers?.[name] || '';
}

export function decodeResourceMcp(response) {
    const rpc = response.json;
    const result = rpc?.result;
    const blocks = Array.isArray(result?.content) ? result.content : [];
    const jsonValues = blocks.filter((entry) => entry?.type === 'json').map((entry) => entry.json);
    const texts = blocks.filter((entry) => entry?.type === 'text' && typeof entry.text === 'string').map((entry) => entry.text);
    let stdout;
    if (texts.length) {
        // AgentServer emits stdout first, then a separate stderr block when present.
        try { stdout = JSON.parse(texts[0]); } catch { stdout = { rawText: texts[0] }; }
    }
    const values = [result, result?.structuredContent, ...jsonValues, stdout];
    const value = result?.structuredContent ?? jsonValues[0] ?? stdout ?? result;
    const resultShapeValid = result && typeof result === 'object' && !Array.isArray(result)
        && (Array.isArray(result.content) || result.structuredContent !== undefined || typeof result.protocolVersion === 'string');
    const errorText = (error) => typeof error === 'string' ? error : error ? JSON.stringify(error) : '';
    return {
        response,
        value,
        failed: response.status < 200 || response.status >= 300 || Boolean(rpc?.error)
            || !resultShapeValid
            || values.some((entry) => entry?.ok === false || entry?.isError === true),
        error: [typeof rpc?.error === 'string' ? rpc.error : rpc?.error?.message,
            ...values.map((entry) => errorText(entry?.error)), result?.isError ? texts.join('\n') : '']
            .filter(Boolean).join(' '),
    };
}

function assertAllowed(result, label) {
    assert.equal(result.failed, false, `${label}: authorized positive control failed (HTTP ${result.response.status})`);
    assert.ok(result.value !== undefined, `${label}: successful HTTP response lacks an MCP result`);
    return result.value;
}

export function assertResourceDenied(result, label, marker = '') {
    const serialized = JSON.stringify([result.value, result.response.json, result.response.text]);
    if (marker) assert.ok(!serialized.includes(marker), `${label}: protected fixture content leaked`);
    assert.ok(result.failed, `${label}: forbidden operation succeeded`);
    // Redirects, missing methods/resources, and infrastructure failures never establish authorization.
    assert.ok(![301, 302, 303, 307, 308, 404, 405, 502, 503, 504].includes(result.response.status),
        `${label}: redirect, missing endpoint, or unavailable backend is not authorization evidence`);
    const authFailure = /access.denied|forbidden|unauthenticated|unauthorized|authentication.{0,35}required|only.{0,25}(admin|owner)|missing.{0,25}(capability|permission)|permission.denied|not.authorized|cannot.access/i;
    const httpError = result.response.json?.error || result.response.json?.message || result.response.json?.reason;
    assert.ok(([401, 403].includes(result.response.status) && httpError && /auth|denied|forbidden|capability|csrf|origin/i.test(JSON.stringify(httpError))) || authFailure.test(result.error),
        `${label}: failure lacks a specific authorization decision`);
}

export function createResourceMcp(ctx) {
    const sessions = new Map();
    let sequence = 0;
    // Register before any resource fixtures: the harness cleans up in reverse order,
    // so fixture teardown retains its sessions until all owned resources are removed.
    ctx.cleanup(async () => {
        const failures = [];
        for (const [key, session] of sessions) {
            try {
                await ctx.guard();
                const response = await ctx.request(session.principal, {
                    method: 'DELETE', path: session.endpoint, headers: session.headers,
                });
                const alreadyClosed = response.status === 404 && response.json?.error?.code === -32001
                    && response.json.error.message === 'Session not found';
                assert.ok(([200, 202, 204].includes(response.status) && !response.json?.error) || alreadyClosed,
                    `MCP session cleanup failed for ${key} (HTTP ${response.status})`);
                sessions.delete(key);
            } catch (error) { failures.push(error); }
        }
        if (failures.length) throw new AggregateError(failures, `${failures.length} resource MCP session cleanup(s) failed`);
    });
    return async (principal, agent, tool, args = {}, extra = {}) => {
        const endpoint = `/${encodeURIComponent(agent)}/mcp`;
        const key = `${principal}:${agent}`;
        let session = sessions.get(key);
        if (!session) {
            const headers = {
                accept: 'application/json, text/event-stream',
                'content-type': 'application/json',
            };
            if (principal !== 'anonymous') {
                const proofResponse = await ctx.request(principal, {
                    method: 'GET', path: `/auth/token?agent=${encodeURIComponent(agent)}`,
                });
                // A failed proof bootstrap is a harness prerequisite failure, not
                // evidence that the intended agent route denied this principal.
                assert.equal(proofResponse.status, 200, 'MCP browser proof bootstrap failed');
                const proof = proofResponse.json?.browserMutation;
                assert.equal(proof?.routeKey, agent, 'MCP browser proof is bound to a different route');
                assert.ok(typeof proof?.csrfToken === 'string' && proof.csrfToken, 'MCP browser proof is missing');
                ctx.secrets.add(proof.csrfToken);
                headers['x-ploinky-browser-csrf-token'] = proof.csrfToken;
            }
            const init = await ctx.request(principal, {
                method: 'POST', path: endpoint, headers,
                body: {
                    jsonrpc: '2.0', id: `resource-init-${++sequence}`, method: 'initialize',
                    params: { protocolVersion: '2025-06-18', capabilities: {},
                        clientInfo: { name: 'authorization-regression', version: '1.0.0' } },
                },
            });
            const initialized = decodeResourceMcp(init);
            if (initialized.failed) return initialized;
            const sessionId = header(init, 'mcp-session-id');
            assert.ok(typeof sessionId === 'string' && sessionId, 'MCP initialize returned no session identity');
            ctx.secrets.add(sessionId);
            session = { principal, endpoint, headers: { ...headers, 'mcp-session-id': sessionId,
                'mcp-protocol-version': init.json?.result?.protocolVersion || '2025-06-18' } };
            sessions.set(key, session);
        }
        const response = await ctx.request(principal, {
            method: 'POST', path: endpoint, headers: { ...session.headers, ...(extra.headers || {}) },
            body: { jsonrpc: '2.0', id: `resource-call-${++sequence}`, method: 'tools/call',
                params: { name: tool, arguments: args, ...(extra.params || {}) }, ...(extra.envelope || {}) },
        });
        return decodeResourceMcp(response);
    };
}

async function confidentialProbes(ctx, mcp) {
    let object;
    let otherActor;
    const marker = `${ctx.prefix}-confidential-content`;
    await ctx.check('resource.dpu.owner-fixture', async () => {
        const who = assertAllowed(await mcp('userB', 'dpuAgent', 'dpu_whoami'), 'DPU second ordinary identity');
        assert.equal(who.authenticated, true);
        assert.ok(who.actor?.principalId);
        otherActor = who.actor.principalId;
        await ctx.guard();
        const created = assertAllowed(await mcp('userA', 'dpuAgent', 'dpu_confidential_create', {
            type: 'file', name: `${ctx.prefix}.txt`, content: marker, mimeType: 'text/plain',
        }), 'owner creates confidential file');
        object = created.object;
        assert.ok(object?.id, 'Confidential create returned no object ID');
        ctx.cleanup(async () => {
            await ctx.guard();
            const current = assertAllowed(await mcp('userA', 'dpuAgent', 'dpu_confidential_get', { id: object.id }), 'owned confidential cleanup identity');
            assert.equal(current.object.id, object.id);
            assert.equal(current.object.ownerId, object.ownerId);
            assertAllowed(await mcp('userA', 'dpuAgent', 'dpu_confidential_delete', { id: object.id }), 'owned confidential cleanup');
        });
        assert.equal(object.content, marker);
        assert.notEqual(object.ownerId, otherActor, 'Horizontal principals must be different');
        const read = assertAllowed(await mcp('userA', 'dpuAgent', 'dpu_confidential_get', { id: object.id }), 'owner reads existing confidential file');
        assert.equal(read.object.content, marker);
    });
    if (!object?.id || !otherActor) {
        ctx.recordGap('resource.dpu.idor', 'Owner fixture did not initialize; no missing-resource denial is counted.');
        return;
    }
    for (const principal of ['anonymous', 'selfRegistered', 'userB']) {
        await ctx.check(`resource.dpu.${principal}.read`, async () => {
            const response = await mcp(principal, 'dpuAgent', 'dpu_confidential_get', { id: object.id });
            assertResourceDenied(response, `${principal} reads another user confidential ID`, marker);
        });
        await ctx.check(`resource.dpu.${principal}.update`, async () => {
            await ctx.guard();
            const response = await mcp(principal, 'dpuAgent', 'dpu_confidential_update', {
                id: object.id, content: `${ctx.prefix}-unauthorized-change`,
            });
            const after = assertAllowed(await mcp('userA', 'dpuAgent', 'dpu_confidential_get', { id: object.id }), 'owner verifies denied write effects');
            assert.equal(after.object.content, marker, 'Forbidden confidential update changed persisted content');
            assertResourceDenied(response, `${principal} updates another user confidential ID`, marker);
        });
    }
    await ctx.check('resource.dpu.userB.forged-identity', async () => {
        const response = await mcp('userB', 'dpuAgent', 'dpu_confidential_get', {
            id: object.id, principalId: object.ownerId, ownerId: object.ownerId,
            user: { id: object.ownerId.replace(/^user:/, ''), roles: ['admin'] },
        }, { headers: { 'x-ploinky-user-id': object.ownerId, 'x-ploinky-user-roles': 'admin' },
            envelope: { metadata: { auth: { principalId: object.ownerId, roles: ['admin'] } } } });
        assertResourceDenied(response, 'Forged caller identity cannot read owner confidential ID', marker);
    });
    await ctx.check('resource.dpu.userB.delete', async () => {
        await ctx.guard();
        const response = await mcp('userB', 'dpuAgent', 'dpu_confidential_delete', { id: object.id });
        const after = assertAllowed(await mcp('userA', 'dpuAgent', 'dpu_confidential_get', { id: object.id }), 'owner verifies denied deletion');
        assert.equal(after.object.content, marker);
        assertResourceDenied(response, 'Other ordinary user deletes confidential ID');
    });
    await ctx.check('resource.dpu.read-grant-and-revocation', async () => {
        await ctx.guard();
        assertAllowed(await mcp('userA', 'dpuAgent', 'dpu_confidential_grant', {
            id: object.id, principal: otherActor, role: 'read',
        }), 'owner grants read on test object');
        try {
            const granted = assertAllowed(await mcp('userB', 'dpuAgent', 'dpu_confidential_get', { id: object.id }), 'explicit recipient read');
            assert.equal(granted.object.content, marker);
            assert.equal(granted.object.canWrite, false);
            const escalation = await mcp('userB', 'dpuAgent', 'dpu_confidential_grant', {
                id: object.id, principal: otherActor, role: 'write',
            });
            assertResourceDenied(escalation, 'Read recipient cannot escalate own ACL');
        } finally {
            await ctx.guard();
            assertAllowed(await mcp('userA', 'dpuAgent', 'dpu_confidential_revoke', {
                id: object.id, principal: otherActor,
            }), 'owner revokes test object grant');
        }
        // Reuse the same live MCP session to catch stale cached authorization.
        assertResourceDenied(await mcp('userB', 'dpuAgent', 'dpu_confidential_get', { id: object.id }),
            'Existing recipient session after ACL revocation', marker);
    });
}

async function workspaceProbes(ctx, mcp) {
    let root;
    let directory;
    let file;
    let task;
    let fixtureReady = false;
    const marker = `${ctx.prefix}-workspace-content`;
    await ctx.check('resource.files.owner-fixture', async () => {
        const dirs = assertAllowed(await mcp('userA', 'explorer', 'list_allowed_directories'), 'workspace roots');
        const roots = String(dirs.rawText || '').split('\n').filter((entry) => entry.startsWith('/'));
        assert.ok(roots.length, 'Explorer did not return an allowed root');
        root = roots[0];
        directory = path.posix.join(root, ctx.prefix);
        file = path.posix.join(directory, 'fixture.txt');
        await ctx.guard();
        assertAllowed(await mcp('userA', 'explorer', 'create_directory', { path: directory }), 'create test workspace directory');
        ctx.cleanup(async () => {
            assert.equal(path.posix.dirname(directory), root);
            assert.equal(path.posix.basename(directory), ctx.prefix);
            await ctx.guard();
            assertAllowed(await mcp('userA', 'explorer', 'delete_directory', { path: directory }), 'test workspace directory cleanup');
        });
        assertAllowed(await mcp('userA', 'explorer', 'write_file', { path: file, content: marker }), 'owner writes workspace fixture');
        const read = assertAllowed(await mcp('userA', 'explorer', 'read_text_file', { path: file }), 'owner reads workspace fixture');
        assert.equal(read.rawText, marker);
        fixtureReady = true;
    });
    if (!fixtureReady) {
        ctx.recordGap('resource.files-and-tasks', 'Workspace fixture unavailable; dependent assertions not attempted.');
        return;
    }
    await ctx.check('resource.files.shared-ordinary-positive', async () => {
        const read = assertAllowed(await mcp('userB', 'explorer', 'read_text_file', { path: file }), 'second ordinary user reads shared workspace file');
        assert.equal(read.rawText, marker);
    });
    for (const principal of ['anonymous', 'selfRegistered']) {
        await ctx.check(`resource.files.${principal}.read`, async () => {
            assertResourceDenied(await mcp(principal, 'explorer', 'read_text_file', { path: file }), `${principal} reads existing workspace file`, marker);
        });
        await ctx.check(`resource.files.${principal}.write`, async () => {
            await ctx.guard();
            const response = await mcp(principal, 'explorer', 'write_file', { path: file, content: `${ctx.prefix}-forbidden` });
            const after = assertAllowed(await mcp('userA', 'explorer', 'read_text_file', { path: file }), 'check denied workspace write');
            assert.equal(after.rawText, marker, 'Forbidden workspace write changed persisted content');
            assertResourceDenied(response, `${principal} overwrites existing workspace file`);
        });
    }
    const backlogPath = path.posix.join(directory, 'fixture.backlog');
    await ctx.check('resource.tasks.owner-fixture', async () => {
        await ctx.guard();
        const created = assertAllowed(await mcp('userA', 'tasksAgent', 'task_create', {
            repoPath: directory, backlogPath, description: marker,
        }), 'ordinary user creates bounded backlog fixture');
        task = created.task;
        assert.ok(task?.id, 'Task create returned no task ID');
        const read = assertAllowed(await mcp('userA', 'tasksAgent', 'task_get', { repoPath: directory, backlogPath, id: task.id }), 'owner reads existing task');
        assert.equal(read.task.description, marker);
    });
    if (task?.id) {
        await ctx.check('resource.tasks.shared-ordinary-positive', async () => {
            const other = assertAllowed(await mcp('userB', 'tasksAgent', 'task_get', { repoPath: directory, backlogPath, id: task.id }), 'second ordinary user reads shared backlog');
            assert.equal(other.task.description, marker);
        });
        for (const principal of ['anonymous', 'selfRegistered']) {
            await ctx.check(`resource.tasks.${principal}.get`, async () => {
                assertResourceDenied(await mcp(principal, 'tasksAgent', 'task_get', { repoPath: directory, backlogPath, id: task.id }), `${principal} reads existing task`, marker);
            });
            await ctx.check(`resource.tasks.${principal}.update`, async () => {
                await ctx.guard();
                const response = await mcp(principal, 'tasksAgent', 'task_update', { repoPath: directory, backlogPath, id: task.id, description: `${ctx.prefix}-forbidden` });
                const after = assertAllowed(await mcp('userA', 'tasksAgent', 'task_get', { repoPath: directory, backlogPath, id: task.id }), 'owner verifies denied task mutation');
                assert.equal(after.task.description, marker, 'Forbidden task update changed persisted content');
                assertResourceDenied(response, `${principal} updates existing task`);
            });
        }
        await ctx.check('resource.tasks.argument-root-boundary', async () => {
            const child = path.posix.join(directory, 'child');
            await ctx.guard();
            assertAllowed(await mcp('userA', 'explorer', 'create_directory', { path: child }), 'create test-owned path boundary root');
            // Existing child root and existing parent backlog distinguish confinement from missing-path failures.
            const response = await mcp('userA', 'tasksAgent', 'task_get', {
                repoPath: child, backlogPath: `${child}/../fixture.backlog`, id: task.id,
            });
            assert.equal(response.failed, true, 'Task path boundary accepted an existing parent backlog');
            assert.match(response.error, /must (?:resolve )?(?:be )?inside repoPath/i,
                'Boundary rejection must identify confinement, not missing resources');
            assert.ok(!JSON.stringify(response.value).includes(marker));
        });
    } else {
        ctx.recordGap('resource.tasks.idor', 'Task fixture unavailable; no resource authorization conclusion.');
    }
    let gitFixture;
    await ctx.check('resource.git.local-fixture', async () => {
        await ctx.guard();
        // gitInitRepository only runs local `git init` and `git remote add`.
        // This reserved non-resolving URL is configuration data; no fetch/push is performed.
        const created = assertAllowed(await mcp('userA', 'gitAgent', 'git_init_repository', {
            path: directory, name: 'local-git', remoteUrl: `https://example.invalid/${ctx.prefix}.git`,
        }), 'ordinary user initializes owned local Git fixture');
        assert.equal(created.repoPath, path.posix.join(directory, 'local-git'));
        gitFixture = created.repoPath;
        const ownerStatus = assertAllowed(await mcp('userA', 'gitAgent', 'git_status', {
            path: gitFixture, includeAhead: false,
        }), 'ordinary owner Git status positive');
        assert.equal(ownerStatus.ok, true);
        assert.ok(ownerStatus.status);
    });
    if (gitFixture) {
        await ctx.check('resource.git.shared-ordinary-positive', async () => {
            const result = assertAllowed(await mcp('userB', 'gitAgent', 'git_status', {
                path: gitFixture, includeAhead: false,
            }), 'second ordinary user reads shared repository status');
            assert.equal(result.ok, true);
        });
        for (const principal of ['anonymous', 'selfRegistered']) {
            await ctx.check(`resource.git.${principal}.status`, async () => {
                assertResourceDenied(await mcp(principal, 'gitAgent', 'git_status', {
                    path: gitFixture, includeAhead: false,
                }), `${principal} reads existing Git repository status`);
            });
        }
    } else {
        ctx.recordGap('resource.git.local-fixture', 'Disposable local Git repository unavailable; dependent authorization not asserted.');
    }
    ctx.recordGap('resource.git.remote-and-commands', 'No Git fetch, push, remote provider, commit, arbitrary command or credential operations are performed. Git fixture coverage is local initialization and status only.');
    ctx.recordGap('resource.robots.idor', 'Robot and job ownership require a disposable robot backend; optional browser/desktop image setup is unavailable and no inference or native credential use is authorized.');
    ctx.recordGap('resource.documents.onlyoffice', 'Confidential text object ACL is exercised. OnlyOffice save/share/callback tokens and Automerge document collaboration need separate disposable sessions and are not asserted by this module.');
}

async function roomProbes(ctx, mcp) {
    let room;
    await ctx.check('resource.webmeet.admin-fixture', async () => {
        await ctx.guard();
        room = assertAllowed(await mcp('admin', 'webmeetAgent', 'webmeet_room_create', {
            name: `${ctx.prefix}-room`, roomType: 'team',
        }), 'administrator creates bounded room');
        assert.ok(room.roomId, 'WebMeet create returned no room ID');
        ctx.cleanup(async () => {
            await ctx.guard();
            const current = assertAllowed(await mcp('admin', 'webmeetAgent', 'webmeet_room_get', { roomId: room.roomId }), 'test room cleanup identity');
            assert.ok(JSON.stringify(current).includes(room.roomId), 'Cleanup room identity mismatch');
            assertAllowed(await mcp('admin', 'webmeetAgent', 'webmeet_room_delete', { roomId: room.roomId, confirmed: true }), 'test room cleanup');
        });
        assertAllowed(await mcp('admin', 'webmeetAgent', 'webmeet_room_rename', {
            roomId: room.roomId, name: `${ctx.prefix}-room`,
        }), 'administrator rename positive control');
    });
    if (!room?.roomId) {
        ctx.recordGap('resource.webmeet.authorization', 'Disposable room creation unavailable; dependent probes cannot prove authorization.');
        return;
    }
    for (const principal of ['userA', 'userB']) {
        await ctx.check(`resource.webmeet.${principal}.shared-room-positive`, async () => {
            const result = assertAllowed(await mcp(principal, 'webmeetAgent', 'webmeet_room_get', { roomId: room.roomId }), 'ordinary user reads open shared room');
            assert.ok(JSON.stringify(result).includes(room.roomId));
        });
    }
    for (const principal of ['selfRegistered', 'userA', 'userB']) {
        await ctx.check(`resource.webmeet.${principal}.rename`, async () => {
            await ctx.guard();
            const response = await mcp(principal, 'webmeetAgent', 'webmeet_room_rename', { roomId: room.roomId, name: `${ctx.prefix}-forbidden` });
            const after = assertAllowed(await mcp('admin', 'webmeetAgent', 'webmeet_room_get', { roomId: room.roomId }), 'administrator verifies room rename effects');
            assert.ok(!JSON.stringify(after).includes(`${ctx.prefix}-forbidden`), 'Forbidden rename changed room');
            assertResourceDenied(response, `${principal} renames existing room`);
        });
        await ctx.check(`resource.webmeet.${principal}.delete`, async () => {
            await ctx.guard();
            const response = await mcp(principal, 'webmeetAgent', 'webmeet_room_delete', { roomId: room.roomId, confirmed: true });
            const after = assertAllowed(await mcp('admin', 'webmeetAgent', 'webmeet_room_get', { roomId: room.roomId }), 'administrator verifies room survived denied delete');
            assert.ok(JSON.stringify(after).includes(room.roomId));
            assertResourceDenied(response, `${principal} deletes existing room`);
        });
    }
    ctx.recordGap('resource.webmeet.participant-and-room-data', 'Open team rooms are shared with authenticated ordinary users by executable policy. Participant impersonation, chat edits, media blobs, guest scope and archived-room data need joined participants; this bounded module does not start a room secretary or inference backend.');
}

export async function runResourceProbes(ctx) {
    assert.match(ctx.prefix, /^authz-[a-zA-Z0-9-]+$/, 'Fixture namespace must be explicit and test owned');
    const mcp = createResourceMcp(ctx);
    await confidentialProbes(ctx, mcp);
    await workspaceProbes(ctx, mcp);
    await roomProbes(ctx, mcp);
}
