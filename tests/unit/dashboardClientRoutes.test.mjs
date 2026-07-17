import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

function createFakeElement(overrides = {}) {
    return {
        dataset: {},
        style: {},
        classList: { toggle() {}, add() {}, remove() {} },
        addEventListener() {},
        appendChild() {},
        querySelector() { return null; },
        setAttribute() {},
        innerHTML: '',
        textContent: '',
        value: '',
        disabled: false,
        onclick: null,
        ...overrides,
    };
}

function createDashboardContext({ base = '/dashboard' } = {}) {
    const elements = new Map();
    const ids = [
        'titleBar',
        'themeToggle',
        'refreshStatus',
        'statusOut',
        'logsOut',
        'logCount',
        'agentsList',
        'refreshAgents',
        'debugPopup',
        'debugBtn',
        'debugClose',
        'debugSend',
        'debugJson',
        'debugError',
        'debugResponse',
        'debugAgentName',
        'debugAgentPort',
        'restartBtn',
        'ctrlOut',
        'lnkConsole',
        'lnkChat',
    ];
    for (const id of ids) {
        elements.set(id, createFakeElement());
    }
    elements.get('logCount').value = '200';
    elements.get('debugJson').value = '{}';

    const fetchCalls = [];
    const context = {
        document: {
            body: createFakeElement({ dataset: { base, title: 'Dashboard' } }),
            getElementById(id) {
                if (!elements.has(id)) {
                    elements.set(id, createFakeElement());
                }
                return elements.get(id);
            },
            querySelectorAll() {
                return [];
            },
            createElement() {
                return createFakeElement();
            },
        },
        window: {
            location: {
                origin: 'http://127.0.0.1:8080',
            },
        },
        localStorage: {
            getItem() {
                return null;
            },
            setItem() {},
        },
        fetch: async (url, options = {}) => {
            fetchCalls.push({ url: String(url), options });
            if (String(url) === '/auth/token') {
                return {
                    ok: true,
                    json: async () => ({
                        ok: true,
                        adminControl: {
                            origin: 'http://127.0.0.1:8080',
                            csrfToken: 'v1.test-proof',
                        },
                    }),
                    text: async () => '{}',
                };
            }
            return {
                ok: true,
                json: async () => ({ ok: true, stdout: 'Agent: explorer (port: 3000)\n' }),
                text: async () => '{}',
            };
        },
        setInterval() {
            return 1;
        },
        clearInterval() {},
        confirm() {
            return true;
        },
    };

    vm.createContext(context);
    return { context, fetchCalls };
}

test('dashboard client fetches mounted dashboard routes', async () => {
    const scriptPath = path.resolve('cli/server/dashboard/dashboard.js');
    const source = await fs.readFile(scriptPath, 'utf8');
    const { context, fetchCalls } = createDashboardContext({ base: '/dashboard' });

    vm.runInContext(source, context, { filename: scriptPath });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const fetchUrls = fetchCalls.map((call) => call.url);
    assert.ok(fetchUrls.length >= 3);
    assert.ok(fetchUrls.every((url) => url !== 'run'));
    assert.ok(fetchUrls.includes('/auth/token'));
    assert.ok(fetchUrls.includes('/dashboard/run'));
    for (const call of fetchCalls.filter((item) => item.url === '/dashboard/run')) {
        assert.equal(call.options.keepalive, true);
        assert.equal(call.options.credentials, 'include');
        assert.equal(call.options.headers['X-Ploinky-CSRF-Token'], 'v1.test-proof');
    }
});
