export function showHelp(args = [], { surface = 'core' } = {}) {
    // Parse help arguments
    const topic = args[0];
    const subtopic = args[1];
    const subsubtopic = args[2];
    
    // Detailed help for specific commands
    if (topic) {
        if (topic === 'cloud') { console.log('Cloud commands are not available in this build.'); return; }
        return showDetailedHelp(topic, subtopic, subsubtopic, { surface });
    }

    console.log(mainHelpText(surface));
}

function lifecycleHelpLines(surface) {
    if (surface === 'host') {
        return [
            '  status                         Show combined, read-only outer runtime and workspace status',
            '  stop                           Stop core services, then stop the outer runtime',
            '  destroy [--delete-cache]       Remove the outer runtime without prompting; optionally delete .ploinky/box cache data',
        ];
    }
    return [
        '  status                         Show workspace/router/agent state',
        '  stop | shutdown | clean         Stop workspace services and leave the outer runtime running',
        '  destroy                        Remove workspace containers and leave the outer runtime running',
        '  Exit the REPL before running host ploinky stop or ploinky destroy.',
    ];
}

function mainHelpText(surface) {
    return `
╔═══ PLOINKY ═══╗ Container Development & Cloud Platform

▶ LOCAL DEVELOPMENT
  install <url|repoName> [name] [branch] Install repository
  add <url|repoName> [name] [branch]     Alias for install
  uninstall <name|url>           Uninstall repository and its enabled agents
  remove <name|url>              Alias for uninstall
  update [folderPath]            Update Ploinky, .ploinky/repos, Achilles deps, projects, and default skills
  start <agent> [port] [--profile <name>]
                                 Start agents from .ploinky/agents.json and launch Router
  shell <agentName>              Open interactive shell in container (attached TTY)
  cli                            Open /bin/bash in the managed outer runtime; exit returns to the previous prompt.
  cli <agentName> [args...]      Run manifest "cli" command (attached TTY)
  sso enable|disable|status  Bind or inspect SSO provider agents
  sandbox status|disable|enable  Force lite-sandbox agents to use containers, or restore bwrap/seatbelt
  network status [--json]        Show managed network topology (status schema 3)
  network prune                  Remove unused workspace-owned managed networks
  vars                           List all variable names (no values)
  var <VAR> <value>              Set a variable value
  echo <VAR|$VAR>                Print the resolved value of a variable
  expose <ENV_NAME> [<$VAR|value>] [agent]  Expose to agent environment
  default-skills <repoName>      Refresh repo skills into .agents/skills while preserving other skills
  list agents | repos | routes   List agents, predefined repos, or router routes
  /settings | settings           Open the interactive model/settings menu
  profile [name|list|show]       Inspect or change the active profile


▶ CLIENT OPERATIONS
  client tool <name>             Invoke any MCP tool exposed by agents via RoutingServer
  client list tools              Aggregate tools exposed by all agents
  client list resources          Aggregate resources exposed by all agents
  client status <agent>          One-line status (HTTP code, parsed)

${lifecycleHelpLines(surface).join('\n')}
  restart                        Restart enabled agents + Router
  reinstall <agentName>          Re-create a running agent container (destructive)
  logs tail [router|agent] [--startup]
                                 Follow Router or one agent's logs
  logs last [<N>] [router|agent] [--startup]
                                 Show the last N lines for Router or one agent

▶ FOR DETAILED HELP
  help <command>                 Show detailed help for a command
  Examples: help add | help cli

Config stored in .ploinky/ • Type 'help' for commands
╚═══════════════════════════════════════════════════════╝
`;
}

function showDetailedHelp(topic, subtopic, subsubtopic, { surface = 'core' } = {}) {
    const helpContent = {
        // Local development commands
        'add': {
            description: 'Add repositories or environment variables',
            syntax: 'add <url|repoName> [name] [branch] | add <url|repoName> [name] --branch <branch>',
            params: {
                '<url|repoName>': 'Git URL to clone, or a repository name already present in repo_sources.json or the predefined catalog.',
                '[name]': 'Optional local repository name. Defaults to the repo name derived from the URL.',
                '[branch]': 'Git branch to clone (optional, defaults to repository default branch)'
            },
            examples: [
                'add copilot-agents',
                'add https://github.com/user/repo.git',
                'add https://github.com/user/repo.git myrepo',
                'add repo https://github.com/user/repo.git myrepo --branch feature'
            ],
            notes: '`add` is an alias for `install`. The optional `repo` token is still accepted. Branch can be specified as a positional argument or with --branch.'
        },
        'install': {
            syntax: 'install <url|repoName> [name] [branch] | install <url|repoName> [name] --branch <branch>',
            description: 'Clone and register a repository. Agent repos are made discoverable for agent listings.',
            examples: [
                'install copilot-agents',
                'install https://github.com/user/repo.git',
                'install https://github.com/user/repo.git myrepo --branch feature',
                'install repo https://github.com/user/repo.git myrepo'
            ],
            notes: 'Repository-name install works only for repo_sources.json entries and predefined repositories. The optional `repo` token is accepted but not required.'
        },
        'uninstall': {
            syntax: 'uninstall <name|url>',
            description: 'Remove an installed repository after disabling agents from that repository.',
            examples: [
                'uninstall myrepo',
                'uninstall https://github.com/user/repo.git',
                'uninstall repo myrepo'
            ],
            notes: 'The optional `repo` token is accepted but not required.'
        },
        'remove': {
            syntax: 'remove <name|url>',
            description: 'Alias for uninstall.',
            examples: [ 'remove myrepo', 'remove repo myrepo' ],
            notes: 'The optional `repo` token is accepted but not required.'
        },
        'var': {
            description: 'Set a workspace variable (stored encrypted in .ploinky/.secrets)',
            syntax: 'var <VAR> <value>',
            examples: [
                'var API_KEY sk-123456'
            ],
            notes: "Use 'vars' to list variables. Router control surfaces use authenticated workspace sessions."
        },
        'vars': {
            description: 'List workspace variables (from encrypted .ploinky/.secrets)',
            syntax: 'vars',
            examples: [ 'vars' ]
        },
        
        'update': {
            description: 'Update Ploinky itself, its Achilles runtime checkout, workspace repositories, Achilles dependencies, and project repositories',
            syntax: 'update [folderPath] | update all [folderPath] | update repos | update repo <name>',
            examples: [ 'update', 'update /work/projects', 'update all /work/projects', 'update repos', 'update repo basic' ],
            notes: '`update` is the same full workflow as `update all`: it runs git pull --rebase --autostash for the Ploinky checkout, refreshes ploinky/node_modules/achillesAgentLib, updates .ploinky/repos, and updates git repositories discovered recursively from folderPath. Inside a Ploinky box, the read-only source self-pull is skipped while writable runtime dependencies, managed repos, projects, and skills continue updating. Without folderPath, discovery starts at the current working directory. Missing or unreachable remotes in discovered project repositories are logged and skipped instead of failing the full update; managed .ploinky/repos updates remain strict. `update`, `update all`, `update repos`, and `update repo <name>` refresh `AchillesCopilotBasicSkills`, `DocumentationSkills`, and `PloinkySkills` into eligible installed .ploinky/repos entries, maintaining `.claude` compatibility and the managed `.gitignore` block; each source repo and all skills-only repos are skipped. `update repos` also updates the Ploinky runtime achillesAgentLib checkout and managed-repo achillesAgentLib packages. Discovered workspace folders can define `ploinky-skills-manifest.json`; when present, that file must be an array of objects with url/name/branch/skills and selects the exact skills to install into `.agents/skills` for that workspace folder. In an interactive Ploinky session, a detected Ploinky self-update is deferred: close the session, run `ploinky update`, then restart Ploinky so the new code is loaded.'
        },
        
        
        'shell': {
            description: 'Interactive shell session',
            subcommands: {
                'default': {
                    syntax: 'shell <agentName>',
                    description: 'Open an interactive shell (attached TTY) in the agent container',
                    params: { '<agentName>': 'Agent name' },
                    examples: [ 'shell MyAPI' ],
                    notes: 'Attaches to a persistent container; exit shell to return.'
                }
            }
        },
        'cli': {
            description: 'Run the agent CLI command interactively',
            subcommands: {
                'default': {
                    syntax: 'cli <agentName> [args...]',
                    description: 'Run manifest "cli" command interactively (attached TTY).',
                    params: { '<agentName>': 'Agent name', '[args...]': 'Arguments appended to the cli command' },
                    examples: [ 'cli MyAPI --help' ],
                    notes: 'Attaches to a persistent container. REPLs stay attached until exit. Requires the agent manifest to define a "cli" entry. WebChat uses the same launch path and appends forwarded URL parameters as long-form CLI flags.'
                }
            }
        },
        'sso': {
            description: 'Manage the workspace SSO provider.',
            subcommands: {
                'enable': {
                    syntax: 'sso enable [providerAgent]',
                    description: 'Enable workspace SSO with an installed ssoProvider agent.',
                    examples: [
                        'sso enable',
                        'sso enable <providerAgent>'
                    ],
                    notes: 'If no provider is passed, Ploinky reuses the existing provider, selects the sole installed provider, or requires an explicit choice when multiple providers are installed.'
                },
                'disable': {
                    syntax: 'sso disable',
                    description: 'Disable workspace SSO. Dev-only web-token auth remains unchanged.',
                    examples: [ 'sso disable' ]
                },
                'status': {
                    syntax: 'sso status',
                    description: 'Show the current SSO provider and detected ports.',
                    examples: [ 'sso status' ]
                }
            }
        },
        'sandbox': {
            description: 'Control host sandbox runtime selection for this workspace.',
            syntax: 'sandbox status | sandbox disable | sandbox enable',
            examples: [
                'sandbox status',
                'sandbox disable',
                'disable sandbox',
                'sandbox enable',
                'enable sandbox'
            ],
            notes: 'Host sandbox is disabled by default; agents whose manifests request `lite-sandbox: true` use podman/docker. Run `sandbox enable` to opt into bwrap (Linux) / seatbelt (macOS). Restart running agents to apply the change. Environment override: PLOINKY_DISABLE_HOST_SANDBOX=1 forces disabled regardless of workspace setting.'
        },
        'network': {
            description: 'Inspect and prune workspace-owned rootless Podman networks.',
            syntax: 'network status [--json] | network prune',
            examples: [
                'network status',
                'network status --json',
                'network prune'
            ],
            notes: 'Prune removes only unused networks bearing this workspace\'s exact Ploinky ownership labels. Foreign or attached networks are never removed.'
        },
        'shutdown': {
            description: 'Stop and remove containers recorded in .ploinky/agents.json',
            syntax: 'shutdown',
            examples: ['shutdown'],
            notes: 'Removes containers for all enabled agents in this workspace.'
        },
        'stop': {
            description: 'Stop the router and all configured agent runtimes.',
            syntax: 'stop',
            examples: ['stop'],
            notes: 'Stops the watchdog/router first, then stops configured agent runtimes without removing enabled-agent records.'
        },
        'destroy': {
            description: 'Stop and remove all Ploinky containers created in this workspace',
            syntax: 'destroy',
            examples: ['destroy'],
            notes: 'Irreversible for running containers; also clears .ploinky/deps so dependencies are rebuilt on next start. Persistent agent data in .data is preserved.'
        },
        'clean': {
            description: 'Remove all workspace containers created by Ploinky.',
            syntax: 'clean',
            examples: ['clean'],
            notes: 'Runs the workspace container removal workflow. Unlike destroy, it does not explicitly stop the router first.'
        },
        
        'enable': {
            description: 'Enable features for agents',
            subcommands: {
                'sandbox': {
                    syntax: 'enable sandbox',
                    description: 'Restore manifest-driven bwrap/seatbelt selection for this workspace.',
                    examples: [ 'enable sandbox' ],
                    notes: 'Equivalent to `sandbox enable`. Restart running agents to apply the change.'
                },
                'agent': {
                    syntax: 'enable [agent] <name|repo/name> [isolated|global|devel [repoName]] [--auth none|pwd|sso] [--user <name> --password <value>] [as <alias>]',
                    description: 'Register and start an agent without changing the configured primary/static agent. Modes: isolated (omitted) creates a subfolder <agentName>; global uses current project; devel uses a repo under .ploinky/repos. Use "as <alias>" to create an additional instance with its own container name.',
                    examples: [
                        'enable demo',
                        'enable agent repoName/demo global',
                        'enable agent demo',
                        'enable agent demo --auth pwd',
                        'enable agent demo --auth pwd --user admin --password admin',
                        'enable agent demo --auth sso',
                        'enable agent demo global',
                        'enable agent demo devel simulator',
                        'enable agent demo as demo2'
                    ],
                    notes: 'If --auth is omitted, no auth is applied unless the agent manifest declares a default auth mode. Pwd auth stores policy in .ploinky/agents.json and can also seed credentials via --user/--password or manifest defaults under `pwd.user` and `pwd.password`. Enable starts the agent and updates its route, but does not replace the primary/static agent configured by start. Aliases must be unique; commands like reinstall/disable should target the alias when multiple containers exist.'
                }
            }
        },
        'expose': {
            description: 'Expose variables to an agent as environment variables',
            syntax: 'expose <ENV_NAME> [<$VAR|value>] [agentName] ',
            examples: [
                'expose API_KEY $MY_API_KEY MyAPI',
                'expose MODE prod MyAPI',
                'expose API_KEY $MY_API_KEY',
                'expose TEST_TOKEN demo'
            ],
            notes: 'If the value argument is omitted, the command defaults to using $<ENV_NAME>. When agentName is omitted, the static agent configured via start is used.'
        },
        'echo': {
            description: 'Print the resolved value of a variable',
            syntax: 'echo <VAR|$VAR> ',
            examples: [ 'echo API_KEY', 'echo $PROD_KEY' ],
            notes: 'Resolves chained aliases like VAR=$OTHER.'
        },
        'default-skills': {
            description: 'Copy each subdirectory of <repoName>/skills/ into .agents/skills/. Existing skill directories with the same names are replaced from the repo, while other skill directories already under .agents/skills/ are preserved. Legacy .claude/skills/ entries for other skills are migrated into .agents/skills/ before .claude compatibility symlinks are created.',
            syntax: 'default-skills <repoName>',
            params: {
                '<repoName>': 'Predefined repo name (e.g. AchillesCopilotBasicSkills) or a repo already cloned under .ploinky/repos/'
            },
            examples: [
                'default-skills AchillesCopilotBasicSkills'
            ],
            notes: 'New workspaces get .claude as a symlink to .agents. If an existing non-empty .claude directory must be preserved, .claude/skills is symlinked to ../.agents/skills instead. The managed .gitignore block lists .claude and only the refreshed repo skill directories under .agents/skills/.'
        },
        'start': {
            description: 'Start enabled agents and the local Router',
            syntax: 'start <agent> [port] [--profile <name>] [--branch <branch>] [--repo-branch <repo>=<branch>] [--branch-fallback default|fail] [--reset-repos]',
            examples: [ 'start MyStaticAgent 8080 --profile dev', 'start explorer 8080 --profile prod --branch my-feature' ],
            notes: 'Reads manifest of static agent: applies repos{} (clone+enable) and enable[] (enable agents). First run needs agent and port. An explicit --profile selects and persists the workspace profile before startup; direct in-box starts that omit it retain the active workspace profile. --branch <branch> applies to the static agent\'s repo and every manifest dependency repo. In host local-development mode, the selected local AchillesAgentLib archive always wins, so --branch cannot replace it. Outside that mode, --branch also selects the achillesAgentLib used by agent containers. When a candidate branch is absent, --branch-fallback default keeps repositories on their configured ref; --branch-fallback fail aborts. --repo-branch <repo>=<branch> (repeatable) reconciles an existing named repo before manifest traversal and overrides that repo when traversal installs it; --reset-repos hard-resets targeted managed repos to the refreshed remote branch. (Advanced host production escape hatch: set PLOINKY_PROD=true with PLOINKY_AGENTLIB_REF=<branch|git+/file: spec> to override just the achillesAgentLib source.)'
        },
        'status': {
            description: 'Show enabled agents and router configuration',
            syntax: 'status',
            examples: [ 'status' ],
            notes: 'Reads .ploinky/agents.json and prints each runtime backend, live or stopped state, binds, ports, and static config. Bubblewrap and Seatbelt use tracked process PIDs; Docker and Podman use OCI state.'
        },
        'reinstall': {
            description: 'Reinstall an agent by re-creating its container.',
            subcommands: {
                'agent': {
                    syntax: 'reinstall <name> | reinstall agent <name>',
                    description: 'Stops, removes, and re-creates the agent\'s container. This is a destructive operation that ensures the agent starts from a clean state. This command only has an effect if the agent\'s container is currently running.',
                    examples: [ 'reinstall MyAPI', 'reinstall agent MyAPI' ],
                    notes: 'This is useful for applying configuration changes that require a new container.'
                }
            }
        },
        'restart': {
            description: 'Restarts services. A named agent is reconciled through the managed ownership, network, and endpoint transaction. With no name, all agents and the router restart.',
            syntax: 'restart [agentName]',
            examples: [ 'restart', 'restart MyAPI' ],
            notes: 'A named restart requires the persisted RoutingServer port and refuses foreign or old-contract containers. The general restart fails if start was not configured yet.'
        },
        'logs': {
            description: 'Inspect Router or agent runtime logs without changing lifecycle state',
            subcommands: {
                'tail': {
                    syntax: 'logs tail [router|agent] [--startup]',
                    description: 'Follow the Ploinky Router file or one agent runtime',
                    examples: [
                        'logs tail',
                        'logs tail router',
                        'logs tail myAgent',
                        'logs tail myRepo/myAgent',
                        'logs tail myAgent --startup'
                    ],
                    notes: 'Completion offers one round-trip-proved reference per enabled record. Linux `/proc` argv or macOS `KERN_PROCARGS2` must prove the exact no-wait worker invocation. Tail follows that exact run\'s startup log, opens/proves its runtime source, and rechecks marker, registry generation, and source identity before switching. A failed start returns 1 and never falls back. `--startup` never opens runtime output.'
                },
                'last': {
                    syntax: 'logs last [<N>] [router|agent] [--startup]',
                    description: 'Show the last N lines for Router or one agent; N defaults to 200',
                    examples: [
                        'logs last',
                        'logs last 50',
                        'logs last 50 router',
                        'logs last myAgent',
                        'logs last 200 myRepo/myAgent',
                        'logs last 40 myAgent --startup'
                    ],
                    notes: 'N must be one exact whole number between 1 and 10000; fractions, signs, partial integers, and padded values are rejected. An ownership-proved runtime is selected before no-wait state is consulted; without one, the current run\'s startup log is used. Output is capped at 16 MiB and reports a limit failure instead of truncating silently.'
                }
            },
            notes: 'Logs never create, start, repair, or remove a workspace, a Box, or an agent runtime. Docker/Podman uses immutable container IDs; Bubblewrap/Seatbelt uses immutable process-specific files, and pre-cut sandbox processes require one restart without legacy fallback. Application bytes pass through intentionally unredacted; bounded control diagnostics redact credentials. Only selected log bytes go to stdout; source and handoff messages go to stderr. Cancellation waits for bounded TERM/KILL cleanup.'
        },
        '/settings': {
            description: 'Open the interactive model/settings menu.',
            syntax: '/settings',
            examples: [ '/settings', 'settings' ],
            notes: 'Requires an interactive TTY. The `settings` command is accepted as an alias.'
        },
        'settings': {
            description: 'Alias for /settings.',
            syntax: 'settings',
            examples: [ 'settings' ],
            notes: 'Requires an interactive TTY.'
        },
        'profile': {
            description: 'Inspect or change the active runtime profile.',
            syntax: 'profile [<profileName>|list|validate|show]',
            examples: [
                'profile',
                'profile show',
                'profile list',
                'profile validate default',
                'profile default'
            ],
            notes: 'Valid profile names are accepted directly and become the active profile.'
        },
        'disable': {
            description: 'Disable features',
            subcommands: {
                'sandbox': {
                    syntax: 'disable sandbox',
                    description: 'Disable bwrap/seatbelt selection for all agents in this workspace; lite-sandbox agents will use podman/docker.',
                    examples: [ 'disable sandbox' ],
                    notes: 'Equivalent to `sandbox disable`. Restart running agents to apply the change.'
                },
                'agent': {
                    syntax: 'disable [agent] <agentName>',
                    description: 'Remove an enabled agent from .ploinky/agents.json, then stop and remove its runtime instance',
                    examples: [ 'disable demo', 'disable agent repoName/demo' ]
                },
                'agents-all': {
                    syntax: 'disable agents-all',
                    description: 'Disable all enabled agents from .ploinky/agents.json and remove their runtime instances',
                    examples: [ 'disable agents-all' ],
                    notes: 'Registry entries are removed before runtime instances are stopped so the watchdog does not restart them.'
                }
            }
        },
        
        'list': {
            description: 'List resources (agents, repos, current workspace containers, routes)',
            subcommands: {
                'agents': {
                    syntax: 'list agents',
                    description: 'List all available agents across all repositories',
                    examples: ['list agents']
                },
                'repos': {
                    syntax: 'list repos',
                    description: 'List available repositories with URLs and installed status.',
                    examples: ['list repos']
                },
                'routes': {
                    syntax: 'list routes',
                    description: 'List configured routes from .ploinky/routing.json',
                    examples: ['list routes']
                }
            }
        },
        
        // Cloud commands
        'cloud': {
            description: 'Cloud platform operations',
            subcommands: {
                'connect': {
                    syntax: 'cloud connect [url]',
                    description: 'Connect to a Ploinky Cloud server',
                    params: {
                        '[url]': 'Server URL (default: localhost:8000)'
                    },
                    examples: [
                        'cloud connect                    # Connect to localhost:8000',
                        'cloud connect api.example.com    # Connect to remote server',
                        'cloud connect 192.168.1.100:8080 # Connect with custom port'
                    ],
                    notes: 'Connection info saved in .ploinky/cloud.json'
                },
                
                'login': {
                    syntax: 'cloud login <API_KEY>',
                    description: 'Login to connected cloud server using API Key',
                    params: {
                        '<API_KEY>': 'Admin API Key (generated with cloud init)'
                    },
                    examples: [
                        'cloud login ABCDEF123456',
                        'cloud login 7b9d... (hex key)'
                    ],
                    notes: 'Use cloud init first to generate an API Key'
                },
                'init': {
                    syntax: 'cloud init',
                    description: 'Initialize server and generate Admin API Key',
                    examples: ['cloud init'],
                    notes: 'Stores URL and API Key in ~/.plionky/remotes.json'
                },
                'show': {
                    syntax: 'cloud show',
                    description: 'Show current cloud URL and API Key',
                    examples: ['cloud show']
                },
                
                'logout': {
                    syntax: 'cloud logout',
                    description: 'Logout from cloud server',
                    examples: ['cloud logout']
                },
                
                'status': {
                    syntax: 'cloud status',
                    description: 'Show connection and authentication status',
                    examples: ['cloud status'],
                    notes: 'Shows server URL, login status, and deployment info'
                },
                
                'host': {
                    syntax: 'cloud host <action>',
                    description: 'Manage hosts and domains',
                    subcommands: {
                        'add': {
                            syntax: 'cloud host add <hostname>',
                            description: 'Register a new host or domain',
                            examples: [
                                'cloud host add example.com',
                                'cloud host add api.myapp.io'
                            ]
                        },
                        'remove': {
                            syntax: 'cloud host remove <hostname>',
                            description: 'Remove a registered host',
                            examples: ['cloud host remove example.com']
                        },
                        'list': {
                            syntax: 'cloud host list',
                            description: 'List all registered hosts',
                            examples: ['cloud host list']
                        }
                    }
                },
                
                'repo': {
                    syntax: 'cloud repo <action>',
                    description: 'Manage cloud repositories',
                    subcommands: {
                        'add': {
                            syntax: 'cloud repo add <name> <url>',
                            description: 'Add repository to cloud',
                            examples: [
                                'cloud repo add MyAgents https://github.com/user/agents.git'
                            ]
                        },
                        'remove': {
                            syntax: 'cloud repo remove <name>',
                            description: 'Remove repository from cloud',
                            examples: ['cloud repo remove MyAgents']
                        },
                        'list': {
                            syntax: 'cloud repo list',
                            description: 'List cloud repositories',
                            examples: ['cloud repo list']
                        }
                    }
                },
                'destroy': {
                    syntax: 'cloud destroy <agents|server-agents>',
                    description: 'Stop and remove agent containers',
                    examples: [
                        'cloud destroy agents            # Local .ploinky/agents.json',
                        'cloud destroy server-agents     # On connected server'
                    ]
                },

                'logs': {
                    syntax: 'cloud logs [lines|list|download <date>]',
                    description: 'Inspect server logs',
                    examples: [
                        'cloud logs 200',
                        'cloud logs list',
                        'cloud logs download 2025-09-01'
                    ]
                },

                'settings': {
                    syntax: 'cloud settings <show|set>',
                    description: 'Show or update server settings',
                    examples: [
                        'cloud settings show',
                        'cloud settings set logLevel debug',
                        'cloud settings set metricsRetention 365'
                    ]
                },
                
                'agent': {
                    syntax: 'cloud agent <action>',
                    description: 'Manage deployed agents',
                    subcommands: {
                        'list': {
                            syntax: 'cloud agent list',
                            description: 'List available cloud agents',
                            examples: ['cloud agent list']
                        },
                        'info': {
                            syntax: 'cloud agent info <name>',
                            description: 'Show agent details',
                            examples: ['cloud agent info MyAPI']
                        },
                        'start': {
                            syntax: 'cloud agent start <name>',
                            description: 'Start a deployed agent',
                            examples: ['cloud agent start MyAPI']
                        },
                        'stop': {
                            syntax: 'cloud agent stop <name>',
                            description: 'Stop a running agent',
                            examples: ['cloud agent stop MyAPI']
                        },
                        'restart': {
                            syntax: 'cloud agent restart <name>',
                            description: 'Restart an agent',
                            examples: ['cloud agent restart MyAPI']
                        }
                    }
                },
                
                'deploy': {
                    syntax: 'cloud deploy <host> <path> <agent>',
                    description: 'Deploy agent to URL path',
                    params: {
                        '<host>': 'Target hostname',
                        '<path>': 'URL path (e.g., /mcp)',
                        '<agent>': 'Agent name to deploy'
                    },
                    examples: [
                        'cloud deploy example.com /mcp MyAPI',
                        'cloud deploy localhost /admin AdminPanel'
                    ],
                    notes: 'Agent will be accessible at http://host/path'
                },
                
                'undeploy': {
                    syntax: 'cloud undeploy <host> <path>',
                    description: 'Remove deployment',
                    params: {
                        '<host>': 'Hostname',
                        '<path>': 'URL path'
                    },
                    examples: ['cloud undeploy example.com /mcp']
                },
                
                'deployments': {
                    syntax: 'cloud deployments',
                    description: 'List all active deployments',
                    examples: ['cloud deployments']
                },
                
                'admin': {
                    syntax: 'cloud admin <action>',
                    description: 'Admin user management',
                    subcommands: {
                        'add': {
                            syntax: 'cloud admin add <username>',
                            description: 'Create new admin user',
                            examples: ['cloud admin add john']
                        },
                        'password': {
                            syntax: 'cloud admin password [username]',
                            description: 'Change admin password',
                            examples: [
                                'cloud admin password       # Change your password',
                                'cloud admin password john  # Change john\'s password'
                            ]
                        }
                    }
                }
            }
        },
        
        'client': {
            description: 'Client operations for interacting with deployed agents',
            subcommands: {
                'list': {
                    syntax: 'client list <tools|resources>',
                    description: 'Aggregate metadata across all MCP agents managed by the router.',
                    examples: [
                        'client list tools',
                        'client list resources'
                    ],
                    notes: 'Use subcommands for detailed help: help client list tools | help client list resources',
                    subcommands: {
                        'tools': {
                            syntax: 'client list tools',
                            description: 'List every MCP tool exposed by registered agents. Output is formatted as a readable bullet list grouped by agent.',
                            notes: 'Each line displays the agent, tool name, optional title, and description. Warnings are shown if any agent fails to respond.'
                        },
                        'resources': {
                            syntax: 'client list resources',
                            description: 'List every MCP resource exposed by registered agents. Useful for discovering resource URIs such as health endpoints or document catalogs.',
                            notes: 'Output mirrors the tool listing format, including warnings when agents fail to respond.'
                        }
                    }
                },
                'status': {
                    syntax: 'client status <agent>',
                    description: 'Get runtime status of an agent (if implemented by agent)' ,
                    params: {
                        '<agent>': 'Agent name'
                    },
                    examples: [
                        'client status MyAPI'
                    ],
                    notes: 'Shows state, uptime, resource usage, and recent activity'
                },
                'tool': {
                    syntax: 'client tool <toolName> [--agent <agent>] [--parameters <params> | -p <params>] [-key value...]',
                    description: 'Invokes an MCP tool by name. RouterServer routes the call to the agent that exposes the tool.',
                    params: {
                        '<toolName>': 'Tool to invoke. Must be unique across all agents unless --agent is provided.',
                        '[--agent <agent>]': 'Optional agent name to disambiguate when multiple agents expose the same tool.',
                        '[--parameters | -p]': 'Comma-separated key/value list parsed into a JSON object.',
                        '[-key value]': 'Additional individual parameters appended to the payload.'
                    },
                    examples: [
                        'client tool echo -text "hello"',
                        "client tool plan --agent demo -p steps[]=research,build,ship",
                        "client tool process -a data-agent -p 'config.level=high' -batch 1"
                    ],
                    notes: 'Flag-style parameters (e.g., --dry-run) are sent as boolean true. Use --agent when the same tool name exists on multiple agents.'
                },
                'task-status': {
                    syntax: 'client task-status <agent> <task-id>',
                    description: 'Compatibility helper for older task-status flows.',
                    params: {
                        '<agent>': 'Agent name',
                        '<task-id>': 'Task ID returned by an older agent-specific async task flow'
                    },
                    examples: [
                        'client task-status MyAPI task-123'
                    ],
                    notes: 'This is not standardized for MCP tools. Prefer `client tool <toolName>` for current agent operations.'
                }
            }
        }
    };

    const lifecycleDetails = surface === 'host'
        ? {
            status: {
                description: 'Show combined, read-only outer runtime and workspace status.',
                notes: 'This host-level status inspects the outer runtime and available core state without starting or reconciling anything.',
            },
            stop: {
                description: 'Stop core services, then stop the outer runtime.',
                notes: 'This host-level command preserves the workspace-backed .ploinky/box cache data.',
            },
            destroy: {
                description: 'Stop nested agents and remove the outer runtime, retaining the host workspace and its .ploinky/box dependency and image cache directories by default.',
                syntax: 'destroy [--delete-cache]',
                examples: ['destroy', 'destroy --delete-cache'],
                notes: 'Nested agents are stopped through the in-box helper before the outer runtime is removed; if that stop fails, the outer runtime is halted but nothing is removed. Both forms run without prompting. Without the flag, this host-level command retains the host workspace plus .ploinky/box/dependencies and .ploinky/box/images, so pinned dependencies and reusable nested image content survive destroy and recreate. With --delete-cache, it removes the outer runtime and then deletes exactly those two directories; the workspace, .ploinky/master-key, repositories, agents, routing state, and secrets are never deleted. Nested container records, writable layers, and inner named volumes are not retained by either form: they live on the outer runtime writable layer and are discarded with it, so persistent agent data must use workspace binds.',
            },
        }
        : {
            status: {
                description: 'Show workspace/router/agent state.',
                notes: 'This core command leaves the outer runtime running.',
            },
            stop: {
                description: 'Stop workspace services and leave the outer runtime running.',
                notes: 'Exit the REPL before running host ploinky stop or ploinky destroy.',
            },
            destroy: {
                description: 'Remove workspace containers and leave the outer runtime running.',
                notes: 'Exit the REPL before running host ploinky stop or ploinky destroy.',
            },
        };
    if (lifecycleDetails[topic]) {
        helpContent[topic] = {
            ...helpContent[topic],
            ...lifecycleDetails[topic],
        };
    }

    if (topic === 'cli' && !subtopic) {
        console.log(`
╔═══ HELP: cli ═══╗

cli
  Open /bin/bash in the managed outer runtime; exit returns to the previous prompt.

cli <agentName> [args...]
  Run the agent manifest CLI command interactively (attached TTY).
`);
        return;
    }
    
    // Display help based on requested topic (removed - not needed since we're already inside showDetailedHelp)
    
    // Handle cloud subcommands specially
    if (topic === 'cloud' && subtopic) {
        const cloudCmd = helpContent.cloud.subcommands[subtopic];
        if (!cloudCmd) {
            console.log(`Unknown cloud command: ${subtopic}`);
            console.log('Available cloud commands: ' + Object.keys(helpContent.cloud.subcommands).join(', '));
            return;
        }
        
        // Check for sub-subcommands
        if (subsubtopic && cloudCmd.subcommands && cloudCmd.subcommands[subsubtopic]) {
            const subCmd = cloudCmd.subcommands[subsubtopic];
            console.log(`\n╔═══ HELP: cloud ${subtopic} ${subsubtopic} ═══╗\n`);
            console.log(`SYNTAX:  ${subCmd.syntax}`);
            console.log(`\nDESCRIPTION:\n  ${subCmd.description}`);
            if (subCmd.examples) {
                console.log(`\nEXAMPLES:`);
                subCmd.examples.forEach(ex => console.log(`  ${ex}`));
            }
            console.log();
            return;
        }
        
        // Show cloud subcommand help
        console.log(`\n╔═══ HELP: cloud ${subtopic} ═══╗\n`);
        console.log(`SYNTAX:  ${cloudCmd.syntax}`);
        console.log(`\nDESCRIPTION:\n  ${cloudCmd.description}`);
        
        if (cloudCmd.params) {
            console.log(`\nPARAMETERS:`);
            for (const [param, desc] of Object.entries(cloudCmd.params)) {
                console.log(`  ${param.padEnd(12)} ${desc}`);
            }
        }
        
        if (cloudCmd.subcommands) {
            console.log(`\nSUBCOMMANDS:`);
            for (const [sub, data] of Object.entries(cloudCmd.subcommands)) {
                console.log(`  ${sub.padEnd(10)} ${data.description}`);
            }
            console.log(`\nFor more help: help cloud ${subtopic} <subcommand>`);
        }
        
        if (cloudCmd.examples) {
            console.log(`\nEXAMPLES:`);
            cloudCmd.examples.forEach(ex => console.log(`  ${ex}`));
        }
        
        if (cloudCmd.notes) {
            console.log(`\nNOTES:\n  ${cloudCmd.notes}`);
        }
        console.log();
        return;
    }
    
    // Show cloud overview
    if (topic === 'cloud' && !subtopic) {
        console.log(`\n╔═══ HELP: cloud ═══╗\n`);
        console.log('Cloud platform operations for managing remote deployments\n');
        console.log('SUBCOMMANDS:');
        for (const [cmd, data] of Object.entries(helpContent.cloud.subcommands)) {
            console.log(`  ${cmd.padEnd(12)} ${data.description}`);
        }
        console.log('\nFor detailed help: help cloud <subcommand>');
        console.log('Example: help cloud deploy');
        console.log();
        return;
    }
    
    // Handle client subcommands specially
    if (topic === 'client' && subtopic) {
        const clientCmd = helpContent.client.subcommands[subtopic];
        if (!clientCmd) {
            console.log(`Unknown client command: ${subtopic}`);
            console.log('Available client commands: ' + Object.keys(helpContent.client.subcommands).join(', '));
            return;
        }

        if (subsubtopic && clientCmd.subcommands && clientCmd.subcommands[subsubtopic]) {
            const deepCmd = clientCmd.subcommands[subsubtopic];
            console.log(`\n╔═══ HELP: client ${subtopic} ${subsubtopic} ═══╗\n`);
            console.log(`SYNTAX:  ${deepCmd.syntax}`);
            console.log(`\nDESCRIPTION:\n  ${deepCmd.description}`);

            if (deepCmd.params) {
                console.log(`\nPARAMETERS:`);
                for (const [param, desc] of Object.entries(deepCmd.params)) {
                    console.log(`  ${param.padEnd(20)} ${desc}`);
                }
            }

            if (deepCmd.examples) {
                console.log(`\nEXAMPLES:`);
                deepCmd.examples.forEach(ex => console.log(`  ${ex}`));
            }

            if (deepCmd.notes) {
                console.log(`\nNOTES:\n  ${deepCmd.notes}`);
            }
            console.log();
            return;
        }

        console.log(`\n╔═══ HELP: client ${subtopic} ═══╗\n`);
        console.log(`SYNTAX:  ${clientCmd.syntax}`);
        console.log(`\nDESCRIPTION:\n  ${clientCmd.description}`);

        if (clientCmd.params) {
            console.log(`\nPARAMETERS:`);
            for (const [param, desc] of Object.entries(clientCmd.params)) {
                console.log(`  ${param.padEnd(20)} ${desc}`);
            }
        }

        if (clientCmd.subcommands) {
            console.log(`\nSUBCOMMANDS:`);
            for (const [sub, data] of Object.entries(clientCmd.subcommands)) {
                console.log(`  ${sub.padEnd(10)} ${data.description || ''}`);
            }
            console.log(`\nFor more help: help client ${subtopic} <subcommand>`);
        }

        if (clientCmd.examples) {
            console.log(`\nEXAMPLES:`);
            clientCmd.examples.forEach(ex => console.log(`  ${ex}`));
        }
        
        if (clientCmd.notes) {
            console.log(`\nNOTES:\n  ${clientCmd.notes}`);
        }
        console.log();
        return;
    }
    
    // Show client overview
    if (topic === 'client' && !subtopic) {
        console.log(`\n╔═══ HELP: client ═══╗\n`);
        console.log('Client operations for interacting with deployed agents\n');
        console.log('SUBCOMMANDS:');
        for (const [cmd, data] of Object.entries(helpContent.client.subcommands)) {
            console.log(`  ${cmd.padEnd(12)} ${data.description}`);
        }
        console.log('\nFor detailed help: help client <subcommand>');
        console.log('Example: help client tool');
        console.log();
        return;
    }
    
    // Handle other top-level commands
    const cmd = helpContent[topic];
    if (!cmd) {
        console.log(`Unknown command: ${topic}`);
        console.log('Type "help" for available commands');
        return;
    }
    
    // Check for subcommands
    if (subtopic && cmd.subcommands && cmd.subcommands[subtopic]) {
        const subCmd = cmd.subcommands[subtopic];
        console.log(`\n╔═══ HELP: ${topic} ${subtopic} ═══╗\n`);
        console.log(`SYNTAX:  ${subCmd.syntax}`);
        console.log(`\nDESCRIPTION:\n  ${subCmd.description}`);
        
        if (subCmd.params) {
            console.log(`\nPARAMETERS:`);
            for (const [param, desc] of Object.entries(subCmd.params)) {
                console.log(`  ${param.padEnd(12)} ${desc}`);
            }
        }
        
        if (subCmd.examples) {
            console.log(`\nEXAMPLES:`);
            subCmd.examples.forEach(ex => console.log(`  ${ex}`));
        }
        
        if (subCmd.notes) {
            console.log(`\nNOTES:\n  ${subCmd.notes}`);
        }
        console.log();
        return;
    }
    
    // Show command help
    console.log(`\n╔═══ HELP: ${topic} ═══╗\n`);
    
    if (cmd.syntax) {
        console.log(`SYNTAX:  ${cmd.syntax}`);
    }
    
    console.log(`\nDESCRIPTION:\n  ${cmd.description}`);
    
    if (cmd.params) {
        console.log(`\nPARAMETERS:`);
        for (const [param, desc] of Object.entries(cmd.params)) {
            console.log(`  ${param.padEnd(20)} ${desc}`);
        }
    }
    
    if (cmd.subcommands) {
        console.log(`\nSUBCOMMANDS:`);
        for (const [sub, data] of Object.entries(cmd.subcommands)) {
            console.log(`  ${sub.padEnd(10)} ${data.description}`);
        }
        console.log(`\nFor more help: help ${topic} <subcommand>`);
    }
    
    if (cmd.examples) {
        console.log(`\nEXAMPLES:`);
        cmd.examples.forEach(ex => console.log(`  ${ex}`));
    }
    
    if (cmd.notes) {
        console.log(`\nNOTES:\n  ${cmd.notes}`);
    }
    
    console.log();
}
