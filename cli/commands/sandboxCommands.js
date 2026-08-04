import {
    getSandboxStatus,
    setHostSandboxDisabled,
} from '../utils/runtime/sandboxRuntime.js';

const SANDBOX_USAGE = 'Usage: sandbox status | sandbox disable | sandbox enable';

function sandboxCommandUsageError(input = '') {
    const error = new Error(`${input ? `Unsupported sandbox command '${input}'. ` : ''}${SANDBOX_USAGE}`);
    error.code = 'PLOINKY_SANDBOX_COMMAND_INVALID';
    return error;
}

function printSandboxStatus(status = getSandboxStatus()) {
    const state = status.disabled ? 'explicitly disabled' : 'available by strict manifest selection';
    console.log(`Host sandbox runtimes: ${state} (${status.source})`);
    if (status.hybrid) console.log('Ploinky Box runtime: hybrid (strict bwrap plus nested Podman).');
    console.log(`Bubblewrap: ${status.bwrap?.available ? status.bwrap.version || 'available' : 'unavailable'}`);
    if (status.helper?.required) {
        console.log(`Bwrap fd launcher: ${status.helper.available ? status.helper.version || 'capabilities verified' : 'unavailable or missing required capabilities'}`);
    } else {
        console.log('Bwrap fd launcher: not required outside Ploinky Box.');
    }
    console.log(`Podman: ${status.podman?.available ? status.podman.version || 'available' : 'unavailable'}`);
    if (status.disabled) {
        console.log('lite-sandbox: true manifests will fail with PLOINKY_SANDBOX_POLICY_CONFLICT.');
    } else {
        console.log('lite-sandbox: true selects bwrap on Linux/Box and seatbelt on macOS; missing/false selects a container runtime.');
    }
    if (!status.agents?.length) {
        console.log('Selected agent runtimes: no enabled agents.');
        return;
    }
    console.log('Selected agent runtimes:');
    for (const agent of status.agents) {
        const readiness = agent.available ? 'available' : `unavailable (${agent.errorCode})`;
        console.log(`  ${agent.runtimeKey} [${agent.agent}; instance=${agent.instance}]: ${agent.selectedRuntime} - ${readiness}`);
    }
}

function disableHostSandbox() {
    const status = setHostSandboxDisabled(true);
    console.log('✓ Host sandbox runtimes disabled for this workspace.');
    printSandboxStatus(status);
    console.log('Strict lite-sandbox manifests now fail until this policy is cleared.');
}

function enableHostSandbox() {
    const status = setHostSandboxDisabled(false);
    console.log('✓ Host sandbox runtimes enabled for this workspace.');
    printSandboxStatus(status);
    console.log('Runtime selection remains manifest-driven.');
}

function handleSandboxCommand(options = []) {
    const subcommand = String(options[0] || '').trim().toLowerCase();

    if (options.length !== 1 || !['status', 'disable', 'enable'].includes(subcommand)) {
        throw sandboxCommandUsageError(options.join(' ').trim());
    }

    if (subcommand === 'status') {
        printSandboxStatus();
        return;
    }

    if (subcommand === 'disable') {
        disableHostSandbox();
        return;
    }

    if (subcommand === 'enable') {
        enableHostSandbox();
    }
}

export {
    disableHostSandbox,
    enableHostSandbox,
    handleSandboxCommand,
    printSandboxStatus,
    sandboxCommandUsageError,
};
