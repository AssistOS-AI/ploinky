import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';
import { MACHINE_RENDER_QUERY, classifyRenderFacts, collectLinuxRenderFacts, parseMachineRenderReport } from '../../ploinky-box/gpuVulkan.mjs';
import { makeTree } from './fixtures/render-query/make-trees.mjs';

function execute(tree) {
    const result = spawnSync('/bin/sh', ['-c', MACHINE_RENDER_QUERY], {
        encoding: 'utf8', timeout: 10_000,
        env: { PATH: `${tree.root}/bin:/usr/bin:/bin`, PLOINKY_QUERY_ROOT: tree.root },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    return parseMachineRenderReport(result.stdout);
}

test('query: captured ploinky-gpu report matches the libkrun tree and is accepted only on darwin', (t) => {
    const text = fs.readFileSync(new URL('./fixtures/render-query/venus-machine-query.txt', import.meta.url), 'utf8');
    const report = parseMachineRenderReport(text);
    assert.equal(report.kernel, '7.1.3-200.fc44.aarch64');
    assert.equal(report.nodes.length, 1);
    const tree = makeTree(t, 'krun');
    assert.deepEqual(report.nodes, execute(tree).nodes);
    assert.deepEqual(report.nodes[0].children, [{ name: 'virtio3', driver: 'virtio_gpu', device: '0x0010' }]);
    assert.equal(classifyRenderFacts(report.nodes[0], { platform: 'darwin' }).accepted, true);
    assert.match(classifyRenderFacts(report.nodes[0], { platform: 'linux' }).reason, /granted only inside/);
});

test('query: MACHINE_RENDER_QUERY run by /bin/sh on fixture trees gives the facts the Linux collector gives', (t) => {
    for (const [kind, options] of [['qa', {}], ['krun', {}], ['amd', {}], ['amd', { link: true, mode: 0o120777 }],
        ['amd', { sysDev: '226:129' }], ['amd', { transport: null }], ['empty', {}]]) {
        const tree = makeTree(t, kind, options);
        const report = execute(tree);
        assert.deepEqual(report.nodes, fs.readdirSync(`${tree.root}/dev/dri`).map((name) => collectLinuxRenderFacts(name, tree)));
        if (kind === 'qa') assert.match(classifyRenderFacts(report.nodes[0], { platform: 'linux' }).reason, /granted only inside/);
        if (kind === 'krun') assert.equal(classifyRenderFacts(report.nodes[0], { platform: 'darwin' }).accepted, true);
    }
});

test('query: parser rejects extra fields, unknown lines, a missing end and more than 16 nodes', () => {
    const node = 'node renderD128 21b6 e2 80 226:128 amdgpu 0x1002 8 rw';
    for (const text of [`kernel 6.8\n${node} extra\nend\n`, `kernel 6.8\nunknown\nend\n`, `kernel 6.8\n${node}\n`,
        `kernel 6.8\n${Array.from({ length: 17 }, (_, i) => node.replaceAll('128', String(128 + i))).join('\n')}\nend\n`,
        `kernel 6.8\n${node}\n${node}\nend\n`, `kernel 6.8\nchild renderD128 virtio0 virtio_gpu 0x0010\nend\n`,
        `kernel 6.8\n${node.replace('21b6 e2 80', '- e2 -')}\nend\n`, 'kernel 6.8\nend\nextra\n']) {
        assert.throws(() => parseMachineRenderReport(text), /malformed/);
    }
});

test('query: a node whose stat failed is refused alone; the other nodes are still classified', (t) => {
    const tree = makeTree(t, 'krun', { stat: false });
    tree.addNode({ name: 'renderD129' });
    const { nodes } = execute(tree);
    assert.match(classifyRenderFacts(nodes[0], { platform: 'darwin' }).reason, /stat failed/);
    assert.equal(classifyRenderFacts(nodes[1], { platform: 'darwin' }).accepted, true);
});
