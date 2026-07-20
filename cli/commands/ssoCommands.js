import { showHelp } from './help.js';
import {
    bindSsoProvider,
    unbindSsoProvider,
    gatherSsoStatus,
    getSsoConfig,
    listAuthProviders
} from '../utils/security/sso.js';

function printProviderChoices(providers = []) {
    if (!providers.length) {
        console.log('No SSO provider agents are installed.');
        console.log('Install a provider agent, then run `ploinky sso enable <providerAgent>`.');
        return;
    }
    console.log('Installed SSO provider agents:');
    for (const provider of providers) {
        console.log(`  - ${provider.agentRef}`);
    }
}

function chooseProvider(explicitProvider) {
    if (explicitProvider) return explicitProvider;

    const config = getSsoConfig();
    if (config.providerAgent) return config.providerAgent;

    const providers = listAuthProviders();
    if (!providers.length) {
        throw new Error('No SSO provider agents are installed.');
    }

    if (providers.length === 1) return providers[0].agentRef;

    const names = providers.map((provider) => provider.agentRef).join(', ');
    throw new Error(`Multiple SSO provider agents are installed. Choose one explicitly: ${names}`);
}

function printSsoDetails(status) {
    const { config, routerPort, providerHostPort } = status;
    if (!config.enabled) {
        console.log('SSO is disabled. Run `ploinky sso enable <providerAgent>` to bind an auth provider.');
        printProviderChoices(listAuthProviders());
        return;
    }
    console.log('SSO is enabled:');
    console.log(`  Provider: ${config.providerAgent}`);
    console.log(`  Router port: ${routerPort}`);
    if (providerHostPort) {
        console.log(`  Provider port: ${providerHostPort}`);
    }
    const providerConfig = config.providerConfig || {};
    if (providerConfig.baseUrl) {
        console.log(`  Base URL: ${providerConfig.baseUrl}`);
    }
    if (providerConfig.redirectUri) {
        console.log(`  Redirect URI: ${providerConfig.redirectUri}`);
    }
}

async function enableSsoCommand(args = []) {
    const providerAgent = chooseProvider(args[0] || '');
    bindSsoProvider(providerAgent);
    console.log(`✓ SSO enabled via ${providerAgent}.`);
    printSsoDetails(gatherSsoStatus());
}

function disableSsoCommand() {
    unbindSsoProvider();
    console.log('✓ SSO disabled. Dev-only web-token auth remains available when configured.');
}

function showSsoStatusCommand() {
    printSsoDetails(gatherSsoStatus());
}

async function handleSsoCommand(options = []) {
    const subcommand = (options[0] || 'status').toLowerCase();
    const rest = options.slice(1);
    if (subcommand === 'enable') {
        if (rest.length > 1) {
            throw new Error('Usage: ploinky sso enable [providerAgent]');
        }
        await enableSsoCommand(rest);
        return;
    }
    if (subcommand === 'disable') {
        if (rest.length > 0) {
            throw new Error('Usage: ploinky sso disable');
        }
        disableSsoCommand();
        return;
    }
    if (subcommand === 'status') {
        if (rest.length > 0) {
            throw new Error('Usage: ploinky sso status');
        }
        showSsoStatusCommand();
        return;
    }
    showHelp(['sso']);
}

export { handleSsoCommand };
