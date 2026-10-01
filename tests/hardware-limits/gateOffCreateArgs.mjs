// Test-only: the gate-off Box create argv for one fixed fixture, normalized so
// it can be compared across source trees. Run it against the baseline export
// to capture the golden file, and import it from the candidate test:
//
//   node tests/hardware-limits/gateOffCreateArgs.mjs REPOSITORY_ROOT
//
// Paths and path-derived identities (workspace root, repository root, home,
// workspace path hash, AgentLib source id) are replaced by placeholders; every
// other byte of the argv is compared exactly.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function normalizedGateOffCreateArgs(repositoryRoot, { extra = {} } = {}) {
    const root = path.resolve(repositoryRoot);
    const load = (relative) => import(pathToFileURL(path.join(root, relative)).href);
    const { containerCreateArgs } = await load('ploinky-box/lifecycle/container.mjs');
    const { buildWorkspaceIdentity } = await load('ploinky-box/identity.mjs');
    const { BOX_IMAGE_REFERENCE } = await load('ploinky-box/constants.mjs');
    const { agentLibFixture } = await load('tests/helpers/agentlibFixture.mjs');
    const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-golden-')));
    try {
        const workspace = path.join(scratch, 'workspace');
        fs.mkdirSync(path.join(workspace, '.ploinky'), { recursive: true });
        const identity = buildWorkspaceIdentity(workspace, { markerFound: true });
        const agentLib = agentLibFixture(identity.workspaceRoot);
        const argv = containerCreateArgs({
            identity,
            dataFingerprints: { dependencies: 'd'.repeat(64), images: 'e'.repeat(64) },
            agentLib,
            imageId: `sha256:${'b'.repeat(64)}`,
            imageRef: BOX_IMAGE_REFERENCE,
            hostPort: 8080,
            repositoryRoot: root,
            cidfile: path.join(scratch, 'box.cid'),
            ...extra,
        });
        const replacements = [
            [scratch, '<SCRATCH>'],
            [root, '<REPOSITORY>'],
            [os.homedir(), '<HOME>'],
            [identity.pathHash, '<PATHHASH>'],
            ...(agentLib.sourceIdHash ? [[agentLib.sourceIdHash, '<AGENTLIB_SOURCE_ID>']] : []),
        ];
        return argv.map((value) => replacements.reduce((text, [from, to]) => text.split(from).join(to), String(value)));
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
}

if (process.argv[1] && pathToFileURL(fs.realpathSync(process.argv[1])).href === import.meta.url) {
    const argv = await normalizedGateOffCreateArgs(process.argv[2]);
    process.stdout.write(`${JSON.stringify(argv, null, 2)}\n`);
}
