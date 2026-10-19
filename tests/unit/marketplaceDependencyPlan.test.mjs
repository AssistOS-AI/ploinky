import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const originalCwd = process.cwd();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-dependency-plan-'));

function writeManifest(repoName, agentName, manifest = {}) {
    const agentDir = path.join(tempDir, '.ploinky', 'repos', repoName, agentName);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

process.chdir(tempDir);

const graphModule = await import(new URL(`../../cli/utils/workspaceDependencyGraph.js?test=${Date.now()}`, import.meta.url).href);
const { planManifestDependencyEnables } = graphModule;

test.after(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
});

const refs = (entries) => entries.map((entry) => entry.ref);
const plan = (agentRef, options = {}) => planManifestDependencyEnables(agentRef, { onCycle: () => {}, ...options });

test('a no-wait manifest dependency is planned after the root, as the WebMeet manifest declares it', () => {
    writeManifest('wm', 'webmeetAgent', { enable: ['liveKitServerAgent no-wait'] });
    writeManifest('wm', 'liveKitServerAgent');
    const result = plan('wm/webmeetAgent');
    assert.deepEqual(result.before, []);
    assert.deepEqual(result.after, [{ ref: 'wm/liveKitServerAgent', agentRef: 'wm/liveKitServerAgent', alias: '', profile: '', dependsOn: [] }]);
    assert.deepEqual(result.unavailable, []);
});

test('blocking dependencies are planned deepest first and the root is never listed', () => {
    writeManifest('chain', 'root', { enable: ['mid', 'leaf'] });
    writeManifest('chain', 'mid', { enable: ['leaf'] });
    writeManifest('chain', 'leaf');
    const result = plan('chain/root');
    assert.deepEqual(refs(result.before), ['chain/leaf', 'chain/mid']);
    assert.deepEqual(result.after, []);
});

test('a planned dependency names the planned agents it depends on', () => {
    writeManifest('dep', 'root', { enable: ['first no-wait'] });
    writeManifest('dep', 'first', { enable: ['second'] });
    writeManifest('dep', 'second');
    const result = plan('dep/root');
    assert.deepEqual(refs(result.after), ['dep/second', 'dep/first']);
    assert.deepEqual(result.after.map((entry) => entry.dependsOn), [[], ['dep/second']]);
});

test('a dependency cycle terminates and each agent is listed once', () => {
    writeManifest('cyc', 'a', { enable: ['b'] });
    writeManifest('cyc', 'b', { enable: ['a'] });
    const result = plan('cyc/a');
    assert.deepEqual(refs(result.before), ['cyc/b']);
    assert.deepEqual(result.after, []);
});

test('profile enable entries are planned and a directive keeps its own mode, alias and explicit profile', () => {
    writeManifest('prof', 'root', {
        enable: ['modal global', 'named as primary'],
        profiles: { default: { enable: ['fromProfile'] } },
    });
    writeManifest('prof', 'modal');
    writeManifest('prof', 'named', { profiles: { dev: {}, default: {} } });
    writeManifest('prof', 'fromProfile');
    const result = plan('prof/root', { alias: '', profile: '' });
    assert.deepEqual(refs(result.before).sort(), ['prof/fromProfile', 'prof/modal', 'prof/named']);
    const byRef = Object.fromEntries(result.before.map((entry) => [entry.ref, entry]));
    assert.equal(byRef['prof/modal'].agentRef, 'prof/modal global', 'the directive mode travels in the enable spec, not the root mode');
    assert.equal(byRef['prof/named'].alias, 'primary');
    assert.equal(byRef['prof/fromProfile'].profile, '');

    writeManifest('prof', 'explicit', { enable: [{ agent: 'named', profile: 'dev' }] });
    const explicit = plan('prof/explicit');
    assert.equal(explicit.before[0].profile, 'dev');
});

test('an SSO provider dependency is skipped under a non-SSO parent and kept under an SSO one', () => {
    writeManifest('sso', 'provider', { ssoProvider: true });
    writeManifest('sso', 'plainParent', { enable: ['provider', 'helper'] });
    writeManifest('sso', 'ssoParent', { ploinky: 'sso enable', enable: ['provider', 'helper'] });
    writeManifest('sso', 'helper');
    assert.deepEqual(refs(plan('sso/plainParent').before), ['sso/helper']);
    assert.deepEqual(refs(plan('sso/ssoParent').before).sort(), ['sso/helper', 'sso/provider']);
});

test('the SSO gate reads the enabled record, not only the manifest', () => {
    writeManifest('rec', 'provider', { ssoProvider: true });
    writeManifest('rec', 'parent', { enable: ['provider'] });
    assert.deepEqual(plan('rec/parent').before, []);
    const registry = {
        'ploinky_rec_parent': { type: 'agent', repoName: 'rec', agentName: 'parent', auth: { mode: 'sso' } },
    };
    assert.deepEqual(refs(plan('rec/parent', { loadRegistry: () => registry }).before), ['rec/provider']);
});

test('a blocking edge wins over a duplicate no-wait edge to the same agent', () => {
    writeManifest('dup', 'root', { enable: ['dep no-wait'], profiles: { default: { enable: ['dep'] } } });
    writeManifest('dup', 'dep');
    const result = plan('dup/root');
    assert.deepEqual(refs(result.before), ['dup/dep']);
    assert.deepEqual(result.after, []);
});

test('an unresolvable no-wait dependency is reported unavailable and the rest still plans', () => {
    writeManifest('nw', 'root', { enable: ['present', 'absentRepo/absent no-wait'] });
    writeManifest('nw', 'present');
    const result = plan('nw/root');
    assert.deepEqual(refs(result.before), ['nw/present']);
    assert.deepEqual(result.after, []);
    assert.equal(result.unavailable.length, 1);
    assert.equal(result.unavailable[0].ref, 'absentRepo/absent');
    assert.match(result.unavailable[0].error, /absentRepo\/absent/);
});

test('an unresolvable no-wait object directive is reported by its agent, with no alias or no-wait tokens', () => {
    writeManifest('nwo', 'root', {
        enable: [
            { agent: 'absentRepo/gone', noWait: true, alias: 'later' },
            'unqualified-absent as other no-wait',
        ],
    });
    const result = plan('nwo/root');
    assert.deepEqual(result.unavailable.map((entry) => entry.ref), ['absentRepo/gone', 'unqualified-absent']);
});

test('an unresolvable blocking dependency fails the plan with the Marketplace code', () => {
    writeManifest('blk', 'root', { enable: ['absentRepo/absent'] });
    assert.throws(() => plan('blk/root'), { code: 'MARKETPLACE_DEPENDENCY_UNAVAILABLE' });
});

test('a no-wait failure subtree is dropped whole and never turns a later blocking edge into a skipped cycle', () => {
    writeManifest('sub', 'mid', { enable: ['absentRepo/absent'] });
    writeManifest('sub', 'only');
    writeManifest('sub', 'tolerated', { enable: ['mid no-wait'] });
    const tolerated = plan('sub/tolerated');
    assert.deepEqual(tolerated.before, []);
    assert.deepEqual(tolerated.after, []);
    assert.equal(tolerated.unavailable.length, 1);

    // The same broken agent also reached by a blocking edge must fail the plan.
    writeManifest('sub', 'other', { enable: ['mid'] });
    writeManifest('sub', 'strict', { enable: ['mid no-wait', 'other'] });
    assert.throws(() => plan('sub/strict'), { code: 'MARKETPLACE_DEPENDENCY_UNAVAILABLE' });
    writeManifest('sub', 'strictReversed', { enable: ['other', 'mid no-wait'] });
    assert.throws(() => plan('sub/strictReversed'), { code: 'MARKETPLACE_DEPENDENCY_UNAVAILABLE' });
});

test('an unknown root plans nothing so its own enable reports the error', () => {
    assert.deepEqual(plan('nowhere/missing'), { before: [], after: [], unavailable: [] });
});

test('empty and blank manifest enable entries are skipped', () => {
    writeManifest('blank', 'root', { enable: [{}, '   ', '', 'real'] });
    writeManifest('blank', 'real');
    assert.deepEqual(refs(plan('blank/root').before), ['blank/real']);
});

test('the planner reads only: it mutates neither the registry it is given nor the workspace', () => {
    writeManifest('ro', 'root', { enable: ['dep', 'late no-wait'] });
    writeManifest('ro', 'dep');
    writeManifest('ro', 'late');
    const registry = { 'ploinky_ro_dep': { type: 'agent', repoName: 'ro', agentName: 'dep' } };
    const snapshot = JSON.stringify(registry);
    const result = plan('ro/root', { loadRegistry: () => registry });
    assert.deepEqual(refs(result.before), ['ro/dep']);
    assert.deepEqual(refs(result.after), ['ro/late']);
    assert.equal(JSON.stringify(registry), snapshot);
    assert.equal(fs.existsSync(path.join(tempDir, '.ploinky', 'agents.json')), false);
});

test('Marketplace enable plans from the workspace manifests by default and enables dependencies in plan order', async () => {
    writeManifest('wired', 'webmeetAgent', { enable: ['guard', 'liveKitServerAgent no-wait'] });
    writeManifest('wired', 'guard');
    writeManifest('wired', 'liveKitServerAgent');
    const { enableMarketplaceAgent, __testables } = await import(
        new URL(`../../cli/server/authHandlers/marketplaceRoutes.js?test=${Date.now()}`, import.meta.url).href
    );
    const calls = [];
    const result = await enableMarketplaceAgent({ agentRef: 'wired/webmeetAgent', mode: 'global' }, {
        runEnableWorker: async (input) => { calls.push(input); return {}; },
    });
    await __testables.marketplaceEnableQueueIdle();
    assert.deepEqual(calls, [
        { agentRef: 'wired/guard', mode: '', ifMissing: true },
        { agentRef: 'wired/webmeetAgent', mode: 'global' },
        { agentRef: 'wired/liveKitServerAgent', mode: '', ifMissing: true },
    ]);
    assert.deepEqual(result.dependencies.map((entry) => [entry.ref, entry.phase, entry.status]), [
        ['wired/guard', 'before', 'enabled'],
        ['wired/liveKitServerAgent', 'after', 'queued'],
    ]);
});
