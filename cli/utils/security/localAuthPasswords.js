import crypto from 'crypto';

function safeEqual(left, right) {
    const leftBuf = Buffer.from(String(left || ''), 'utf8');
    const rightBuf = Buffer.from(String(right || ''), 'utf8');
    if (leftBuf.length !== rightBuf.length) return false;
    return crypto.timingSafeEqual(leftBuf, rightBuf);
}

function hashPassword(password, { algorithm = 'scrypt' } = {}) {
    const raw = String(password ?? '');
    if (algorithm === 'sha256') {
        return `sha256:${crypto.createHash('sha256').update(raw, 'utf8').digest('hex')}`;
    }
    if (algorithm === 'scrypt') {
        const salt = crypto.randomBytes(16);
        const derived = crypto.scryptSync(raw, salt, 64);
        return `scrypt:${salt.toString('hex')}:${derived.toString('hex')}`;
    }
    throw new Error(`Unsupported password hash algorithm '${algorithm}'.`);
}

function verifyPasswordHash(password, storedHash) {
    const raw = String(storedHash || '').trim();
    if (!raw) return false;

    if (raw.startsWith('sha256:')) {
        const expected = raw.slice('sha256:'.length).trim().toLowerCase();
        const actual = crypto.createHash('sha256').update(String(password || ''), 'utf8').digest('hex');
        return safeEqual(actual, expected);
    }

    if (raw.startsWith('scrypt:')) {
        const [, saltHex = '', keyHex = ''] = raw.split(':');
        if (!saltHex || !keyHex) return false;
        const salt = Buffer.from(saltHex, 'hex');
        const expected = Buffer.from(keyHex, 'hex');
        const actual = crypto.scryptSync(String(password || ''), salt, expected.length);
        return crypto.timingSafeEqual(actual, expected);
    }

    return false;
}

export {
    hashPassword,
    verifyPasswordHash
};
