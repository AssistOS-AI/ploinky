import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

test('WebChat has no legacy skills popup or controller or conversation settings link', () => {
    const read = (name) => fs.readFileSync(new URL('../../cli/server/webchat/' + name, import.meta.url), 'utf8');
    const template = read('chat.html');
    const index = read('index.js');
    const dom = read('domSetup.js');
    const css = read('webchat.css');
    assert.doesNotMatch(template + index + dom, /skillsBtn|skillsDialog|skillsController|createSkillsController/);
    assert.doesNotMatch(index, /from ['"]\.\/skills\.js['"]/);
    assert.doesNotMatch(css, /wa-skills-dialog|wa-skill-tree/);
    assert.doesNotMatch(template, /id="sessionSettingsLink"/);
    assert.doesNotMatch(index, /createSessionSettingsController/);
});

test('WebChat has no line-limit preference and keeps the default message expansion limit', () => {
    const read = (name) => fs.readFileSync(new URL('../../cli/server/webchat/' + name, import.meta.url), 'utf8');
    assert.doesNotMatch(read('chat.html') + read('domSetup.js'), /viewMoreLines|wa_view_more|View more.*line limit/);
    assert.match(read('index.js'), /initialViewMoreLineLimit: 1000/);
});
