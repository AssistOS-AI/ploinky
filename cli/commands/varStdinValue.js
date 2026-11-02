export const VAR_STDIN_MAX_BYTES = 1024 * 1024;

// The value of `var NAME --stdin`: strict UTF-8 with one trailing newline
// removed. Both CLI layers apply it, so bad input creates no Box.
export function decodeVarStdinValue(bytes) {
    let value;
    try {
        value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (_) {
        throw new Error('var --stdin input is not valid UTF-8.');
    }
    value = value.replace(/\r?\n$/, '');
    if (!value) {
        throw new Error('var --stdin received an empty value.');
    }
    return value;
}
