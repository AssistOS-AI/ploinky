import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

test('WebChat has no legacy skills popup or controller and retains conversation settings', () => {
    const read = (name) => fs.readFileSync(new URL('../../cli/server/webchat/' + name, import.meta.url), 'utf8');
    const template = read('chat.html');
    const index = read('index.js');
    const dom = read('domSetup.js');
    const css = read('webchat.css');
    assert.doesNotMatch(template + index + dom, /skillsBtn|skillsDialog|skillsController|createSkillsController/);
    assert.doesNotMatch(index, /from ['"]\.\/skills\.js['"]/);
    assert.doesNotMatch(css, /wa-skills-dialog|wa-skill-tree/);
    assert.match(template, /id="sessionSettingsLink"/);
    assert.match(index, /createSessionSettingsController/);
});
