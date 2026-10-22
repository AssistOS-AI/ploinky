// The cache observer that runs inside the local-llm agent container imports the controller's path resolver from the pworker
// engine package, which Ploinky binds read-only at /code/node_modules. Offline: a directory laid out as that bind, with the
// node binary of this test as the container's node.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { MEASUREMENT_DOWNLOADER_MODULE, MEASUREMENT_WEIGHTS } from '../hardware-limits/liveModelMeasurementCommands.mjs';

test('MEASURE-IMPORT.the-weights-observer-imports-the-engines-downloader-by-the-path-of-the-agents-dependency-bind', () => {
    assert.equal(MEASUREMENT_DOWNLOADER_MODULE, '/code/node_modules/pworker/lib/local-llm/controller/downloader.mjs');
    assert.ok(MEASUREMENT_WEIGHTS.includes(`import(${JSON.stringify(MEASUREMENT_DOWNLOADER_MODULE)})`));
    assert.equal(MEASUREMENT_WEIGHTS.includes('/code/src/controller/downloader.mjs'), false, 'the moved path is gone');
    assert.doesNotMatch(MEASUREMENT_WEIGHTS, /import\((['"])pworker/, 'no bare specifier: an eval script resolves it from its working directory');
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-mi-')));
    try {
        // The bind: the agent's dependency store, with the package laid out as the engine ships it.
        const downloader = path.join(root, 'code', 'node_modules', 'pworker', 'lib', 'local-llm', 'controller', 'downloader.mjs');
        fs.mkdirSync(path.dirname(downloader), { recursive: true });
        fs.writeFileSync(path.join(root, 'code', 'node_modules', 'pworker', 'package.json'), JSON.stringify({ name: 'pworker', type: 'module' }));
        fs.writeFileSync(downloader, "import path from 'node:path';\nexport function artifactPaths({ root, artifact }) { return { file: path.join(path.resolve(root), ...artifact.repo.split('/'), artifact.commit, ...artifact.file.split('/')) }; }\n");
        const weights = path.join(root, 'gguf');
        const bytes = Buffer.from('hello');
        const pin = { repo: 'Org/Repo', commit: 'c'.repeat(40), file: 'model.gguf', size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
        fs.mkdirSync(path.join(weights, 'Org', 'Repo', pin.commit), { recursive: true });
        fs.writeFileSync(path.join(weights, 'Org', 'Repo', pin.commit, 'model.gguf'), bytes);
        // The only two substitutions: where the bind is mounted on this host, and the controller's cache root.
        const snippet = MEASUREMENT_WEIGHTS.replace(MEASUREMENT_DOWNLOADER_MODULE, downloader).replace("'/data/models/gguf'", JSON.stringify(weights));
        assert.ok(snippet.includes(downloader) && snippet.includes(weights), 'both substitutions applied');
        // The working directory is not the package's: only the absolute path can find it.
        const run = spawnSync(process.execPath, ['-e', snippet, JSON.stringify(pin)], { cwd: os.tmpdir(), encoding: 'utf8', env: { PATH: process.env.PATH } });
        assert.equal(run.status, 0, run.stderr);
        assert.deepEqual(JSON.parse(run.stdout).files, [{ file: 'model.gguf', size: 5, sha256: pin.sha256 }]);
        // Control: outside the container the unsubstituted snippet finds no module and reports the bounded failure.
        const missing = spawnSync(process.execPath, ['-e', MEASUREMENT_WEIGHTS, JSON.stringify(pin)], { cwd: os.tmpdir(), encoding: 'utf8', env: { PATH: process.env.PATH } });
        assert.equal(missing.status, 3);
        assert.match(missing.stderr, /Bounded weights observation failed/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
