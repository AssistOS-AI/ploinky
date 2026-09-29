import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as ploinky from '../../cli/utils/skills/exportTransaction.mjs';
import * as ploinkyExclusions from '../../cli/utils/skills/exportExclusions.mjs';
import { scenarios, contentionScenario } from './fixtures/skillExportConformanceScenarios.mjs';

const temporary = t => label => {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `skill-tx-${label}-`)));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
};

for (const scenario of scenarios) {
    test(`ploinky protocol: ${scenario.name}`, t => scenario.run({ mod: ploinky, exclusions: ploinkyExclusions, tmp: temporary(t) }));
}

test('two Ploinky exporter instances exclude and recover each other on one folder', t => {
    contentionScenario({ first: ploinky, second: ploinky, tmp: temporary(t) });
});
