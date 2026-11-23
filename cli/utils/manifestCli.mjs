export function getCliCmd(manifest) {
    const explicitCli = (manifest.cli && String(manifest.cli)) || manifest.commands?.cli;
    return explicitCli || '/Agent/default_cli.sh';
}
