import assert from 'node:assert/strict';
import test from 'node:test';

import { getMimeType, getWorkspaceFileHeaders } from '../../cli/server/static/index.js';
import {
    buildWorkspaceFileUrl,
    enhanceWorkspaceFileLinks,
    findWorkspaceFileCandidates,
    normalizeWorkspaceFileCandidate,
    workspaceFilePreviewKind,
} from '../../cli/server/webchat/workspaceFileLinks.js';

function fileIndex(...paths) {
    const files = new Set(paths);
    return { has: (filePath) => files.has(filePath) };
}

const WORKSPACE_ROOT = '/home/user/project';

test('workspace file detection recognizes common assistant path forms', () => {
    const text = [
        'Created report.md and docs/summary.json.',
        'Read src/main.mjs next.',
        'The image is /home/user/project/assets/chart.png:12.',
        'See Dockerfile for the container setup.',
    ].join('\n');

    assert.deepEqual(
        findWorkspaceFileCandidates(text, { workspaceRoot: WORKSPACE_ROOT })
            .map(({ raw, path, line, rootRelative }) => ({ raw, path, line, rootRelative })),
        [
            { raw: 'report.md', path: 'report.md', line: null, rootRelative: false },
            { raw: 'docs/summary.json', path: 'docs/summary.json', line: null, rootRelative: false },
            { raw: 'src/main.mjs', path: 'src/main.mjs', line: null, rootRelative: false },
            { raw: '/home/user/project/assets/chart.png:12', path: 'assets/chart.png', line: 12, rootRelative: true },
            { raw: 'Dockerfile', path: 'Dockerfile', line: null, rootRelative: false },
        ],
    );
});

test('absolute references link only strictly beneath the trusted workspace root', () => {
    const accepted = normalizeWorkspaceFileCandidate('/home/user/project/src/app.mjs', { workspaceRoot: WORKSPACE_ROOT });
    assert.equal(accepted.path, 'src/app.mjs');
    assert.equal(accepted.rootRelative, true);
    for (const candidate of [
        '/home/user/project',
        '/home/user/project/',
        '/home/user/project-other/src/app.mjs',
        '/home/user/projectx/app.mjs',
        '/home/user/project/../secret.md',
        '/home/user/project/src/../../secret.md',
        '/workspace/src/app.mjs',
        '/etc/passwd.txt',
    ]) {
        assert.equal(normalizeWorkspaceFileCandidate(candidate, { workspaceRoot: WORKSPACE_ROOT }), null, candidate);
    }
    // Absolute text is never admitted without a clean trusted root.
    for (const workspaceRoot of ['', '/', 'relative', '/home/user/project/', '/home/../user']) {
        assert.equal(normalizeWorkspaceFileCandidate('/home/user/project/src/app.mjs', { workspaceRoot }), null, workspaceRoot);
    }
    // A host workspace literally named /workspace is an ordinary root.
    assert.equal(normalizeWorkspaceFileCandidate('/workspace/src/app.mjs', { workspaceRoot: '/workspace' }).path, 'src/app.mjs');
    assert.equal(
        buildWorkspaceFileUrl('/home/user/project/sub dir/a b.md', 'sub dir', { workspaceRoot: WORKSPACE_ROOT }),
        '/workspace-files/sub%20dir/a%20b.md',
    );
    assert.equal(
        buildWorkspaceFileUrl('/home/user/project/other/a.md', 'sub', { workspaceRoot: WORKSPACE_ROOT }),
        '/workspace-files/other/a.md',
    );
    assert.equal(buildWorkspaceFileUrl('/home/user/project-other/a.md', 'sub', { workspaceRoot: WORKSPACE_ROOT }), null);
});

test('absolute references preserve literal host prefixes and file names', () => {
    for (const workspaceRoot of [
        '/home/user/my project',
        '/home/user/p(1)[draft]+$',
        '/home/user/quoted" and \'unicode ăîș',
        '/home/user/back\\slash',
    ]) {
        const absolutePath = `${workspaceRoot}/reports/final.md:12:4`;
        const candidates = findWorkspaceFileCandidates(`Wrote ${absolutePath}.`, { workspaceRoot });
        assert.equal(candidates.length, 1, workspaceRoot);
        assert.equal(candidates[0].raw, absolutePath);
        assert.equal(candidates[0].path, 'reports/final.md');
        assert.equal(candidates[0].rootRelative, true);
        assert.equal(candidates[0].line, 12);
        assert.equal(candidates[0].column, 4);
        assert.equal(buildWorkspaceFileUrl(absolutePath, 'other', { workspaceRoot }), '/workspace-files/reports/final.md');
    }
    const options = { workspaceRoot: WORKSPACE_ROOT };
    assert.equal(buildWorkspaceFileUrl(`${WORKSPACE_ROOT}/@notes.md`, '', options), '/workspace-files/%40notes.md');
    assert.equal(buildWorkspaceFileUrl(`${WORKSPACE_ROOT}/./notes.md`, '', options), null);
    assert.equal(buildWorkspaceFileUrl('@notes.md'), '/workspace-files/notes.md', 'relative alias is retained');
});

test('workspace file detection accepts spaced inline-code paths without consuming surrounding prose', () => {
    assert.deepEqual(
        findWorkspaceFileCandidates('reports/Raport Sistem Solar.md', {
            allowWholeTextWithSpaces: true,
        }).map(({ path }) => path),
        ['reports/Raport Sistem Solar.md'],
    );
    assert.deepEqual(
        findWorkspaceFileCandidates('Am creat Raport Sistem Solar.md pentru tine').map(({ raw }) => raw),
        ['Solar.md'],
    );
});

test('workspace file detection ignores URLs, versions, traversal, and host absolute paths', () => {
    const candidates = findWorkspaceFileCandidates([
        'https://example.com/report.md',
        'release v1.2.3',
        '../secret.txt',
        '/home/user/report.md',
    ].join(' '));
    assert.deepEqual(candidates, []);
    assert.equal(normalizeWorkspaceFileCandidate('../secret.txt'), null);
    assert.equal(normalizeWorkspaceFileCandidate('/home/user/report.md'), null);
});

test('workspace file URLs prefix cwd-relative paths and preserve workspace-relative paths', () => {
    assert.equal(
        buildWorkspaceFileUrl('reports/Raport Sistem Solar.md', 'achilles-cli-test'),
        '/workspace-files/achilles-cli-test/reports/Raport%20Sistem%20Solar.md',
    );
    assert.equal(
        buildWorkspaceFileUrl('achilles-cli-test/report.md', 'achilles-cli-test'),
        '/workspace-files/achilles-cli-test/report.md',
    );
    assert.equal(buildWorkspaceFileUrl('../outside.md', 'project'), null);
});

test('workspace file preview classification separates rendered and native file types', () => {
    assert.equal(workspaceFilePreviewKind('README.md'), 'markdown');
    assert.equal(workspaceFilePreviewKind('src/index.mjs:12:4'), 'text');
    assert.equal(workspaceFilePreviewKind('assets/chart.png'), 'image');
    assert.equal(workspaceFilePreviewKind('manual.pdf'), 'pdf');
    assert.equal(workspaceFilePreviewKind('article.html'), 'html');
    assert.equal(workspaceFilePreviewKind('archive.zip'), 'unknown');
});

test('workspace file MIME types keep text content inline and typed', () => {
    assert.equal(getMimeType('README.md'), 'text/markdown; charset=utf-8');
    assert.equal(getMimeType('notes.txt'), 'text/plain; charset=utf-8');
    assert.equal(getMimeType('config.yaml'), 'text/yaml; charset=utf-8');
    assert.equal(getMimeType('src/main.py'), 'text/plain; charset=utf-8');
    assert.equal(getMimeType('manual.pdf'), 'application/pdf');
    assert.deepEqual(getWorkspaceFileHeaders('README.md'), {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Cache-Control': 'public, max-age=60',
        'Content-Disposition': 'inline',
        'X-Content-Type-Options': 'nosniff',
    });
});

test('HTML documents are never cacheable while assets keep bounded public caching', () => {
    // Regression: a demoted or logged-out browser reused a cached Explorer shell for 60 seconds
    // instead of receiving the Router's capability-denied redirect on the next document navigation.
    for (const document of ['index.html', 'explorer/index.html', 'article.HTML', 'legacy.htm']) {
        assert.equal(getWorkspaceFileHeaders(document)['Cache-Control'], 'no-store', document);
    }
    assert.equal(getWorkspaceFileHeaders('README.md')['Cache-Control'], 'public, max-age=60');
    assert.equal(getWorkspaceFileHeaders('main.js')['Cache-Control'], 'public, max-age=300');
    assert.equal(getWorkspaceFileHeaders('logo.png')['Cache-Control'], 'public, max-age=86400');
    assert.equal(getWorkspaceFileHeaders('font.woff2')['Cache-Control'], 'public, max-age=31536000, immutable');
});

test('workspace file enhancement replaces assistant text candidates with preview links', () => {
    const parent = {
        tagName: 'P',
        parentElement: null,
        replacement: null,
        replaceChild(next) { this.replacement = next; },
    };
    const textNode = {
        nodeValue: 'Created reports/final-report.md and summary.json; missing.json was not created.',
        parentElement: parent,
        parentNode: parent,
    };
    const documentRef = {
        createTreeWalker() {
            let emitted = false;
            return {
                nextNode() {
                    if (emitted) return null;
                    emitted = true;
                    return textNode;
                },
            };
        },
        createDocumentFragment() {
            return {
                children: [],
                appendChild(child) { this.children.push(child); },
            };
        },
        createTextNode(value) {
            return { nodeValue: value };
        },
        createElement(tagName) {
            return {
                tagName: tagName.toUpperCase(),
                className: '',
                dataset: {},
                textContent: '',
                title: '',
                href: '',
            };
        },
    };
    const container = {
        ownerDocument: documentRef,
        querySelectorAll: () => [],
    };

    const count = enhanceWorkspaceFileLinks(container, {
        workspaceBase: 'project',
        fileIndex: fileIndex('reports/final-report.md', 'summary.json'),
    });

    assert.equal(count, 2);
    const anchors = parent.replacement.children.filter((child) => child.tagName === 'A');
    assert.deepEqual(anchors.map((anchor) => anchor.textContent), ['reports/final-report.md', 'summary.json']);
    assert.deepEqual(
        anchors.map((anchor) => anchor.href),
        ['/workspace-files/project/reports/final-report.md', '/workspace-files/project/summary.json'],
    );
    assert.ok(anchors.every((anchor) => anchor.dataset.wcFile === 'true'));
    assert.ok(parent.replacement.children.some((child) => String(child.nodeValue || '').includes('missing.json')));
    assert.equal(textNode.nodeValue, 'Created reports/final-report.md and summary.json; missing.json was not created.');
});

test('workspace file enhancement preserves explicit workspace-root file links', () => {
    const originalWindow = globalThis.window;
    globalThis.window = { location: { origin: 'https://example.test' } };
    try {
        const anchor = {
            href: 'https://example.test/workspace-files/.ploinky/repos/tool.mjs',
            dataset: {},
            classList: { add() {} },
        };
        const documentRef = {
            createTreeWalker: () => ({ nextNode: () => null }),
        };
        const container = {
            ownerDocument: documentRef,
            querySelectorAll: () => [anchor],
        };

        enhanceWorkspaceFileLinks(container, {
            workspaceBase: 'current-project',
            fileIndex: fileIndex('.ploinky/repos/tool.mjs'),
        });

        assert.equal(anchor.href, '/workspace-files/.ploinky/repos/tool.mjs');
        assert.equal(anchor.dataset.wcFilePath, '.ploinky/repos/tool.mjs');
        assert.equal(anchor.dataset.wcFile, 'true');
    } finally {
        globalThis.window = originalWindow;
    }
});

test('workspace file enhancement normalizes relative Markdown file links', () => {
    const originalWindow = globalThis.window;
    globalThis.window = { location: { origin: 'https://example.test' } };
    try {
        const anchor = {
            href: 'https://example.test/webchat/reports/final.md',
            dataset: {},
            classList: { add() {} },
        };
        const container = {
            ownerDocument: { createTreeWalker: () => ({ nextNode: () => null }) },
            querySelectorAll: () => [anchor],
        };

        enhanceWorkspaceFileLinks(container, {
            workspaceBase: 'project',
            fileIndex: fileIndex('reports/final.md'),
        });

        assert.equal(anchor.href, '/workspace-files/project/reports/final.md');
        assert.equal(anchor.dataset.wcFilePath, 'reports/final.md');
    } finally {
        globalThis.window = originalWindow;
    }
});

test('absolute Markdown links use the trusted host root and current file index', () => {
    const originalWindow = globalThis.window;
    globalThis.window = { location: { origin: 'https://example.test' } };
    try {
        const workspaceRoot = '/home/user/my project (draft)';
        const paths = [
            `${workspaceRoot}/project/reports/final.md`,
            `${workspaceRoot}/other/final.md`,
            `${workspaceRoot}-other/project/reports/final.md`,
        ];
        const anchors = paths.map((filePath) => ({
            href: `https://example.test${filePath.split('/').map(encodeURIComponent).join('/')}`,
            dataset: {},
            classList: { add() {} },
        }));
        const originalHrefs = anchors.map((anchor) => anchor.href);
        const container = {
            ownerDocument: { createTreeWalker: () => ({ nextNode: () => null }) },
            querySelectorAll: () => anchors,
        };
        enhanceWorkspaceFileLinks(container, {
            workspaceBase: 'project',
            workspaceRoot,
            fileIndex: fileIndex('reports/final.md', 'other/final.md'),
        });
        assert.equal(anchors[0].href, '/workspace-files/project/reports/final.md');
        assert.equal(anchors[0].dataset.wcFilePath, 'project/reports/final.md');
        assert.equal(anchors[0].dataset.wcFile, 'true');
        assert.equal(anchors[1].href, originalHrefs[1], 'outside the indexed base');
        assert.equal(anchors[2].href, originalHrefs[2], 'outside the trusted root');
    } finally {
        globalThis.window = originalWindow;
    }
});

test('workspace file enhancement turns removed automatic links back into text', () => {
    const parent = {
        replacement: null,
        replaceChild(next) { this.replacement = next; },
    };
    const anchor = {
        dataset: { wcAutoFile: 'true', wcFilePath: 'reports/removed.md' },
        textContent: 'reports/removed.md',
        parentNode: parent,
    };
    const container = {
        ownerDocument: {
            createTextNode: (value) => ({ nodeValue: value }),
            createTreeWalker: () => ({ nextNode: () => null }),
        },
        querySelectorAll(selector) {
            return selector.includes('wc-auto-file') ? [anchor] : [];
        },
    };

    enhanceWorkspaceFileLinks(container, { fileIndex: fileIndex() });

    assert.equal(parent.replacement.nodeValue, 'reports/removed.md');
});

function fakeTextDocument(text) {
    const parent = {
        tagName: 'P',
        parentElement: null,
        replacement: null,
        replaceChild(next) { this.replacement = next; },
    };
    const textNode = { nodeValue: text, parentElement: parent, parentNode: parent };
    const documentRef = {
        createTreeWalker() {
            let emitted = false;
            return { nextNode() { if (emitted) return null; emitted = true; return textNode; } };
        },
        createDocumentFragment() {
            return { children: [], appendChild(child) { this.children.push(child); } };
        },
        createTextNode(value) { return { nodeValue: value }; },
        createElement(tagName) {
            return { tagName: tagName.toUpperCase(), className: '', dataset: {}, textContent: '', title: '', href: '' };
        },
    };
    return { parent, container: { ownerDocument: documentRef, querySelectorAll: () => [] } };
}

test('absolute references beneath the root link root-relative known files only', () => {
    const { parent, container } = fakeTextDocument([
        'Wrote /home/user/project/project/reports/final.md,',
        '/home/user/project/other/outside.md,',
        '/home/user/project-other/project/reports/final.md,',
        'and /home/user/project/project/missing.md.',
    ].join(' '));
    const count = enhanceWorkspaceFileLinks(container, {
        workspaceBase: 'project',
        workspaceRoot: WORKSPACE_ROOT,
        fileIndex: fileIndex('reports/final.md', 'other/outside.md', 'missing-elsewhere.md'),
    });
    assert.equal(count, 1);
    const anchors = parent.replacement.children.filter((child) => child.tagName === 'A');
    assert.deepEqual(anchors.map((anchor) => [anchor.textContent, anchor.href, anchor.dataset.wcFilePath, anchor.dataset.wcFileRootRelative]), [[
        '/home/user/project/project/reports/final.md',
        '/workspace-files/project/reports/final.md',
        'project/reports/final.md',
        'true',
    ]]);
});

test('external absolute references with spaces cannot link a known relative suffix', () => {
    for (const text of [
        '/home/outsider/other project/note.md',
        'Read /home/outsider/other project/note.md next.',
        'Read "/home/outsider/other project/note.md" next.',
        'Read /home/outsider/other project/README next.',
    ]) {
        const { container } = fakeTextDocument(text);
        assert.equal(enhanceWorkspaceFileLinks(container, {
            workspaceRoot: WORKSPACE_ROOT,
            fileIndex: fileIndex('project/note.md', 'project/README'),
        }), 0, text);
    }
    const text = 'Created project/note.md. Read /home/outsider/other project/note.md; then docs/next.md and /home/user/project/ready.md.';
    assert.deepEqual(findWorkspaceFileCandidates(text, { workspaceRoot: WORKSPACE_ROOT }).map(({ path }) => path), [
        'project/note.md', 'docs/next.md', 'ready.md',
    ]);
    assert.deepEqual(findWorkspaceFileCandidates('Read /home/outsider/report.md and project/note.md.').map(({ path }) => path), [
        'project/note.md',
    ]);
});

test('auto links for root-relative references are reconciled against the current index', () => {
    const anchor = {
        textContent: '/home/user/project/project/reports/final.md',
        dataset: { wcAutoFile: 'true', wcFilePath: 'project/reports/final.md', wcFileRootRelative: 'true' },
        parentNode: { replaced: null, replaceChild(next) { this.replaced = next; } },
    };
    const container = {
        ownerDocument: {
            createTreeWalker: () => ({ nextNode: () => null }),
            createTextNode: (value) => ({ nodeValue: value }),
        },
        querySelectorAll: (selector) => (selector.includes('auto-file') ? [anchor] : []),
    };
    enhanceWorkspaceFileLinks(container, { workspaceBase: 'project', workspaceRoot: WORKSPACE_ROOT, fileIndex: fileIndex('reports/final.md') });
    assert.equal(anchor.parentNode.replaced, null);
    // The root-relative path is not reinterpreted as base-relative text.
    enhanceWorkspaceFileLinks(container, { workspaceBase: 'project', workspaceRoot: WORKSPACE_ROOT, fileIndex: fileIndex('project/reports/final.md') });
    assert.deepEqual(anchor.parentNode.replaced, { nodeValue: '/home/user/project/project/reports/final.md' });
});
