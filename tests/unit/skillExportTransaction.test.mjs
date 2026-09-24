import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as ploinky from '../../cli/utils/skills/exportTransaction.mjs';
import * as ploinkyExclusions from '../../cli/utils/skills/exportExclusions.mjs';
import { scenarios, contentionScenario } from './fixtures/skillExportConformanceScenarios.mjs';

const PROTOCOL = 'explorer/utils/server/skill-export-transaction.mjs';
const EXCLUSIONS = 'explorer/utils/server/skill-export-exclusions.mjs';
const SCENARIOS = 'explorer/tests/unit/skillExportConformanceScenarios.mjs';

const temporary = t => label => {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `skill-tx-${label}-`)));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
};

// The Explorer copy lives in a sibling checkout; PLOINKY_TEST_EXPLORER_CHECKOUT
// points isolated test exports at it.
function explorerCheckout() {
    const candidates = [
        process.env.PLOINKY_TEST_EXPLORER_CHECKOUT,
        fileURLToPath(new URL('../../../AssistOSExplorer', import.meta.url)),
    ].filter(Boolean);
    return candidates.find(candidate => fs.existsSync(path.join(candidate, PROTOCOL))) || null;
}

const explorerRoot = explorerCheckout();
const explorer = explorerRoot ? await import(pathToFileURL(path.join(explorerRoot, PROTOCOL)).href) : null;
const explorerExclusions = explorerRoot ? await import(pathToFileURL(path.join(explorerRoot, EXCLUSIONS)).href) : null;
const skipReason = 'AssistOSExplorer checkout not present (set PLOINKY_TEST_EXPLORER_CHECKOUT)';

for (const scenario of scenarios) {
    test(`ploinky protocol: ${scenario.name}`, t => scenario.run({ mod: ploinky, exclusions: ploinkyExclusions, tmp: temporary(t) }));
}

test('Explorer protocol and conformance scenarios are byte-identical paired copies', t => {
    if (!explorerRoot) { t.skip(skipReason); return; }
    const local = file => fs.readFileSync(fileURLToPath(new URL(file, import.meta.url)));
    assert.ok(local('../../cli/utils/skills/exportTransaction.mjs').equals(fs.readFileSync(path.join(explorerRoot, PROTOCOL))));
    assert.ok(local('./fixtures/skillExportConformanceScenarios.mjs').equals(fs.readFileSync(path.join(explorerRoot, SCENARIOS))));
    assert.ok(local('../../cli/utils/skills/exportExclusions.mjs').equals(fs.readFileSync(path.join(explorerRoot, EXCLUSIONS))));
});

for (const scenario of scenarios) {
    test(`explorer protocol: ${scenario.name}`, t => {
        if (!explorer) { t.skip(skipReason); return; }
        scenario.run({ mod: explorer, exclusions: explorerExclusions, tmp: temporary(t) });
    });
}

test('Ploinky and Explorer exporters exclude and recover each other on one folder', t => {
    if (!explorer) { t.skip(skipReason); return; }
    contentionScenario({ first: ploinky, second: explorer, tmp: temporary(t) });
    contentionScenario({ first: explorer, second: ploinky, tmp: temporary(t) });
});

test('two Ploinky exporter instances exclude and recover each other on one folder', t => {
    contentionScenario({ first: ploinky, second: ploinky, tmp: temporary(t) });
});
