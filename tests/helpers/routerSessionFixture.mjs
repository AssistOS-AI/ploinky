import { JwsCodec } from '../../cli/server/security/tokens/JwsCodec.js';
import { deriveSubkey } from '../../cli/utils/security/masterKey.js';

// Security fixtures deliberately include token kinds the runtime no longer issues.
export function signBrowserSessionFixture(user) {
    const now = Math.floor(Date.now() / 1000);
    return new JwsCodec().sign({ secret: deriveSubkey('session'), payload: {
        typ: 'user-session', iss: 'ploinky-router', aud: 'ploinky-router',
        sub: user.id, usr: user, sid: 'retired-browser-session', jti: 'retired-browser-token',
        iat: now, exp: now + 3600, rev: 1,
    } });
}
