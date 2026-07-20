import {
    getSandboxStatus,
    setHostSandboxDisabled,
} from '../utils/runtime/sandboxRuntime.js';

function printSandboxStatus(status = getSandboxStatus()) {
    const state = status.disabled ? 'disabled' : 'enabled';
    console.log(`Host sandbox runtimes: ${state} (${status.source})`);
    if (status.forced) {
        console.log('Ploinky box policy is forced: every managed agent uses nested Podman.');
        return;
    }
    if (status.disabled) {
        console.log('Agents that request bwrap/seatbelt will use podman/docker instead.');
    } else {
        console.log('Agents may use bwrap/seatbelt when their manifest requests a lite sandbox.');
    }
}

function disableHostSandbox() {
    const status = setHostSandboxDisabled(true);
    console.log('✓ Host sandbox runtimes disabled for this workspace.');
    printSandboxStatus(status);
    console.log('Restart running agents to apply the change.');
}

function enableHostSandbox() {
    const status = setHostSandboxDisabled(false);
    console.log('✓ Host sandbox runtimes enabled for this workspace.');
    printSandboxStatus(status);
    console.log('Restart running agents to apply the change.');
}

function handleSandboxCommand(options = []) {
    const subcommand = String(options[0] || 'status').trim().toLowerCase();

    if (['status', 'show', ''].includes(subcommand)) {
        printSandboxStatus();
        return;
    }

    if (['disable', 'off', 'container', 'containers'].includes(subcommand)) {
        disableHostSandbox();
        return;
    }

    if (['enable', 'on', 'auto', 'manifest'].includes(subcommand)) {
        enableHostSandbox();
        return;
    }

    console.log('Usage: sandbox status | sandbox disable | sandbox enable');
}

export {
    disableHostSandbox,
    enableHostSandbox,
    handleSandboxCommand,
    printSandboxStatus,
};
