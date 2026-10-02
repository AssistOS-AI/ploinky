// CPU limit precision, the exact expected quota and the readback comparison
// (plan §8.1, §18.4 and amendment A3). Pure integer arithmetic: a quota is
// never computed or compared through floating point.
//
// Observed engine behaviour (Podman 6.0.1 on macOS and 5.7.0 on Linux,
// throwaway never-started containers, 2026-10-02). `--cpus V` converts V
// through binary floating point and TRUNCATES the quota; the period is always
// 100000 and NanoCpus is exactly quota * 10000:
//   --cpus 0.29     CpuQuota 28999   (exact 29000)
//   --cpus 0.57     CpuQuota 56999   (exact 57000)
//   --cpus 1.13     CpuQuota 112999  (exact 113000)
//   --cpus 0.123456 CpuQuota 12345   (five-decimal values are truncated too)
//   --cpus 0.01     CpuQuota 1000    (the kernel refuses a CFS quota below 1000)
// So a value with at most two decimals reads back as N or N-1, where N is the
// exact quota; 79 of the 1600 two-decimal values from 0.01 to 16.00 read back
// as N-1. Anything else, or any other period, is a mismatch.

export const CPU_PERIOD_US = 100000;
export const MIN_DECLARED_CPU_HUNDREDTHS = 1;
export const MIN_ADMINISTRATOR_CPU_HUNDREDTHS = 5;

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/**
 * A cpus value as an admitted decimal: a finite non-negative decimal with at
 * most two decimal places (trailing zeros carry no precision), at least
 * `minimumHundredths`. Never rounded. Returns `{ ok: true, hundredths,
 * canonical }` or `{ ok: false, reason }`; `canonical` is the decimal that is
 * rendered after `--cpus` and hashed (0.5 and 0.50 are one value).
 */
export function parseAdmittedCpus(value, { minimumHundredths = MIN_DECLARED_CPU_HUNDREDTHS } = {}) {
    if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) {
        return { ok: false, reason: 'must be a decimal number' };
    }
    const text = typeof value === 'number' ? numberText(value) : value.trim();
    const match = text === null ? null : DECIMAL.exec(text);
    if (!match) return { ok: false, reason: 'must be a plain finite decimal number' };
    const fraction = (match[2] || '').replace(/0+$/, '');
    if (fraction.length > 2) return { ok: false, reason: 'has more than two decimal places' };
    const whole = match[1].replace(/^0+(?=\d)/, '');
    if (whole.length > 9) return { ok: false, reason: 'is too large' };
    const hundredths = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
    if (!Number.isSafeInteger(hundredths * 1000)) return { ok: false, reason: 'is too large' };
    if (hundredths < minimumHundredths) {
        return { ok: false, reason: `is below the ${(minimumHundredths / 100).toFixed(2)} minimum` };
    }
    const rest = String(hundredths % 100).padStart(2, '0').replace(/0+$/, '');
    return { ok: true, hundredths, canonical: rest ? `${Math.floor(hundredths / 100)}.${rest}` : String(Math.floor(hundredths / 100)) };
}

// The decimal text of a JS number without an exponent, or null.
function numberText(value) {
    const text = String(value);
    return /e/i.test(text) ? null : text;
}

/** The exact integer quota, in microseconds at the 100000 period, of a canonical decimal. */
export function cpuQuotaFor(value) {
    const parsed = parseAdmittedCpus(value);
    if (!parsed.ok) throw new RangeError(`cpus ${String(value)} ${parsed.reason}`);
    return parsed.hundredths * 1000;
}

function integer(value) {
    const text = String(value ?? '').trim();
    if (!/^\d+$/.test(text)) return null;
    const number = Number(text);
    return Number.isSafeInteger(number) ? number : null;
}

/**
 * Does an observed quota/period (cpu.max, CpuQuota with CpuPeriod) match the
 * desired cpus? The period must be exactly 100000 and the quota N or N-1.
 */
export function cpuQuotaMatches(quota, period, desired) {
    const parsed = parseAdmittedCpus(desired);
    const observedQuota = integer(quota);
    if (!parsed.ok || observedQuota === null || integer(period) !== CPU_PERIOD_US) return false;
    const exact = parsed.hundredths * 1000;
    return observedQuota === exact || observedQuota === exact - 1;
}

/** The same comparison for the text of a cgroup v2 cpu.max file ("QUOTA PERIOD"). */
export function cpuMaxMatches(cpuMax, desired) {
    const parts = String(cpuMax ?? '').trim().split(/\s+/);
    return parts.length === 2 && cpuQuotaMatches(parts[0], parts[1], desired);
}

/** The same comparison for an engine's NanoCpus, which is quota * 10000. */
export function nanoCpusMatches(nanoCpus, desired) {
    const nano = integer(nanoCpus);
    return nano !== null && nano % 10000 === 0 && cpuQuotaMatches(nano / 10000, CPU_PERIOD_US, desired);
}
