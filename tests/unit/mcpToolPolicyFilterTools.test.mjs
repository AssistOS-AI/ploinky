import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// filterTools (MCP tools/list) loads the policy once per call: one store
// version check per call instead of one per tool, with decisions identical to
// per-tool `evaluate`, and a policy change visible on the very next call.

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-mcpft-'));
const originalCwd = process.cwd();
process.chdir(tempDir);

const moduleSuffix = `?t=${Date.now()}`;
const { PolicyStateRepository } = await import(`../../cli/server/policy/PolicyStateRepository.js${moduleSuffix}`);
const { FileSystemPolicyStateStore } = await import(`../../cli/server/policy/FileSystemPolicyStateStore.js${moduleSuffix}`);
const { McpToolPolicy } = await import(`../../cli/server/policy/McpToolPolicy.js${moduleSuffix}`);
const { Caller } = await import(`../../cli/server/policy/Caller.js${moduleSuffix}`);

test.after(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
});

// Spy store: the real filesystem adapter, counting version checks and reads.
class CountingStore extends FileSystemPolicyStateStore {
    constructor(file) {
        super({ file: () => file, coordinate: false });
        this.versionCalls = 0;
        this.readCalls = 0;
    }

    currentVersion() {
        this.versionCalls += 1;
        return super.currentVersion();
    }

    read() {
        this.readCalls += 1;
        return super.read();
    }
}

let fixtureCounter = 0;
function fixture() {
    fixtureCounter += 1;
    const file = path.join(tempDir, `policy-${fixtureCounter}`, 'policy-state.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const store = new CountingStore(file);
    const repo = new PolicyStateRepository({ store });
    const policy = new McpToolPolicy({ repository: repo });
    return { file, store, repo, policy };
}

// A direct, out-of-band write: no repository call and no `invalidate()`.
function writePolicyFile(file, mcpTools) {
    fs.writeFileSync(file, JSON.stringify({ schema: 'router-policy', httpRoutes: [], mcpTools }, null, 2));
}

function mcpEntry(agent, tool, access, extra = {}) {
    return { agent, tool, access, source: 'admin', enabled: true, createdAt: 't', createdBy: 't', updatedAt: 't', updatedBy: 't', ...extra };
}

const USER = new Caller({ kind: 'user', isAdmin: false, roles: ['user'] });
const ADMIN = new Caller({ kind: 'user', isAdmin: true, roles: ['user', 'admin'] });
const GUEST = new Caller({ kind: 'guest', isAdmin: false, roles: ['guest'] });
const AGENT = new Caller({ kind: 'agent', id: 'agent:a/b' });
const NONE = new Caller({ kind: 'none' });
const DELEGATED_MATCHING = new Caller({
    kind: 'agent',
    id: 'agent:Src/source',
    delegatedUser: { id: 'local:alice', username: 'alice', roles: ['user'] },
    delegatedTool: 'authed',
    sourceAgentId: 'agent:Src/source',
});
const DELEGATED_OTHER = new Caller({
    kind: 'agent',
    id: 'agent:Src/source',
    delegatedUser: { id: 'local:alice', username: 'alice', roles: ['user'] },
    delegatedTool: 'onlyB',
    sourceAgentId: 'agent:Src/source',
});

const CALLERS = {
    USER, GUEST, ADMIN, AGENT, NONE, DELEGATED_MATCHING, DELEGATED_OTHER,
};

function names(list) {
    return list.map((tool) => tool.name);
}

test('filterTools over 51 tools makes exactly one store version check per call', () => {
    const { file, store, policy } = fixture();
    const accesses = ['authenticated', 'admin', 'internal'];
    const entries = [];
    const tools = [];
    for (let i = 0; i < 51; i += 1) {
        const tool = `tool_${String(i).padStart(2, '0')}`;
        entries.push(mcpEntry('explorer', tool, accesses[i % 3]));
        tools.push({ name: tool, description: `d${i}` });
    }
    writePolicyFile(file, entries);

    const cold = policy.filterTools('explorer', tools, USER);
    assert.equal(store.versionCalls, 1, 'a cold call checks the version once');
    assert.equal(store.readCalls, 1, 'a cold call reads the document once');
    assert.equal(cold.length, 17);

    store.versionCalls = 0;
    store.readCalls = 0;
    const warm = policy.filterTools('explorer', tools, ADMIN);
    assert.equal(store.versionCalls, 1, 'a warm call still checks the version, once');
    assert.equal(store.readCalls, 0, 'an unchanged version reuses the validated cache');
    assert.equal(warm.length, 34);
});

test('filterTools results equal per-tool evaluate for every caller kind over a mixed fixture', () => {
    const { file, policy } = fixture();
    writePolicyFile(file, [
        mcpEntry('a', 'authed', 'authenticated'),
        mcpEntry('a', 'adminTool', 'admin'),
        mcpEntry('a', 'internalTool', 'internal'),
        mcpEntry('a', 'disabledAuthed', 'authenticated', { enabled: false }),
        mcpEntry('a', 'disabledAdmin', 'admin', { enabled: false }),
        mcpEntry('a', 'disabledInternal', 'internal', { enabled: false }),
        mcpEntry('a', 'shared', 'internal'),
        mcpEntry('b', 'onlyB', 'authenticated'),
        mcpEntry('b', 'shared', 'admin'),
    ]);
    const tools = [
        { name: 'authed' }, { name: 'adminTool' }, { name: 'internalTool' },
        { name: 'disabledAuthed' }, { name: 'disabledAdmin' }, { name: 'disabledInternal' },
        { name: 'missing' }, { name: 'onlyB' }, { name: 'shared' },
        { name: '' }, {}, null, { name: 42 },
    ];
    const reference = (agent, caller) => tools.filter((tool) => {
        const name = typeof tool?.name === 'string' ? tool.name : '';
        return name ? policy.evaluate({ agent, tool: name, caller }).allow : false;
    });

    for (const agent of ['a', 'b', 'c']) {
        for (const [label, caller] of Object.entries(CALLERS)) {
            const filtered = policy.filterTools(agent, tools, caller);
            assert.deepEqual(filtered, reference(agent, caller), `${agent} / ${label}`);
        }
    }

    // Explicit expectations, so the equivalence above is not vacuous.
    const expected = {
        a: {
            USER: ['authed'],
            GUEST: ['authed'],
            ADMIN: ['authed', 'adminTool'],
            AGENT: ['internalTool', 'shared'],
            NONE: [],
            DELEGATED_MATCHING: ['authed'],
            DELEGATED_OTHER: [],
        },
        b: {
            USER: ['onlyB'],
            GUEST: ['onlyB'],
            ADMIN: ['onlyB', 'shared'],
            AGENT: [],
            NONE: [],
            DELEGATED_MATCHING: [],
            DELEGATED_OTHER: ['onlyB'],
        },
    };
    for (const [agent, byCaller] of Object.entries(expected)) {
        for (const [label, want] of Object.entries(byCaller)) {
            assert.deepEqual(names(policy.filterTools(agent, tools, CALLERS[label])), want, `${agent} / ${label}`);
        }
    }
    for (const [label, caller] of Object.entries(CALLERS)) {
        assert.deepEqual(policy.filterTools('c', tools, caller), [], `c / ${label}`);
    }
});

test('an out-of-band policy change is visible on the very next filterTools call', () => {
    const { file, store, policy } = fixture();
    const tools = [{ name: 'deploy' }, { name: 'report' }];
    writePolicyFile(file, [
        mcpEntry('ops', 'deploy', 'authenticated'),
        mcpEntry('ops', 'report', 'admin'),
    ]);
    assert.deepEqual(names(policy.filterTools('ops', tools, USER)), ['deploy']);
    const sizeBefore = fs.statSync(file).size;

    // Revoke `deploy` to admin-only and open `report`, written directly to the
    // file (no repository call, no invalidate) with a different size.
    writePolicyFile(file, [
        mcpEntry('ops', 'deploy', 'admin'),
        mcpEntry('ops', 'report', 'authenticated'),
        mcpEntry('ops', 'extra', 'internal'),
    ]);
    assert.notEqual(fs.statSync(file).size, sizeBefore, 'the second state has a different size');

    store.versionCalls = 0;
    const after = policy.filterTools('ops', tools, USER);
    assert.deepEqual(names(after), ['report'], 'the second call sees the new policy');
    assert.equal(store.versionCalls, 1, 'the call checked the store version');
});

test('a corrupt or unavailable policy store yields an empty tool list', (t) => {
    const errors = t.mock.method(console, 'error', () => {});
    const tools = [{ name: 'authed' }, { name: 'adminTool' }, { name: 'internalTool' }];

    const invalidJson = fixture();
    fs.writeFileSync(invalidJson.file, '{ not valid json');
    const invalidSchema = fixture();
    writePolicyFile(invalidSchema.file, [{ agent: 'a', tool: 'authed', access: 'everyone' }]);
    for (const { policy } of [invalidJson, invalidSchema]) {
        for (const [label, caller] of Object.entries(CALLERS)) {
            assert.deepEqual(policy.filterTools('a', tools, caller), [], label);
        }
        assert.equal(policy.evaluate({ agent: 'a', tool: 'authed', caller: USER }).code, 'POLICY_PERSISTENCE_ERROR');
    }

    const failingStore = {
        versionCalls: 0,
        currentVersion() {
            this.versionCalls += 1;
            throw new Error('store offline');
        },
        read() {
            throw new Error('unreachable');
        },
    };
    const unavailable = new McpToolPolicy({ repository: new PolicyStateRepository({ store: failingStore }) });
    errors.mock.resetCalls();
    for (const [label, caller] of Object.entries(CALLERS)) {
        assert.deepEqual(unavailable.filterTools('a', tools, caller), [], label);
    }
    const callerCount = Object.keys(CALLERS).length;
    assert.equal(failingStore.versionCalls, callerCount, 'one version check per filterTools call');
    assert.equal(errors.mock.callCount(), callerCount, 'the failure is logged once per call, not once per tool');
});
