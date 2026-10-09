// Guest session cookie helpers for tests.
//
// Guest cookies are per guest route (`ploinky_guest_<22 chars>`), with the
// retired shared `ploinky_guest` name still recognized. Absence assertions
// must match the whole family, otherwise they pass vacuously.

/** Matches any guest cookie name carrying a non-empty value in a Set-Cookie or Cookie string. */
export const ANY_GUEST_SET_COOKIE = /(?:^|[,;\s])ploinky_guest[A-Za-z0-9_-]*=[^;,\s]/;

function setCookieLines(res) {
    return [res?.getHeader?.('set-cookie')].flat().filter(Boolean).map(String);
}

function parseSetCookie(line) {
    const [pair, ...attributes] = String(line).split(';').map((part) => part.trim());
    const index = pair.indexOf('=');
    if (index <= 0) return null;
    const maxAge = attributes
        .map((attribute) => /^max-age=(-?\d+)$/i.exec(attribute)?.[1])
        .find((value) => value !== undefined);
    return {
        name: pair.slice(0, index),
        value: pair.slice(index + 1),
        maxAge: maxAge === undefined ? null : Number(maxAge),
        attributes,
    };
}

/** Every Set-Cookie of the response, parsed. */
export function setCookies(res) {
    return setCookieLines(res).map(parseSetCookie).filter(Boolean);
}

/** The guest Set-Cookies of a response: [{ name, value, maxAge, attributes }]. */
export function guestSetCookies(res) {
    return setCookies(res).filter((cookie) => cookie.name.startsWith('ploinky_guest'));
}

/** A browser-like cookie jar: Set-Cookie replaces by name, Max-Age<=0 or an empty value removes. */
export class GuestCookieJar {
    constructor(entries = []) {
        this.cookies = new Map(entries);
    }

    apply(res) {
        for (const cookie of setCookies(res)) {
            if (!cookie.value || (cookie.maxAge !== null && cookie.maxAge <= 0)) this.cookies.delete(cookie.name);
            else this.cookies.set(cookie.name, cookie.value);
        }
        return this;
    }

    get(name) {
        return this.cookies.get(name);
    }

    set(name, value) {
        this.cookies.set(name, value);
        return this;
    }

    delete(name) {
        this.cookies.delete(name);
        return this;
    }

    names() {
        return [...this.cookies.keys()];
    }

    guestNames() {
        return this.names().filter((name) => name.startsWith('ploinky_guest')).sort();
    }

    header() {
        return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    }

    clone() {
        return new GuestCookieJar([...this.cookies]);
    }
}
