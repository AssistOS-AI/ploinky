import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-manifest-image-'));
const originalCwd = process.cwd();
const originalMasterKey = process.env.PLOINKY_MASTER_KEY;

process.chdir(workspace);
delete process.env.PLOINKY_MASTER_KEY;

const moduleNonce = Date.now();
const { resolveManifestImage } = await import(
    `${pathToFileURL(path.join(repoRoot, 'cli/utils/security/secretVars.js')).href}?test=${moduleNonce}`
);

test.after(() => {
    process.chdir(originalCwd);
    fs.rmSync(workspace, { recursive: true, force: true });
    if (originalMasterKey === undefined) {
        delete process.env.PLOINKY_MASTER_KEY;
    } else {
        process.env.PLOINKY_MASTER_KEY = originalMasterKey;
    }
});

test('resolveManifestImage can use manifest defaults when the master key is absent', () => {
    const manifest = {
        container: 'example/service:${SERVICE_VERSION}',
        env: [
            {
                name: 'SERVICE_VERSION',
                default: 'v1.2.3',
            },
        ],
    };

    assert.equal(resolveManifestImage(manifest), 'example/service:v1.2.3');
});

test('resolveManifestImage fails closed when encrypted secrets are corrupt', () => {
    fs.mkdirSync(path.join(workspace, '.ploinky'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.ploinky/.secrets'), 'not-a-valid-envelope\n');
    process.env.PLOINKY_MASTER_KEY = '8'.repeat(64);

    const manifest = {
        container: 'example/service:${SERVICE_VERSION}',
        env: [
            {
                name: 'SERVICE_VERSION',
                default: 'v1.2.3',
            },
        ],
    };

    assert.throws(
        () => resolveManifestImage(manifest),
        /Unable to decrypt .ploinky\/.secrets/,
    );
});
