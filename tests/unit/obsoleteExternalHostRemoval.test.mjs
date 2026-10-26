import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The two-phase external-host admission was replaced by ordinary publication
// of externally managed DNS hosts. This guards against its partial return.
const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SELF = fileURLToPath(import.meta.url);

// Assembled so this file never contains the names it forbids.
const FORBIDDEN_NAMES = [
    ['externalHost', 'Admission'],
    ['externalHost', 'Journal'],
    ['externalHost', 'Controller'],
    ['externalHost', 'Commands'],
    ['browserMutation', 'Routes'],
    ['previousSelector', 'Digest'],
    ['ready', '-partial'],
    ['EXTERNAL_', 'INACTIVATION'],
].map((parts) => parts.join(''));

const REMOVED_FILES = [
    `cli/commands/${FORBIDDEN_NAMES[3]}.mjs`,
    `cli/sandbox/${FORBIDDEN_NAMES[0]}.mjs`,
    `ploinky-box/cloudflared/${FORBIDDEN_NAMES[2]}.mjs`,
    `ploinky-box/cloudflared/${FORBIDDEN_NAMES[1]}.mjs`,
    `tests/unit/${FORBIDDEN_NAMES[0]}.test.mjs`,
    `tests/unit/${FORBIDDEN_NAMES[4]}.test.mjs`,
];

const SEARCH_ROOTS = ['cli', 'ploinky-box', 'tests/unit', 'README.md'];

// sha256 at 7ff252cb, except the reviewed authentication event wiring below.
const BASE_FILES = {
    // 8c0eec56 adds only the authenticated-request event import and publication;
    // the removed admission logic has not returned. Keep the exact-file guard.
    'cli/server/authHandlers/authContext.js': '3304ae9c746b1cec40c3525e9c69b877db4b62fef262496f6182406241877850',
    'ploinky-box/cloudflared/runtime.mjs': 'bb50780910dfe09c237f1930eb034947752adc1bb701d6fd5126a5945f886a2a',
    'ploinky-box/cloudflared/status.mjs': '34e5055dddf9073890e5643ada17176295014225b5a9d183439f4cb94636b2a0',
    'ploinky-box/cloudflared/journal.mjs': '4969c853c230668265cc05f7276d95e3ee677ae2e77de969881295de7622799a',
    'ploinky-box/cloudflared/managedTunnelRegistry.mjs': '6203d1e05581cac8f33b28f7c826562ac7309489681318a67ac62e53d60d2a26',
    'tests/unit/cloudflarePublicationRuntime.test.mjs': 'd96beb52646a22e55c891bb7395245cf6e1fc9a945f219697cafe8805d9d28c2',
};

function* sourceFiles(target) {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) return;
    if (stat.isFile()) {
        yield target;
        return;
    }
    if (!stat.isDirectory()) return;
    for (const entry of fs.readdirSync(target)) {
        if (entry === 'node_modules' || entry === '.git') continue;
        yield* sourceFiles(path.join(target, entry));
    }
}

test('the two-phase external-host modules and their tests stay deleted', () => {
    for (const file of REMOVED_FILES) {
        assert.equal(fs.existsSync(path.join(REPO_ROOT, file)), false, file);
    }
});

test('no source, test or README reference to the external-host admission remains', () => {
    const hits = [];
    let scanned = 0;
    for (const root of SEARCH_ROOTS) {
        for (const file of sourceFiles(path.join(REPO_ROOT, root))) {
            if (file === SELF) continue;
            scanned += 1;
            const text = fs.readFileSync(file, 'utf8');
            for (const name of FORBIDDEN_NAMES) {
                if (text.includes(name)) hits.push(`${path.relative(REPO_ROOT, file)}: ${name}`);
            }
        }
    }
    assert.ok(scanned > 100, `scanned only ${scanned} files`);
    assert.deepEqual(hits, []);
});

test('files the admission had changed match their reviewed fingerprints', () => {
    for (const [file, digest] of Object.entries(BASE_FILES)) {
        const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO_ROOT, file))).digest('hex');
        assert.equal(actual, digest, file);
    }
});
