import assert from 'node:assert/strict';
import test from 'node:test';
import { skillsetMDParser } from '../../cli/utils/skillsetMDParser.mjs';

const definition = '# Review reports\n\n## Description\nInspect a report.\nCheck its claims.\n\n## Skills\n- read-pdf\n- write-doc\n- read-pdf\n';
const skills = ['read-pdf', 'write-doc'];

test('parses named Markdown sets, multiline descriptions, CRLF and overlapping members', () => {
    const source = definition + '\n# PDF only\n## description\nRead a PDF.\n## skills\n- read-pdf\n';
    const sets = skillsetMDParser(source.replaceAll('\n', '\r\n'), skills);
    assert.deepEqual(sets, [
        { name: 'Review reports', description: 'Inspect a report.\nCheck its claims.', skills },
        { name: 'PDF only', description: 'Read a PDF.', skills: ['read-pdf'] },
    ]);
    assert.deepEqual(skillsetMDParser('', skills), []);
});

test('rejects duplicate names, sections, unknown members and malformed lists', () => {
    for (const source of [definition + definition,
        definition + '## Skills\n- read-pdf',
        definition.replace('- write-doc', '- unknown'),
        definition.replace('- write-doc', 'write-doc'),
        definition.replace('## Description', '## Notes'),
        definition.replace('Inspect a report.\nCheck its claims.', ''),
    ]) assert.throws(() => skillsetMDParser(source, skills), /Invalid skillsets.md/);
});
