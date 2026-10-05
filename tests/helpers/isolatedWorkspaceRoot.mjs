// Import this FIRST in a unit test that loads product modules which resolve
// the workspace root from the environment or the working directory at import
// time: the test then runs in a fresh private workspace root instead of
// writing `.ploinky/` into the checkout it was started from. A root the
// runner or the test already chose is kept.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!process.env.PLOINKY_WORKSPACE_ROOT) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-test-workspace-')));
    process.env.PLOINKY_WORKSPACE_ROOT = root;
    process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} });
}
