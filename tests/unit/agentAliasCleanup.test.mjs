import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const beforeRoot = process.env.PLOINKY_WORKSPACE_ROOT;
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-alias-cleanup-')));
process.env.PLOINKY_WORKSPACE_ROOT = root;
const { disableAgent, disableAgentContainers } = await import('../../cli/utils/agents.js');
test.after(() => {
    if (beforeRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
    else process.env.PLOINKY_WORKSPACE_ROOT = beforeRoot;
    fs.rmSync(root, { recursive: true, force: true });
});
let counter = 0;

function fixture({ otherRepo = false, linkOwner = 'one', staticAgent = false, selectedAlias = false } = {}) {
    const agentName = `example${++counter}`;
    const one = `sourceOne${counter}`, two = `sourceTwo${counter}`;
    const source = repo => path.join(root, '.ploinky', 'repos', repo, agentName);
    for (const repo of [one, two]) {
        for (const kind of ['code', 'skills']) {
            const directory = path.join(source(repo), kind);
            fs.mkdirSync(directory, { recursive: true });
            fs.writeFileSync(path.join(directory, 'sentinel'), `${repo}:${kind}`);
        }
        fs.writeFileSync(path.join(source(repo), 'manifest.json'), '{}');
    }
    const links = ['code', 'skills'].map(kind => {
        const lookup = path.join(root, '.ploinky', kind, agentName);
        fs.mkdirSync(path.dirname(lookup), { recursive: true });
        fs.symlinkSync(path.join(source(linkOwner === 'two' ? two : one), kind), lookup);
        return { path: lookup, target: fs.readlinkSync(lookup), inode: fs.lstatSync(lookup).ino,
            bytes: fs.readFileSync(path.join(lookup, 'sentinel'), 'utf8') };
    });
    const record = (repoName, alias = '') => ({ type: 'agent', repoName, agentName, alias,
        instanceId: `${repoName}-${alias || 'primary'}`, enableGeneration: 'generation', auth: { mode: 'none' } });
    let registry = {
        primary: record(otherRepo ? two : one),
        alias_a: record(one, 'alias-a'),
        alias_b: record(one, 'alias-b'),
        ...(staticAgent ? { _config: { static: { agent: selectedAlias ? 'alias-a' : `${otherRepo ? two : one}/${agentName}`, port: 8080 }, preserved: true } } : {}),
    };
    let routing = { port: 8080, routes: Object.fromEntries(Object.entries(registry)
        .filter(([, item]) => item.type === 'agent')
        .map(([name, item]) => [item.alias || agentName, { container: name, repo: item.repoName, agent: agentName,
            ...(item.alias ? { alias: item.alias } : {}) }])) };
    const existing = new Set(['primary', 'alias_a', 'alias_b']);
    const removed = [];
    const lease = { transactionId: 'fixture', preparedGeneration: 'generation' };
    const dependencies = {
        loadAgentsImpl: () => registry,
        saveAgentsImpl: next => { registry = structuredClone(next); },
        readRoutingImpl: () => structuredClone(routing),
        writeRoutingImpl: next => { routing = structuredClone(next); },
        inactivateGeneration() {}, retireNoWaitMarkersImpl: () => [],
        withApplyLock: callback => callback({ fixture: true }),
        prepareGeneration: () => ({ selector: { state: 'inactive' }, preparationLease: lease }),
        applyGeneration: () => ({ selector: { state: 'active' } }), abortPreparation() {},
        isSandboxRuntimeImpl: () => false,
        stopAndRemoveImpl: name => { removed.push(name); existing.delete(name); },
        stopAndRemoveManyImpl: names => { for (const name of names) { removed.push(name); existing.delete(name); } },
        containerExistsImpl: name => existing.has(name),
    };
    return { agentName, one, two, source, links, dependencies, removed,
        registry: () => registry, routing: () => routing };
}

function linksPreserved(f) {
    for (const link of f.links) {
        assert.equal(fs.readlinkSync(link.path), link.target);
        assert.equal(fs.lstatSync(link.path).ino, link.inode);
        assert.equal(fs.readFileSync(path.join(link.path, 'sentinel'), 'utf8'), link.bytes);
    }
}

test('single alias disable preserves both shared source lookups and the configured primary', () => {
    const f = fixture({ staticAgent: true });
    f.registry()._config.static.agent = f.agentName;
    const primary = structuredClone(f.registry().primary), config = structuredClone(f.registry()._config);
    assert.equal(disableAgent('alias-a', f.dependencies).status, 'removed');
    linksPreserved(f);
    assert.deepEqual(f.registry().primary, primary);
    assert.deepEqual(f.registry()._config, config);
    assert.ok(f.registry().alias_b);
    assert.deepEqual(f.removed, ['alias_a']);
});

test('disabling the exact primary clears static selection while surviving aliases retain their lookups', () => {
    const f = fixture({ staticAgent: true });
    f.registry()._config.static.agent = f.agentName;
    disableAgent('primary', f.dependencies);
    assert.deepEqual(f.registry()._config, { preserved: true });
    assert.ok(f.registry().alias_a && f.registry().alias_b);
    linksPreserved(f);
});

test('batch alias disable preserves the primary lookups; disabling the final owner removes only its links', () => {
    const f = fixture({ staticAgent: true });
    const config = structuredClone(f.registry()._config);
    disableAgentContainers(['alias_a', 'alias_b'], f.dependencies);
    linksPreserved(f);
    assert.deepEqual(f.registry()._config, config);
    assert.ok(f.registry().primary);
    assert.equal(disableAgent('primary', f.dependencies).status, 'removed');
    assert.deepEqual(f.registry()._config, { preserved: true });
    for (const link of f.links) {
        assert.equal(fs.lstatSync(link.path, { throwIfNoEntry: false }), undefined);
        assert.equal(fs.readFileSync(path.join(link.target, 'sentinel'), 'utf8'), link.bytes);
    }
});

test('last owner cleanup does not remove another repository same-name lookup', () => {
    const f = fixture({ otherRepo: true, linkOwner: 'two' });
    disableAgentContainers(['alias_a', 'alias_b'], f.dependencies);
    linksPreserved(f);
    assert.equal(f.registry().primary.repoName, f.two);
});

test('an unrelated same-name registration does not retain a removed source owned lookup', () => {
    const f = fixture({ otherRepo: true, linkOwner: 'one' });
    disableAgentContainers(['alias_a', 'alias_b'], f.dependencies);
    assert.equal(f.registry().primary.repoName, f.two);
    for (const link of f.links) assert.equal(fs.lstatSync(link.path, { throwIfNoEntry: false }), undefined);
});

test('a registered repository alias of the same physical source retains the shared lookups', () => {
    const f = fixture({ otherRepo: true, linkOwner: 'one' });
    const aliasRoot = path.dirname(f.source(f.two));
    fs.rmSync(aliasRoot, { recursive: true });
    fs.symlinkSync(path.dirname(f.source(f.one)), aliasRoot);
    disableAgentContainers(['alias_a', 'alias_b'], f.dependencies);
    linksPreserved(f);
});

test('an explicitly selected static alias is cleared only when that registration is disabled', () => {
    const f = fixture({ staticAgent: true, selectedAlias: true });
    disableAgent('alias-b', f.dependencies);
    assert.equal(f.registry()._config.static.agent, 'alias-a');
    disableAgentContainers(['alias_a'], f.dependencies);
    assert.deepEqual(f.registry()._config, { preserved: true });
    linksPreserved(f);
});

test('removing aliases does not clear a configured ordinary primary that is currently stopped and unregistered', () => {
    const f = fixture({ staticAgent: true });
    delete f.registry().primary;
    const selection = structuredClone(f.registry()._config.static);
    disableAgent('alias-b', f.dependencies);
    disableAgent('alias-a', f.dependencies);
    assert.deepEqual(f.registry()._config.static, selection);
});

function normalizedStaticAliasFixture() {
    const f = fixture({ staticAgent: true });
    delete f.registry().primary;
    delete f.registry().alias_b;
    delete f.routing().routes[f.agentName];
    delete f.routing().routes['alias-b'];
    // startWorkspace stores the qualified source after resolving an alias;
    // routing.json retains the actual selected alias container.
    f.routing().static = { agent: `${f.one}/${f.agentName}`, container: 'alias_a' };
    return f;
}

for (const mode of ['single', 'batch']) {
    test(`${mode} disable clears a normalized static alias selected by normal workspace start`, () => {
        const f = normalizedStaticAliasFixture();
        if (mode === 'single') disableAgent('alias-a', f.dependencies);
        else disableAgentContainers(['alias_a'], f.dependencies);
        assert.deepEqual(f.registry()._config, { preserved: true });
        assert.equal(f.routing().static, undefined);
        assert.equal(f.registry().alias_a, undefined);
        assert.deepEqual(f.removed, ['alias_a']);
    });

    for (const target of ['primary', 'alias_a']) {
        test(`${mode} disable attributes normalized static selection to its routed alias after enabling a primary: ${target}`, () => {
            const f = fixture({ staticAgent: true });
            f.routing().static = { agent: `${f.one}/${f.agentName}`, container: 'alias_a' };
            const selection = structuredClone(f.registry()._config.static);
            if (mode === 'single') disableAgent(target, f.dependencies);
            else disableAgentContainers([target], f.dependencies);
            if (target === 'primary') {
                assert.deepEqual(f.registry()._config.static, selection);
                assert.equal(f.routing().static.container, 'alias_a');
                assert.ok(f.registry().alias_a);
            } else {
                assert.deepEqual(f.registry()._config, { preserved: true });
                assert.equal(f.routing().static, undefined);
                assert.ok(f.registry().primary);
            }
            linksPreserved(f);
            assert.deepEqual(f.removed, [target]);
        });
    }
}

for (const [name, alter] of [
    ['foreign static source', f => { f.routing().static.agent = `${f.two}/${f.agentName}`; }],
    ['foreign route source', f => { f.routing().routes['alias-a'].repo = f.two; }],
    ['foreign route alias', f => { f.routing().routes['alias-a'].alias = 'alias-b'; }],
    ['stale route container', f => { f.routing().routes['alias-a'].container = 'old_alias_a'; }],
    ['missing route', f => { delete f.routing().routes['alias-a']; }],
]) {
    test(`a ${name} cannot attribute a configured primary to an alias`, () => {
        const f = normalizedStaticAliasFixture();
        alter(f);
        const selection = structuredClone(f.registry()._config.static);
        disableAgent('alias-a', f.dependencies);
        assert.deepEqual(f.registry()._config.static, selection);
    });
}
