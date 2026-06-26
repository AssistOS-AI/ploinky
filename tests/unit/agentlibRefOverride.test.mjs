import test from 'node:test';
import assert from 'node:assert/strict';

// Module import side effects in this tree expect a master key to be present.
process.env.PLOINKY_MASTER_KEY = process.env.PLOINKY_MASTER_KEY || '5'.repeat(64);

const moduleSuffix = `?test=${Date.now()}`;
const depInstallerUrl = new URL('../../cli/services/dependencyInstaller.js', import.meta.url);

const { overrideGlobalDeps } = await import(`${depInstallerUrl.href}${moduleSuffix}`);

// ---------------------------------------------------------------------------
// overrideGlobalDeps: rewrite the achillesAgentLib dependency from env
// ---------------------------------------------------------------------------

const BASE = 'git+https://github.com/AssistOS-AI/achillesAgentLib.git#master';
function freshPkg() {
    return {
        dependencies: {
            achillesAgentLib: BASE,
            'mcp-sdk': 'git+https://github.com/AssistOS-AI/MCPSDK.git#main',
        },
    };
}

test('overrideGlobalDeps: bare branch swaps the ref, preserves URL', () => {
    const out = overrideGlobalDeps(freshPkg(), { PLOINKY_AGENTLIB_REF: 'soul-gateway-local-integration' });
    assert.equal(
        out.dependencies.achillesAgentLib,
        'git+https://github.com/AssistOS-AI/achillesAgentLib.git#soul-gateway-local-integration',
    );
});

test('overrideGlobalDeps: full git+ spec is used verbatim', () => {
    const full = 'git+https://github.com/AssistOS-AI/AchillesAgentLib.git#soul-gateway-local-integration';
    const out = overrideGlobalDeps(freshPkg(), { PLOINKY_AGENTLIB_REF: full });
    assert.equal(out.dependencies.achillesAgentLib, full);
});

test('overrideGlobalDeps: file: spec is used verbatim', () => {
    const out = overrideGlobalDeps(freshPkg(), { PLOINKY_AGENTLIB_REF: 'file:/abs/achillesAgentLib' });
    assert.equal(out.dependencies.achillesAgentLib, 'file:/abs/achillesAgentLib');
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
    const out = overrideGlobalDeps(freshPkg(), { PLOINKY_AGENTLIB_REF: 'br' });
    assert.equal(out.dependencies['mcp-sdk'], 'git+https://github.com/AssistOS-AI/MCPSDK.git#main');
});
