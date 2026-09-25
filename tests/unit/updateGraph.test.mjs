import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { applyGraphRequirements, readUpdateGraph, withUpdateSkillScopes } from '../../cli/commands/updateGraph.js';
import { createOperationRecord } from '../../cli/commands/updateOutcome.js';
import { skillsManifestRecord } from '../../cli/commands/updateRecords.js';

// Graph closure: which update records are required inputs of the workspace
// graph (prior or proposed), which are optional, and which are unknown.

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-update-graph-'));
    const repos = path.join(root, 'repos');
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(repos, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    const manifest = (repo, agent, value) => {
        fs.mkdirSync(path.join(repos, repo, agent), { recursive: true });
        fs.writeFileSync(path.join(repos, repo, agent, 'manifest.json'), typeof value === 'string' ? value : JSON.stringify(value));
    };
    const repositoryPath = name => {
        if (name === 'Unregistered') throw new Error("Repository 'Unregistered' is unregistered");
        return path.join(repos, name);
    };
    return { root, repos, workspace, manifest, repositoryPath };
}

const record = (phase, id, extra = {}) => createOperationRecord({ phase, id, outcome: 'unchanged', attempted: true, ...extra });

test('graph closure follows registry agents, devel repositories, manifest repos, link-install and transitive enables', () => {
    const fx = fixture();
    try {
        fx.manifest('Main', 'app', {
            repos: { SkillsCache: 'https://example.invalid/skills.git' },
            'link-install': ['https://github.com/org/linked-lib.git'],
            enable: ['Deps/helper', 'sibling no-wait'],
        });
        fx.manifest('Main', 'sibling', {});
        fx.manifest('Deps', 'helper', { profiles: { dev: { enable: ['Deeper:leaf'] } } });
        fx.manifest('Deeper', 'leaf', {});
        const registry = {
            _config: { static: { agent: 'Main/app' } },
            a: { type: 'agent', repoName: 'Main', agentName: 'app', develRepo: 'DevRepo' },
            b: { type: 'service', repoName: 'Ignored' },
        };
        const graph = readUpdateGraph({ workspaceRoot: fx.workspace, readRegistry: () => registry, repositoryPath: fx.repositoryPath,
            skillScopeContext: { prior: null, proposed: fx.workspace, priorRequired: false } });
        assert.equal(graph.determinable, true, graph.errors.join('; '));
        assert.deepEqual([...graph.repositories].sort(), ['Deeper', 'Deps', 'DevRepo', 'Main', 'SkillsCache']);
        assert.deepEqual([...graph.linkInstallNames], ['linked-lib']);

        const records = applyGraphRequirements([
            record('registered-repository', 'Main'),
            record('registered-repository', 'Deeper'),
            record('registered-repository', 'Unrelated'),
            record('workspace-repository', path.join(fx.workspace, 'linked-lib'), { details: { checkout: { path: path.join(fx.workspace, 'linked-lib') } } }),
            record('workspace-repository', path.join(fx.workspace, 'other')),
            record('skills-manifest', path.join(fx.repos, 'Main', 'docs'), { details: { folder: path.join(fx.repos, 'Main', 'docs'), sources: ['ManifestSource'] } }),
            record('skills-manifest', path.join(fx.workspace, 'notes'), { details: { folder: path.join(fx.workspace, 'notes'), sources: ['OptionalSource'] } }),
            record('registered-repository', 'ManifestSource'),
            record('registered-repository', 'OptionalSource'),
            record('default-skills', 'Defaults->Main', { details: { target: 'Main', source: 'Defaults' } }),
            record('default-skills', 'Defaults->Unrelated', { details: { target: 'Unrelated', source: 'Defaults' } }),
            record('registered-repository', 'Defaults'),
            record('agentlib', 'achillesAgentLib', { required: true, details: { requirementFixed: true } }),
            record('default-skills', 'Defaults->Defaults', { outcome: 'skipped', required: false, details: { target: 'Defaults', requirementFixed: true } }),
        ], { prior: graph, proposed: graph });
        assert.deepEqual(records.map(entry => [entry.phase, path.basename(entry.id), entry.required]), [
            ['registered-repository', 'Main', true],
            ['registered-repository', 'Deeper', true],
            ['registered-repository', 'Unrelated', false],
            ['workspace-repository', 'linked-lib', true],
            ['workspace-repository', 'other', false],
            ['skills-manifest', 'docs', true],
            ['skills-manifest', 'notes', false],
            ['registered-repository', 'ManifestSource', true],
            ['registered-repository', 'OptionalSource', false],
            ['default-skills', 'Defaults->Main', true],
            ['default-skills', 'Defaults->Unrelated', false],
            ['registered-repository', 'Defaults', true],
            ['agentlib', 'achillesAgentLib', true],
            ['default-skills', 'Defaults->Defaults', false],
        ]);
        assert.equal(records[0].attempted, true, 'rebuilding a record keeps its attempted flag');
    } finally {
        fs.rmSync(fx.root, { recursive: true, force: true });
    }
});

test('membership is the union of the prior and proposed graphs, and unknown membership is null', () => {
    const fx = fixture();
    try {
        fx.manifest('Main', 'app', { repos: { OldDep: 'x' } });
        const prior = readUpdateGraph({ workspaceRoot: fx.workspace, readRegistry: () => ({ a: { type: 'agent', repoName: 'Main', agentName: 'app' } }), repositoryPath: fx.repositoryPath });
        fx.manifest('Main', 'app', { repos: { NewDep: 'y' } });
        const proposed = readUpdateGraph({ workspaceRoot: fx.workspace, readRegistry: () => ({ a: { type: 'agent', repoName: 'Main', agentName: 'app' } }), repositoryPath: fx.repositoryPath });
        const union = applyGraphRequirements([
            record('registered-repository', 'OldDep'),
            record('registered-repository', 'NewDep'),
            record('registered-repository', 'Other'),
        ], { prior, proposed });
        assert.deepEqual(union.map(entry => entry.required), [true, true, false]);

        fx.manifest('Main', 'app', '{ not json');
        const broken = readUpdateGraph({ workspaceRoot: fx.workspace, readRegistry: () => ({ a: { type: 'agent', repoName: 'Main', agentName: 'app' } }), repositoryPath: fx.repositoryPath });
        assert.equal(broken.determinable, false);
        const unknown = applyGraphRequirements([
            record('registered-repository', 'Main'),
            record('registered-repository', 'Other'),
        ], { prior, proposed: broken });
        assert.deepEqual(unknown.map(entry => entry.required), [true, null],
            'proven membership stays required; everything else becomes unknown (treated as required)');

        const unreadable = readUpdateGraph({ workspaceRoot: fx.workspace, readRegistry: () => { throw new Error('agents registry is invalid'); } });
        assert.equal(unreadable.determinable, false);
        assert.deepEqual(applyGraphRequirements([record('workspace-repository', '/x')], { prior: unreadable, proposed: unreadable })
            .map(entry => entry.required), [null]);

        const unnamed = readUpdateGraph({ workspaceRoot: fx.workspace, readRegistry: () => ({ a: { type: 'agent', repoName: 'Unregistered', agentName: 'x' } }), repositoryPath: fx.repositoryPath });
        assert.equal(unnamed.determinable, false, 'an unresolvable repository makes membership unknown');
    } finally {
        fs.rmSync(fx.root, { recursive: true, force: true });
    }
});

test('a bare enabled agent outside its repository is resolved like the start path, else membership is unknown', () => {
    const fx = fixture();
    try {
        fx.manifest('Main', 'app', { enable: ['elsewhere'] });
        fx.manifest('Other', 'elsewhere', { repos: { Leaf: 'z' } });
        const registry = () => ({ a: { type: 'agent', repoName: 'Main', agentName: 'app' } });
        const resolved = readUpdateGraph({
            workspaceRoot: fx.workspace, readRegistry: registry, repositoryPath: fx.repositoryPath,
            resolveAgent: name => ({ repo: 'Other', shortAgentName: name }),
        });
        assert.equal(resolved.determinable, true);
        assert.ok(resolved.repositories.has('Other') && resolved.repositories.has('Leaf'));
        const unresolved = readUpdateGraph({
            workspaceRoot: fx.workspace, readRegistry: registry, repositoryPath: fx.repositoryPath,
            resolveAgent: () => { throw new Error("Agent 'elsewhere' not found."); },
        });
        assert.equal(unresolved.determinable, false);
    } finally {
        fs.rmSync(fx.root, { recursive: true, force: true });
    }
});

test('required manifest source paths include workspace-only checkouts and declared aliases', () => {
    const fx = fixture();
    try {
        fx.manifest('Main', 'app', {});
        const graph = readUpdateGraph({ workspaceRoot: fx.workspace,
            readRegistry: () => ({ a: { type: 'agent', repoName: 'Main', agentName: 'app' } }),
            repositoryPath: fx.repositoryPath });
        const checkout = path.join(fx.workspace, 'different-folder');
        const records = applyGraphRequirements([
            skillsManifestRecord({ folder: path.join(fx.repos, 'Main', 'docs'),
                manifestPath: path.join(fx.repos, 'Main', 'docs', 'ploinky-skills-manifest.json'), label: 'docs',
                result: { repos: [], skills: [],
                    sourceStates: [{ name: 'DeclaredAlias', checkoutPath: checkout, state: 'retained' }] } }),
            record('workspace-repository', checkout, { outcome: 'failed',
                details: { checkout: { path: checkout } } }),
            record('registered-repository', 'AnotherAlias', { outcome: 'skipped',
                details: { checkout: { path: checkout } } }),
        ], { prior: graph, proposed: graph });
        assert.deepEqual(records.map(value => value.required), [true, true, true]);
    } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test('prior and proposed launch manifests outside agent repos are required but unrelated folders stay optional', () => {
    const fx = fixture();
    try {
        fx.manifest('Main', 'app', {});
        const nested = path.join(fx.workspace, 'nested');
        const unrelated = path.join(fx.workspace, 'unrelated');
        const priorSource = path.join(fx.workspace, 'old-source');
        fs.mkdirSync(nested);
        fs.mkdirSync(unrelated);
        fs.mkdirSync(priorSource);
        fs.writeFileSync(path.join(fx.workspace, 'ploinky-skills-manifest.json'), JSON.stringify([
            { name: 'PriorSkills', url: 'https://example.invalid/prior.git', skills: ['skill'] },
        ]));
        const graph = readUpdateGraph({ workspaceRoot: fx.workspace,
            readRegistry: () => ({ a: { type: 'agent', repoName: 'Main', agentName: 'app' } }),
            repositoryPath: fx.repositoryPath,
            resolveSkillSource: () => ({ origin: 'workspace', source: priorSource }),
            skillScopeContext: { prior: fx.workspace, proposed: nested, priorRequired: true },
        });
        assert.equal(graph.skillScopesDetermined, true, graph.errors.join('; '));
        const records = applyGraphRequirements([
            record('skills-manifest', fx.workspace, { outcome: 'failed', details: { folder: fx.workspace } }),
            record('skills-manifest', nested, { outcome: 'failed', details: { folder: nested } }),
            record('skills-manifest', unrelated, { outcome: 'failed', details: { folder: unrelated } }),
            record('workspace-repository', priorSource, { outcome: 'failed', details: { checkout: { path: priorSource } } }),
        ], { prior: graph, proposed: graph });
        assert.deepEqual(records.map(value => value.required), [true, true, false, true]);
        assert.ok(graph.skillSourcePaths.has(fs.realpathSync(priorSource)), 'prior source closure does not depend on a current export record');
    } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test('outside or missing required scope evidence is unknown rather than optional', () => {
    const fx = fixture();
    try {
        for (const prior of [null, fx.root, path.join(fx.workspace, 'missing')]) {
            const graph = readUpdateGraph({ workspaceRoot: fx.workspace, readRegistry: () => ({}),
                repositoryPath: fx.repositoryPath,
                skillScopeContext: { prior, proposed: fx.workspace, priorRequired: true },
            });
            assert.equal(graph.skillScopesDetermined, false);
            const [manifest, provider] = applyGraphRequirements([
                record('skills-manifest', path.join(fx.workspace, 'other'), { outcome: 'failed' }),
                record('workspace-repository', path.join(fx.workspace, 'provider'), { outcome: 'skipped' }),
            ], { prior: graph, proposed: graph });
            assert.equal(manifest.required, null);
            assert.equal(provider.required, null);
        }
    } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test('concurrent update commands keep their host skill-scope contexts separate', async () => {
    const fx = fixture();
    try {
        const nested = path.join(fx.workspace, 'nested');
        fs.mkdirSync(nested);
        const results = await Promise.all([fx.workspace, nested].map(proposed => withUpdateSkillScopes({
            prior: null, proposed, priorRequired: false,
        }, async () => {
            await new Promise(resolve => setImmediate(resolve));
            const graph = readUpdateGraph({ workspaceRoot: fx.workspace, readRegistry: () => ({}), repositoryPath: fx.repositoryPath });
            return [...graph.skillScopePaths];
        })));
        assert.deepEqual(results, [[fs.realpathSync(fx.workspace)], [fs.realpathSync(nested)]]);
    } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});
