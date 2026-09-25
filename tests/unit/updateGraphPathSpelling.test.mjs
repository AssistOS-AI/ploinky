import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { applyGraphRequirements, readUpdateGraph } from '../../cli/commands/updateGraph.js';
import { createOperationRecord } from '../../cli/commands/updateOutcome.js';
import { skillsManifestRecord } from '../../cli/commands/updateRecords.js';

// Graph membership must not depend on how the workspace path is spelled. The
// workspace is reached through a symlinked parent regardless of TMPDIR, and
// the required checkouts do not exist yet.

function aliasedFixture() {
    const real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-update-graph-real-')));
    const alias = `${real}-alias`;
    fs.symlinkSync(real, alias, 'dir');
    const repos = path.join(alias, 'repos');
    const workspace = path.join(alias, 'workspace');
    fs.mkdirSync(path.join(repos, 'Main', 'app'), { recursive: true });
    fs.writeFileSync(path.join(repos, 'Main', 'app', 'manifest.json'), JSON.stringify({
        'link-install': ['https://github.com/org/linked-lib.git'],
    }));
    fs.mkdirSync(workspace, { recursive: true });
    return {
        real, alias, repos, workspace,
        repositoryPath: name => path.join(repos, name),
        cleanup() {
            fs.rmSync(alias, { force: true });
            fs.rmSync(real, { recursive: true, force: true });
        },
    };
}

const record = (phase, id, extra = {}) => createOperationRecord({ phase, id, outcome: 'failed', attempted: true, ...extra });

for (const spelling of ['alias', 'real']) {
    test(`missing required checkouts stay required when records use the ${spelling} workspace spelling`, () => {
        const fx = aliasedFixture();
        try {
            const graph = readUpdateGraph({ workspaceRoot: fx.workspace,
                readRegistry: () => ({ a: { type: 'agent', repoName: 'Main', agentName: 'app' } }),
                repositoryPath: fx.repositoryPath });
            assert.equal(graph.determinable, true, graph.errors.join('; '));
            const base = spelling === 'alias' ? fx.alias : fx.real;
            const linked = path.join(base, 'workspace', 'linked-lib');
            const declared = path.join(base, 'workspace', 'declared-folder');
            const unrelated = path.join(base, 'workspace', 'unrelated');
            for (const target of [linked, declared, unrelated]) assert.equal(fs.existsSync(target), false);
            const records = applyGraphRequirements([
                record('workspace-repository', linked, { details: { checkout: { path: linked } } }),
                skillsManifestRecord({ folder: path.join(base, 'repos', 'Main', 'docs'),
                    manifestPath: path.join(base, 'repos', 'Main', 'docs', 'ploinky-skills-manifest.json'), label: 'docs',
                    result: { repos: [], skills: [],
                        sourceStates: [{ name: 'Declared', checkoutPath: declared, state: 'retained' }] } }),
                record('workspace-repository', declared, { details: { checkout: { path: declared } } }),
                record('workspace-repository', unrelated, { details: { checkout: { path: unrelated } } }),
            ], { prior: graph, proposed: graph });
            assert.deepEqual(records.map(value => value.required), [true, true, true, false]);
        } finally { fx.cleanup(); }
    });
}
