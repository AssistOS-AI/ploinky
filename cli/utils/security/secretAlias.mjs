// Follows `$NAME` aliases between workspace variables. No imports: it also runs in the Box inbox programs.
export function resolveSecretAlias(value, secrets, seen = new Set()) {
    if (typeof value !== 'string') return value;
    if (!value.startsWith('$')) return value;
    const ref = value.slice(1);
    if (!ref || seen.has(ref)) return '';
    seen.add(ref);
    const next = secrets[ref];
    if (next === undefined) return '';
    return resolveSecretAlias(next, secrets, seen);
}
