import test from 'node:test';
import assert from 'node:assert/strict';

const moduleSuffix = `?t=${Date.now()}-${Math.random()}`;
const { JwsCodec } = await import(`../../cli/server/security/tokens/JwsCodec.js${moduleSuffix}`);

test('JwsCodec delegates signing and verification to injected primitives', async () => {
    const calls = [];
    const codec = new JwsCodec({
        signHmacJwt: async (input) => {
            calls.push(['sign', input]);
            return 'signed.jwt';
        },
        verifyJws: async (token, options) => {
            calls.push(['verify', token, options]);
            return { payload: { sub: 'user-1' }, protectedHeader: { alg: 'HS256' } };
        },
    });

    assert.equal(await codec.signHmacJwt({ payload: { sub: 'user-1' }, secret: 'secret' }), 'signed.jwt');
    assert.deepEqual(await codec.verifyJws('signed.jwt', { secret: 'secret' }), {
        payload: { sub: 'user-1' },
        protectedHeader: { alg: 'HS256' },
    });
    assert.equal(calls.length, 2);
});
