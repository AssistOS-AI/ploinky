import test from 'node:test';
import assert from 'node:assert/strict';

// Module import side effects in this tree expect a master key to be present.
process.env.PLOINKY_MASTER_KEY = process.env.PLOINKY_MASTER_KEY || '5'.repeat(64);

const moduleSuffix = `?test=${Date.now()}`;
const depInstallerUrl = new URL('../../cli/utils/dependencies/dependencyInstaller.js', import.meta.url);

const { overrideGlobalDeps } = await import(`${depInstallerUrl.href}${moduleSuffix}`);

// ---------------------------------------------------------------------------
// overrideGlobalDeps: rewrite the achillesAgentLib dependency from env
// ---------------------------------------------------------------------------

const BASE_SHA = '1'.repeat(40);
const OVERRIDE_SHA = '2'.repeat(40);
const BASE = `git+https://github.com/AssistOS-AI/achillesAgentLib.git#${BASE_SHA}`;
function freshPkg() {
    return {
        dependencies: {
            achillesAgentLib: BASE,
            'mcp-sdk': 'git+https://github.com/AssistOS-AI/MCPSDK.git#main',
        },
    };
}

test('overrideGlobalDeps: bare immutable commit swaps the ref and preserves URL', () => {
    const out = overrideGlobalDeps(freshPkg(), { PLOINKY_AGENTLIB_REF: OVERRIDE_SHA });
    assert.equal(
        out.dependencies.achillesAgentLib,
        `git+https://github.com/AssistOS-AI/achillesAgentLib.git#${OVERRIDE_SHA}`,
    );
});

test('overrideGlobalDeps: full immutable git+ spec is used verbatim', () => {
    const full = `git+https://github.com/AssistOS-AI/AchillesAgentLib.git#${OVERRIDE_SHA}`;
    const out = overrideGlobalDeps(freshPkg(), { PLOINKY_AGENTLIB_REF: full });
    assert.equal(out.dependencies.achillesAgentLib, full);
});

test('overrideGlobalDeps: moving branch override is rejected', () => {
    assert.throws(
        () => overrideGlobalDeps(freshPkg(), { PLOINKY_AGENTLIB_REF: 'soul-gateway-local-integration' }),
        /immutable 40-hex commit/,
    );
});

test('overrideGlobalDeps: unpinned full git+ spec is rejected', () => {
    assert.throws(
        () => overrideGlobalDeps(freshPkg(), {
            PLOINKY_AGENTLIB_REF: 'git+https://github.com/AssistOS-AI/AchillesAgentLib.git#main',
        }),
        /immutable 40-hex commit/,
    );
});

test('overrideGlobalDeps: file spec is rejected', () => {
    assert.throws(
        () => overrideGlobalDeps(freshPkg(), { PLOINKY_AGENTLIB_REF: 'file:/abs/achillesAgentLib' }),
        /immutable 40-hex commit/,
    );
});

test('overrideGlobalDeps: local source is rejected even with a SHA-like fragment', () => {
    assert.throws(
        () => overrideGlobalDeps(freshPkg(), {
            PLOINKY_AGENTLIB_REF: `file:/abs/achillesAgentLib#${OVERRIDE_SHA}`,
        }),
        /immutable 40-hex commit/,
    );
});

test('overrideGlobalDeps: ambiguous multiple fragments are rejected', () => {
    assert.throws(
        () => overrideGlobalDeps(freshPkg(), {
            PLOINKY_AGENTLIB_REF: `git+https://example.invalid/lib.git#main#${OVERRIDE_SHA}`,
        }),
        /immutable 40-hex commit/,
    );
});

test('overrideGlobalDeps: no env leaves deps unchanged', () => {
    const out = overrideGlobalDeps(freshPkg(), {});
    assert.equal(out.dependencies.achillesAgentLib, BASE);
});

test('overrideGlobalDeps: blank env leaves deps unchanged', () => {
    const out = overrideGlobalDeps(freshPkg(), { PLOINKY_AGENTLIB_REF: '   ' });
    assert.equal(out.dependencies.achillesAgentLib, BASE);
});

test('overrideGlobalDeps: does not touch sibling deps', () => {
    const out = overrideGlobalDeps(freshPkg(), { PLOINKY_AGENTLIB_REF: OVERRIDE_SHA });
    assert.equal(out.dependencies['mcp-sdk'], 'git+https://github.com/AssistOS-AI/MCPSDK.git#main');
});

test('overrideGlobalDeps: unpinned tracked dependency fails closed before override', () => {
    const pkg = freshPkg();
    pkg.dependencies.achillesAgentLib = 'git+https://github.com/AssistOS-AI/achillesAgentLib.git#main';
    assert.throws(
        () => overrideGlobalDeps(pkg, { PLOINKY_AGENTLIB_REF: OVERRIDE_SHA }),
        /tracked achillesAgentLib dependency must use an immutable 40-hex commit/,
    );
});
