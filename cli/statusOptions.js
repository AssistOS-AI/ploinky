const STATUS_USAGE = 'Usage: status [--verbose]';

/**
 * Parse the deliberately small, read-only status option surface.
 *
 * Global debug is handled before command dispatch; for status it implies the
 * same diagnostic detail as --verbose without changing status into a normal
 * bootstrap/reconciliation command.
 */
export function parseStatusOptions(options = [], { debug = false } = {}) {
    if (!Array.isArray(options) || options.some((value) => typeof value !== 'string')) {
        throw new TypeError('Status options must be an array of strings');
    }
    if (options.length > 1 || (options.length === 1 && options[0] !== '--verbose')) {
        throw new Error(STATUS_USAGE);
    }
    return Object.freeze({ verbose: Boolean(debug || options[0] === '--verbose') });
}

export { STATUS_USAGE };
