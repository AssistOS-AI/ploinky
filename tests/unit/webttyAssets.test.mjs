import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const vendorDirectory = path.resolve('cli/server/webtty/vendor');

test('vendored WebTTY assets are exact maintained xterm distributions with licenses', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(vendorDirectory, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.packages, {
        '@xterm/xterm': '6.0.0',
        '@xterm/addon-fit': '0.11.0',
    });
    assert.deepEqual(Object.keys(manifest.files).sort(), [
        'LICENSE.addon-fit',
        'LICENSE.xterm',
        'addon-fit.js',
        'xterm.css',
        'xterm.js',
    ]);
    for (const [fileName, expectedDigest] of Object.entries(manifest.files)) {
        const digest = crypto.createHash('sha256')
            .update(fs.readFileSync(path.join(vendorDirectory, fileName)))
            .digest('hex');
        assert.equal(digest, expectedDigest, fileName);
    }
});
