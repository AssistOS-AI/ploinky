const invalid = message => Object.assign(new Error(`Invalid skillsets.md: ${message}`), { statusCode: 400 });

/** Each H1 names a set; H2 Description and Skills contain prose and a bullet list. */
export function skillsetMDParser(source, knownSkills) {
    const known = new Set(knownSkills.map(skill => typeof skill === 'string' ? skill : skill.name));
    const definitions = [];
    let current = null;
    let section = null;
    const finish = () => {
        if (!current) return;
        const description = current.description.join('\n').trim();
        if (!description || description.length > 4000 || !current.skills.length) {
            throw invalid('each skillset needs Description text and a non-empty Skills list');
        }
        if (definitions.some(entry => entry.name === current.name)) throw invalid(`duplicate skillset: ${current.name}`);
        definitions.push({ name: current.name, description, skills: [...new Set(current.skills)] });
        if (definitions.length > 100) throw invalid('at most 100 skillsets are allowed');
    };
    for (const line of source.replace(/^\uFEFF/u, '').split(/\r?\n/u)) {
        const title = line.match(/^# (.+?)\s*$/u);
        if (title) {
            finish();
            if (!title[1].trim() || title[1].length > 100) throw invalid('skillset names require 1 to 100 characters');
            current = { name: title[1], description: [], skills: [], sections: new Set() };
            section = null;
            continue;
        }
        const heading = line.match(/^## (Description|Skills)\s*$/iu);
        if (heading && current) {
            section = heading[1].toLowerCase();
            if (current.sections.has(section)) throw invalid(`duplicate ${heading[1]} section`);
            current.sections.add(section);
            continue;
        }
        if (!line.trim()) {
            if (section === 'description') current.description.push('');
            continue;
        }
        if (!current || !section || /^#/u.test(line)) throw invalid('use # name, ## Description and ## Skills');
        if (section === 'description') current.description.push(line);
        else {
            const member = line.match(/^\s*-\s+([a-z0-9]+(?:-[a-z0-9]+)*)\s*$/u)?.[1];
            if (!member || !known.has(member)) throw invalid(`unknown or invalid skill: ${line.trim()}`);
            current.skills.push(member);
            if (current.skills.length > 100) throw invalid('at most 100 skills per skillset are allowed');
        }
    }
    finish();
    return definitions;
}
