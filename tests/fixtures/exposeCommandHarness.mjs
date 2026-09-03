import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const input = JSON.parse(process.argv[2]);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-expose-command-'));
try {
    const manifestPath = path.join(root, 'manifest.json');
    const originalBytes = input.manifestBytes ?? JSON.stringify(input.manifest ?? {});
    if (!input.missingManifest) fs.writeFileSync(manifestPath, originalBytes);
    const selector = { state: input.selectorState || 'active' };
    const trace = [];
    let lockHeld = false;
    const applyLockCapability = Object.freeze({ fixture: 'apply-lock' });
    const context = vm.createContext({ console: { log() {}, error() {} } });
    const stub = (values) => new vm.SyntheticModule(Object.keys(values), function () {
        for (const [name, value] of Object.entries(values)) this.setExport(name, value);
    }, { context });
    const stubs = {
        path: stub({ default: path }),
        fs: stub({ default: {
            ...fs,
            writeFileSync(file, bytes) {
                assert.equal(lockHeld, true);
                assert.notEqual(selector.state, 'active', 'manifest writes must be fail-closed');
                trace.push('write');
                if (input.failWrite) throw new Error('fixture write rejected');
                fs.writeFileSync(file, bytes);
            },
        } }),
        crypto: stub({ randomBytes }),
        help: stub({ showHelp() {} }),
        utils: stub({ findAgent(name) {
            trace.push(`validate-agent:${name}`);
            if (name !== 'demo') throw new Error(`Agent '${name}' not found.`);
            return { manifestPath };
        } }),
        workspace: stub({ getConfig: () => ({ static: { agent: input.staticAgent } }) }),
        secretInjector: stub({ loadSecretsFile() {}, loadEnvFile() {} }),
        encryptedSecretsFile: stub({ deleteSecretValue() {}, readSecretsFile() {}, setSecretValue() {} }),
        masterKey: stub({ deriveAgentSecret() {}, deriveWorkspaceSecret() {} }),
        edgeGeneration: stub({
            withEdgeGenerationApplyLock(callback) {
                assert.equal(lockHeld, false);
                lockHeld = true;
                trace.push('lock-enter');
                try { return callback(applyLockCapability); }
                finally { lockHeld = false; trace.push('lock-exit'); }
            },
            readEdgeRoutingSelection: () => ({ selector }),
            assertActiveEdgeRoutingSourcesCurrent(options) {
                assert.equal(lockHeld, true);
                assert.equal(options.applyLockCapability, applyLockCapability);
                trace.push('assert-active');
                if (input.failSourceCheck) throw new Error('fixture active source changed');
            },
            inactivateEdgeRoutingGeneration(reason, options) {
                assert.equal(lockHeld, true);
                assert.equal(options.applyLockCapability, applyLockCapability);
                assert.equal(reason, 'agent-expose-manifest-change');
                trace.push('inactivate');
                if (input.failInvalidation) throw new Error('fixture invalidation rejected');
                selector.state = 'inactive';
            },
        }),
    };
    const command = new vm.SourceTextModule(fs.readFileSync(path.join(repoRoot, 'cli/commands/envVarCommands.js'), 'utf8'), { context });
    const service = new vm.SourceTextModule(fs.readFileSync(path.join(repoRoot, 'cli/utils/security/secretVars.js'), 'utf8'), { context });
    const link = (id) => {
        if (id.endsWith('secretVars.js')) return service;
        const dependency = stubs[path.basename(id, '.js')];
        if (!dependency) throw new Error(`Unexpected fixture import ${id}`);
        return dependency;
    };
    await service.link(link);
    await command.link(link);
    await command.evaluate();
    const errors = input.commands.map((args) => {
        try { command.namespace.handleExposeCommand(args); return null; }
        catch (error) { return error.message; }
    });
    console.log(JSON.stringify({
        errors,
        selector,
        trace,
        originalBytes,
        manifestBytes: fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath, 'utf8') : null,
    }));
} finally {
    fs.rmSync(root, { recursive: true, force: true });
}
