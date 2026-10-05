// CPU precision, the exact expected quota and the readback comparison
// (plan §8.1, §18.4; amendment A3). Pure integer arithmetic over the shared
// helper; no engine or filesystem is touched.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
    CPU_PERIOD_US,
    cpuMaxMatches,
    cpuQuotaFor,
    cpuQuotaMatches,
    nanoCpusMatches,
    parseAdmittedCpus,
} from '../../cli/sandbox/hardwareLimits/cpuQuota.mjs';

test('CPU.admission-accepts-up-to-two-decimals-and-canonicalizes', () => {
    for (const [value, canonical] of [['0.29', '0.29'], [0.57, '0.57'], ['1.13', '1.13'], ['0.01', '0.01'], ['0.50', '0.5'], [0.5, '0.5'], ['1.0', '1'], ['2', '2'], ['16.00', '16'], ['0.500', '0.5']]) {
        const admitted = parseAdmittedCpus(value);
        assert.equal(admitted.ok, true, String(value));
        assert.equal(admitted.canonical, canonical, String(value));
    }
    // 0.5 and 0.50 are one value, with one quota.
    assert.equal(cpuQuotaFor('0.50'), cpuQuotaFor(0.5));
});

test('CPU.admission-refuses-finer-precision-and-never-rounds', () => {
    for (const value of ['0.123456', '0.005', '0.001', '0.000005', '0.004999', '0.004', '1.234', '0.00001', '0.30000000000000004', 0.1 + 0.2, '0', 0, '', ' ', '-1', -1, 'NaN', NaN, Infinity, 'Infinity', null, undefined, '1e-2', 1e-7, '.5', '0x10', '9'.repeat(40)]) {
        const admitted = parseAdmittedCpus(value);
        assert.equal(admitted.ok, false, String(value));
        assert.ok(admitted.reason, String(value));
    }
    assert.equal(parseAdmittedCpus('0.005').reason, 'has more than two decimal places');
    // The administrator minimum is 0.05 (plan §18.4): 0.04 is refused, 0.05 accepted.
    assert.equal(parseAdmittedCpus('0.04', { minimumHundredths: 5 }).ok, false);
    assert.equal(parseAdmittedCpus('0.05', { minimumHundredths: 5 }).ok, true);
    assert.equal(parseAdmittedCpus('0.01', { minimumHundredths: 5 }).ok, false);
    assert.throws(() => cpuQuotaFor('0.123456'), RangeError);
});

test('CPU.readback-accepts-the-exact-quota-and-the-engine-truncation-only', () => {
    // Podman 6.0.1 and 5.7.0 write 28999 for --cpus 0.29 (period 100000).
    assert.equal(cpuQuotaFor('0.29'), 29000);
    assert.equal(CPU_PERIOD_US, 100000);
    for (const text of ['28999 100000', '29000 100000', '29000 100000\n']) assert.equal(cpuMaxMatches(text, '0.29'), true, text);
    for (const text of ['28998 100000', '29001 100000', '29000 50000', '29000 100001', 'max 100000', 'max', '', '29000', '29000 100000 1', '-29000 100000', '29000.0 100000']) assert.equal(cpuMaxMatches(text, '0.29'), false, text);
    assert.equal(cpuQuotaMatches(28999, 100000, '0.29'), true);
    assert.equal(cpuQuotaMatches(28999, 50000, '0.29'), false);
    assert.equal(cpuQuotaMatches('29000', '100000', '0.29'), true);
    // The unadmissible desired value never matches anything.
    assert.equal(cpuMaxMatches('12345 100000', '0.123456'), false);
    // NanoCpus is quota * 10000 on both engines.
    assert.equal(nanoCpusMatches(289990000, '0.29'), true);
    assert.equal(nanoCpusMatches(290000000, '0.29'), true);
    assert.equal(nanoCpusMatches(289980000, '0.29'), false);
    assert.equal(nanoCpusMatches(289999999, '0.29'), false);
    assert.equal(nanoCpusMatches(500000000, '0.5'), true);
});

// Every two-decimal value from 0.01 to 16.00: the engine's floating-point
// truncation (observed: 79 of the 1600 values) reads back one microsecond
// short, and the readback accepts it; one microsecond more, or less, fails.
test('CPU.readback-accepts-every-two-decimal-value-as-podman-truncates-it', () => {
    let truncated = 0;
    for (let hundredths = 1; hundredths <= 1600; hundredths += 1) {
        const text = (hundredths / 100).toFixed(2);
        const exact = hundredths * 1000;
        assert.equal(cpuQuotaFor(text), exact, text);
        // The engine's conversion: binary floating point, truncated.
        const engine = Math.floor(Number(text) * 100000);
        if (engine !== exact) truncated += 1;
        assert.ok(engine === exact || engine === exact - 1, `${text}: engine quota ${engine}`);
        assert.equal(cpuQuotaMatches(engine, 100000, text), true, text);
        assert.equal(cpuQuotaMatches(exact, 100000, text), true, text);
        assert.equal(cpuQuotaMatches(exact - 2, 100000, text), false, text);
        assert.equal(cpuQuotaMatches(exact + 1, 100000, text), false, text);
    }
    assert.equal(truncated, 79, 'the observed number of values the engine truncates');
});
