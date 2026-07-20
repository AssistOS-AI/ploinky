import crypto from 'crypto';
import * as secretVars from '../../utils/security/secretVars.js';

const TOKEN_VARS = {
    dashboard: 'WEBDASHBOARD_TOKEN',
    status: 'WEBDASHBOARD_TOKEN'
};

function loadToken(component) {
    const varName = TOKEN_VARS[component];
    if (!varName) throw new Error(`Unknown component '${component}'`);
    const fromEnv = (key) => {
        const raw = process.env[key];
        return raw && String(raw).trim();
    };
    let token = '';
    let source = 'secrets';
    try {
        const secrets = secretVars.parseSecrets();
        const raw = secrets[varName];
        if (raw && String(raw).trim()) {
            token = secretVars.resolveVarValue(varName);
        }
    } catch (_) {
        token = '';
    }
    if (!token) {
        const envToken = fromEnv(varName) || '';
        if (envToken) {
            token = envToken;
            source = 'env';
        }
    }
    if (!token) {
        token = crypto.randomBytes(32).toString('hex');
        source = 'generated';
    }
    if (source !== 'secrets') {
        try { secretVars.setEnvVar(varName, token); } catch (_) { }
    }
    return token;
}

function parseCookies(req) {
    const header = req.headers.cookie || '';
    const map = new Map();
    header.split(';').forEach((cookie) => {
        const idx = cookie.indexOf('=');
        if (idx > -1) {
            const key = cookie.slice(0, idx).trim();
            const value = cookie.slice(idx + 1).trim();
            if (key) map.set(key, value);
        }
    });
    return map;
}

function buildCookie(name, value, req, pathPrefix, options = {}) {
    const parts = [`${name}=${value}`];
    const prefix = pathPrefix || '/';
    parts.push(`Path=${prefix}`);
    parts.push('HttpOnly');
    const sameSite = String(options.sameSite || 'Strict').trim() || 'Strict';
    parts.push(`SameSite=${sameSite}`);
    const secure = Boolean(req.socket && req.socket.encrypted) ||
        String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https';
    if (secure) parts.push('Secure');
    // Use custom maxAge when provided (including 0), otherwise default to 7 days
    const maxAge = options.maxAge ?? 604800;
    parts.push(`Max-Age=${maxAge}`);
    return parts.join('; ');
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            try {
                const raw = Buffer.concat(chunks).toString('utf8');
                resolve(raw ? JSON.parse(raw) : {});
            } catch (err) {
                reject(err);
            }
        });
        req.on('error', reject);
    });
}

function appendSetCookie(res, cookie) {
    if (!cookie) return;
    const existing = res.getHeader('Set-Cookie');
    if (!existing) {
        res.setHeader('Set-Cookie', cookie);
        return;
    }
    if (Array.isArray(existing)) {
        res.setHeader('Set-Cookie', [...existing, cookie]);
    } else {
        res.setHeader('Set-Cookie', [existing, cookie]);
    }
}

function parseMultipartFormData(req) {
    return new Promise((resolve, reject) => {
        const contentType = req.headers['content-type'] || '';
        const boundaryMatch = contentType.match(/boundary=(.+?)(?:;|$)/);

        if (!boundaryMatch) {
            reject(new Error('No boundary found in Content-Type'));
            return;
        }

        const boundary = '--' + boundaryMatch[1];
        const chunks = [];

        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            try {
                const buffer = Buffer.concat(chunks);
                const parts = [];
                let start = 0;

                while (start < buffer.length) {
                    const boundaryIndex = buffer.indexOf(boundary, start);
                    if (boundaryIndex === -1) break;

                    const nextStart = boundaryIndex + boundary.length;
                    if (buffer[nextStart] === 0x2D && buffer[nextStart + 1] === 0x2D) {
                        // End boundary
                        break;
                    }

                    // Skip CRLF after boundary
                    start = nextStart + 2;

                    // Find end of headers
                    const headerEndIndex = buffer.indexOf('\r\n\r\n', start);
                    if (headerEndIndex === -1) break;

                    const headerSection = buffer.slice(start, headerEndIndex).toString('utf8');
                    const headers = {};

                    headerSection.split('\r\n').forEach(line => {
                        const colonIndex = line.indexOf(':');
                        if (colonIndex > -1) {
                            const key = line.slice(0, colonIndex).trim().toLowerCase();
                            const value = line.slice(colonIndex + 1).trim();
                            headers[key] = value;
                        }
                    });

                    // Extract field name and filename from Content-Disposition
                    const disposition = headers['content-disposition'] || '';
                    const nameMatch = disposition.match(/name="([^"]+)"/);
                    const filenameMatch = disposition.match(/filename="([^"]+)"/);

                    // Find start of content
                    const contentStart = headerEndIndex + 4;

                    // Find next boundary
                    const nextBoundary = buffer.indexOf('\r\n' + boundary, contentStart);
                    const contentEnd = nextBoundary > -1 ? nextBoundary : buffer.length;

                    const content = buffer.slice(contentStart, contentEnd);

                    if (nameMatch) {
                        parts.push({
                            name: nameMatch[1],
                            filename: filenameMatch ? filenameMatch[1] : null,
                            contentType: headers['content-type'] || 'text/plain',
                            data: content,
                            text: filenameMatch ? null : content.toString('utf8')
                        });
                    }

                    start = contentEnd;
                }

                const fields = {};
                const files = {};

                parts.forEach(part => {
                    if (part.filename) {
                        files[part.name] = part;
                    } else {
                        fields[part.name] = part.text;
                    }
                });

                resolve({ fields, files });
            } catch (err) {
                reject(err);
            }
        });
        req.on('error', reject);
    });
}

export {
    loadToken,
    parseCookies,
    buildCookie,
    readJsonBody,
    appendSetCookie,
    parseMultipartFormData
};
