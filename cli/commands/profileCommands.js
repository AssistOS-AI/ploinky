import {
    getActiveProfile,
    setActiveProfile,
    validateProfile,
    listProfiles,
    getValidProfiles,
    getDefaultMountModes,
    getProfileConfig
} from '../services/profileService.js';
import { loadAgents } from '../services/workspace.js';
import { colorize } from '../services/utils.js';

/**
 * Handle the profile command.
 * @param {string[]} args - Command arguments
 */
export async function handleProfileCommand(args) {
    const subCommand = args[0]?.toLowerCase();

    switch (subCommand) {
        case 'list':
            return handleListProfiles(args.slice(1));
        case 'validate':
            return handleValidateProfile(args.slice(1));
        case 'show':
        case 'current':
            return showCurrentProfile();
        case undefined:
        case '':
            return showCurrentProfile();
        default:
            // If it's a valid profile name, set it
            if (getValidProfiles().includes(subCommand)) {
                return handleSetProfile(subCommand);
            }
            // Otherwise, show usage
            console.log('Usage: ploinky profile [<profileName>|list|validate|show]');
            console.log('');
            console.log('Commands:');
            console.log('  ploinky profile <name>        Set active profile');
            console.log('  ploinky profile show          Show current profile');
            console.log('  ploinky profile list [agent]  List available profiles');
            console.log('  ploinky profile validate <profile> [agent]  Validate profile config');
            return;
    }
}

/**
 * Set the active profile.
 * @param {string} profileName - The profile name to set
 */
function handleSetProfile(profileName) {
    const result = setActiveProfile(profileName);

    if (result.success) {
        console.log(colorize(`✓ ${result.message}`, 'green'));

        // Show profile details
        const profile = profileName.toLowerCase();
        const mountModes = getDefaultMountModes(profile);

        console.log('');
        console.log('Profile settings:');
        console.log(`  Environment: ${getProfileEnvironmentLabel(profile)}`);
        console.log(`  Code mount:  ${mountModes.code === 'rw' ? colorize('read-write', 'yellow') : colorize('read-only', 'cyan')}`);
        console.log(`  Skills mount: ${mountModes.skills === 'rw' ? colorize('read-write', 'yellow') : colorize('read-only', 'cyan')}`);

        if (mountModes.code === 'ro') {
            console.log('');
            console.log(colorize('Note:', 'yellow'), 'Code and skills are read-only in this profile.');
            console.log('       Restart running agents to apply the new profile.');
        }
    } else {
        console.error(colorize(`✗ ${result.message}`, 'red'));
    }
}

/**
 * Show the current profile.
 */
function showCurrentProfile() {
    const profile = getActiveProfile();
    const mountModes = getDefaultMountModes(profile);

    console.log(`Current profile: ${colorize(profile, 'cyan')}`);
    console.log('');
    console.log('Settings:');
    console.log(`  Environment: ${getProfileEnvironmentLabel(profile)}`);
    console.log(`  Code mount:  ${mountModes.code === 'rw' ? 'read-write' : 'read-only'}`);
    console.log(`  Skills mount: ${mountModes.skills === 'rw' ? 'read-write' : 'read-only'}`);
    console.log('');
    console.log('Valid profiles:', getValidProfiles().join(', '));
    console.log('');
    console.log('To change profile: ploinky profile <name>');
}

/**
 * List available profiles.
 * @param {string[]} args - Additional arguments
 */
function handleListProfiles(args) {
    const agentName = args[0];

    if (agentName) {
        // List profiles for a specific agent
        const { profiles, defaultProfile } = listProfiles(agentName);

        if (profiles.length === 0) {
            console.log(`Agent '${agentName}' has no defined profiles.`);
            return;
        }

        console.log(`Profiles for ${colorize(agentName, 'cyan')}:`);
        console.log('');
        for (const profile of profiles) {
            const isDefault = profile === defaultProfile;
            const prefix = isDefault ? colorize('*', 'green') : ' ';
            console.log(`  ${prefix} ${profile}${isDefault ? ' (default)' : ''}`);
        }
    } else {
        // List all agents with their profiles
        const currentProfile = getActiveProfile();
        console.log(`Global profile: ${colorize(currentProfile, 'cyan')}`);
        console.log('');
        console.log('Valid profiles:');
        for (const profile of getValidProfiles()) {
            const isCurrent = profile === currentProfile;
            const prefix = isCurrent ? colorize('*', 'green') : ' ';
            console.log(`  ${prefix} ${profile}${isCurrent ? ' (active)' : ''}`);
        }

        // Show agents and their profile support
        const agents = loadAgents();
        const agentEntries = Object.entries(agents || {})
            .filter(([key, value]) => key !== '_config' && value && value.type === 'agent');

        if (agentEntries.length > 0) {
            console.log('');
            console.log('Enabled agents:');
            for (const [containerName, record] of agentEntries) {
                const agentName = record.agentName;
                const agentProfile = record.profile || 'default';
                const { profiles } = listProfiles(`${record.repoName}/${agentName}`);
                const profileInfo = profiles.length > 0
                    ? `profiles: ${profiles.join(', ')}`
                    : 'uses global profiles';
                console.log(`  ${colorize(agentName, 'cyan')} (${agentProfile}) - ${profileInfo}`);
            }
        }
    }
}

/**
 * Validate a profile configuration.
 * @param {string[]} args - Additional arguments
 */
function handleValidateProfile(args) {
    const profileName = args[0];
    const agentName = args[1];

    if (!profileName) {
        console.error('Usage: ploinky profile validate <profileName> [agentName]');
        return;
    }

    if (agentName) {
        // Validate profile for a specific agent
        const result = validateProfile(agentName, profileName);

        console.log(`Validating profile '${profileName}' for agent '${agentName}':`);
        console.log('');

        if (result.valid) {
            console.log(colorize('✓ Profile is valid', 'green'));
            if (result.config) {
                showProfileConfigSummary(result.config);
            }
        } else {
            console.log(colorize('✗ Profile has issues:', 'red'));
            for (const issue of result.issues) {
                console.log(`  - ${issue}`);
            }
        }
    } else {
        // Validate the profile name itself
        if (!getValidProfiles().includes(profileName.toLowerCase())) {
            console.log(colorize(`✗ Invalid profile name: ${profileName}`, 'red'));
            console.log(`Valid profiles are: ${getValidProfiles().join(', ')}`);
            return;
        }

        console.log(colorize(`✓ '${profileName}' is a valid profile name`, 'green'));

        // Validate all enabled agents
        const agents = loadAgents();
        const agentEntries = Object.entries(agents || {})
            .filter(([key, value]) => key !== '_config' && value && value.type === 'agent');

        if (agentEntries.length > 0) {
            console.log('');
            console.log('Validating against enabled agents:');
            for (const [containerName, record] of agentEntries) {
                const agentRef = `${record.repoName}/${record.agentName}`;
                const result = validateProfile(agentRef, profileName);
                const status = result.valid
                    ? colorize('✓', 'green')
                    : colorize('✗', 'red');
                console.log(`  ${status} ${record.agentName}`);
                if (!result.valid && result.issues.length > 0) {
                    for (const issue of result.issues) {
                        console.log(`      ${issue}`);
                    }
                }
            }
        }
    }
}

/**
 * Show a summary of profile configuration.
 * @param {object} config - The profile configuration
 */
function showProfileConfigSummary(config) {
    console.log('');
    console.log('Configuration:');

    if (config.env) {
        console.log(`  Environment variables: ${Object.keys(config.env).length}`);
    }

    if (config.secrets && config.secrets.length > 0) {
        console.log(`  Required secrets: ${config.secrets.join(', ')}`);
    }

    if (config.mounts) {
        console.log(`  Mount modes: code=${config.mounts.code || 'default'}, skills=${config.mounts.skills || 'default'}`);
    }

    // Hook execution order: preinstall [HOST], hosthook_aftercreation [HOST], install [CONTAINER], postinstall [CONTAINER], hosthook_postinstall [HOST]
    const hooks = ['preinstall', 'hosthook_aftercreation', 'install', 'postinstall', 'hosthook_postinstall']
        .filter(h => config[h]);
    if (hooks.length > 0) {
        console.log(`  Hooks: ${hooks.join(', ')}`);
    }
}

/**
 * Get a human-readable environment label.
 * @param {string} profile - The profile name
 * @returns {string}
 */
function getProfileEnvironmentLabel(profile) {
    if (profile === 'default') return colorize('Development', 'green');
    return profile;
}

export { handleSetProfile, showCurrentProfile, handleListProfiles, handleValidateProfile };
