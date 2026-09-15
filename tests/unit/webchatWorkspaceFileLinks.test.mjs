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

test('workspace file detection recognizes common assistant path forms', () => {
    const text = [
        'Created report.md and docs/summary.json.',
        'Read src/main.mjs next.',
        'The image is /workspace/assets/chart.png:12.',
        'See Dockerfile for the container setup.',
    ].join('\n');

    assert.deepEqual(
        findWorkspaceFileCandidates(text).map(({ raw, path, line }) => ({ raw, path, line })),
        [
            { raw: 'report.md', path: 'report.md', line: null },
            { raw: 'docs/summary.json', path: 'docs/summary.json', line: null },
            { raw: 'src/main.mjs', path: 'src/main.mjs', line: null },
            { raw: '/workspace/assets/chart.png:12', path: 'assets/chart.png', line: 12 },
            { raw: 'Dockerfile', path: 'Dockerfile', line: null },
        ],
    );
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
