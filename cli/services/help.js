export function showHelp(args = []) {
    // Parse help arguments
    const topic = args[0];
    const subtopic = args[1];
    const subsubtopic = args[2];
    
    // Detailed help for specific commands
    if (topic) {
        if (topic === 'cloud') { console.log('Cloud commands are not available in this build.'); return; }
        return showDetailedHelp(topic, subtopic, subsubtopic);
    }
    
    // Main help overview
    console.log(`
╔═══ PLOINKY ═══╗ Container Development & Cloud Platform

▶ LOCAL DEVELOPMENT
  add repo <name> [url] [branch] Add repository (basic/cloud/vibe/security/extra/demo)
  update [folderPath]            Update Ploinky, .ploinky/repos, Achilles deps, projects, and default skills
  start [staticAgent] [port]     Start agents from .ploinky/agents.json and launch Router
  shell <agentName>              Open interactive sh in container (attached TTY)
  cli <agentName> [args...]      Run manifest "cli" command (attached TTY)
  webconsole [shell] [--rotate]  Prepare WebTTY (alias). Prints URL; login happens in router.
  webtty [shell] [--rotate]      Prepare WebTTY and print access URL. Optional shell.
  webchat [--rotate]             Print the WebChat access URL and support agent URL params
  dashboard [--rotate]           Show or rotate Dashboard token and print access URL
  sso enable|disable|status  Bind or inspect SSO provider agents
  sandbox status|disable|enable  Force lite-sandbox agents to use containers, or restore bwrap/seatbelt
  vars                           List all variable names (no values)
  var <VAR> <value>              Set a variable value
  echo <VAR|$VAR>                Print the resolved value of a variable
  expose <ENV_NAME> [<$VAR|value>] [agent]  Expose to agent environment
  default-skills <repoName>      Refresh repo skills into .agents/skills while preserving other skills
  list agents | repos            List agents (manifests) or predefined repos


▶ CLIENT OPERATIONS
  client tool <name>             Invoke any MCP tool exposed by agents via RoutingServer
  client list tools              Aggregate tools exposed by all agents
  client list resources          Aggregate resources exposed by all agents
  client status <agent>          One-line status (HTTP code, parsed)

  status | restart               Show state | restart enabled agents + Router
  disable agents-all             Disable all enabled agents (non-destructive)
  reinstall <agentName>          Re-create a running agent container (destructive)
  stop | shutdown | clean        Stop containers | remove containers
  logs tail [router]             Follow router logs
  logs last <N>                  Show last N router log lines

▶ FOR DETAILED HELP
  help <command>                 Show detailed help for a command
  Examples: help add | help cli

Config stored in .ploinky/ • Type 'help' for commands
╚═══════════════════════════════════════════════════════╝
`);
}

function showDetailedHelp(topic, subtopic, subsubtopic) {
    const helpContent = {
        // Local development commands
        'add': {
            description: 'Add repositories or environment variables',
            subcommands: {
                'repo': {
                    syntax: 'add repo <name> [url] [branch] | add repo <name> [url] --branch <branch>',
                    description: 'Add an agent repository to your local environment',
                    params: {
                        '<name>': 'Repository name (cloud/vibe/security/extra for predefined, or custom name)',
                        '[url]': 'Git URL for custom repositories (optional for predefined repos)',
                        '[branch]': 'Git branch to clone (optional, defaults to repository default branch)'
                    },
                    examples: [
                        'add repo cloud           # Add predefined cloud repository',
                        'add repo myrepo https://github.com/user/repo.git  # Add custom repo',
                        'add repo basic profile_implementation  # Add basic repo at specific branch',
                        'add repo myrepo https://github.com/user/repo.git --branch feature  # Add with branch flag'
                    ],
                    notes: 'Predefined repos: cloud (AWS/Azure/GCP), vibe (social), security (auth/crypto), extra (utilities). Branch can be specified as a positional argument or with --branch flag.'
                },

            }
        },
        'var': {
            description: 'Set a workspace variable (stored encrypted in .ploinky/.secrets)',
            syntax: 'var <VAR> <value>',
            examples: [
                'var WEBDASHBOARD_TOKEN deadbeef  # Override dashboard token manually',
                'var API_KEY sk-123456'
            ],
            notes: "Use 'vars' to list variables. WebTTY/WebChat/WebMeet use the router login flow; only dashboard still uses a surface token."
        },
        'vars': {
            description: 'List workspace variables (from encrypted .ploinky/.secrets)',
            syntax: 'vars',
            examples: [ 'vars' ]
        },
        
        'update': {
            description: 'Update Ploinky itself, its Achilles runtime checkout, workspace repositories, Achilles dependencies, and project repositories',
            syntax: 'update [folderPath] | update all [folderPath] | update repos | update repo <name>',
            examples: [ 'update', 'update /work/projects', 'update all /work/projects', 'update repo basic' ],
            notes: '`update` is the same full workflow as `update all`: it runs git pull --rebase --autostash for the Ploinky checkout, refreshes ploinky/node_modules/achillesAgentLib, updates .ploinky/repos, and updates git repositories discovered recursively from folderPath. Without folderPath, discovery starts at the current working directory. Missing or unreachable remotes in discovered project repositories are logged and skipped instead of failing the full update; managed .ploinky/repos updates remain strict. `update repos` updates installed .ploinky/repos, the Ploinky runtime achillesAgentLib checkout, and managed-repo achillesAgentLib packages. Discovered project repositories also receive refreshed AchillesCopilotBasicSkills copies and managed .gitignore entries, even when their remote update was skipped. In an interactive Ploinky session, a detected Ploinky self-update is deferred: close the session, run `ploinky update`, then restart Ploinky so the new code is loaded.'
        },
        
        
        'shell': {
            description: 'Interactive shell session',
            subcommands: {
                'default': {
                    syntax: 'shell <agentName>',
                    description: 'Open interactive POSIX sh (attached TTY) in the agent container',
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
        'webconsole': {
            description: 'Alias of webtty. Optionally configure shell for console sessions and print the access URL.',
            syntax: 'webconsole [shell] [--rotate]',
            examples: [ 'webconsole', 'webconsole zsh', 'webconsole --rotate' ],
            notes: 'Allowed shells: sh, zsh, dash, ksh, csh, tcsh, fish, or absolute path. If a shell is provided, the router restarts (if configured). WebTTY now uses the normal router login flow. `--rotate` no longer changes anything for this surface.'
        },
        'webtty': {
            description: 'Prepare WebTTY. Optionally configure shell for console sessions and print the access URL.',
            syntax: 'webtty [shell] [--rotate]',
            examples: [ 'webtty', 'webtty sh', 'webtty --rotate' ],
            notes: 'Allowed shells: sh, zsh, dash, ksh, csh, tcsh, fish, or absolute path. If a shell is provided, the router restarts (if configured). WebTTY now uses the normal router login flow. `--rotate` no longer changes anything for this surface.'
        },
        'webchat': {
            description: 'Print the WebChat URL served at /webchat.',
            syntax: 'webchat [--rotate]',
            examples: [
                'webchat',
                'webchat --rotate',
                '/webchat?agent=achilles-cli&path=/absolute/path'
            ],
            notes: 'WebChat now uses the normal router login flow. `--rotate` no longer changes anything for this surface. When `/webchat` is opened with `?agent=<name>&...`, every extra query parameter except internal router/session fields is forwarded to `ploinky cli <name>` as a single-token long-form CLI flag in the form `--key=value`.'
        },
        'dashboard': {
            description: 'Display or rotate the Dashboard token used by /dashboard.',
            syntax: 'dashboard [--rotate]',
            examples: [ 'dashboard', 'dashboard --rotate' ],
            notes: 'Writes the token to encrypted .ploinky/.secrets and prints an access URL. `echo $WEBDASHBOARD_TOKEN` to print it.'
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
        
        
        'shutdown': {
            description: 'Stop and remove containers recorded in .ploinky/agents.json',
            syntax: 'shutdown',
            examples: ['shutdown'],
            notes: 'Removes containers for all enabled agents in this workspace.'
        },
        'destroy': {
            description: 'Stop and remove all Ploinky containers created in this workspace',
            syntax: 'destroy',
            examples: ['destroy'],
            notes: 'Irreversible for running containers; also clears .ploinky/agents so dependencies are rebuilt on next start.'
        },
        
        'enable': {
            description: 'Enable features for agents and repos',
            subcommands: {
                'sandbox': {
                    syntax: 'enable sandbox',
                    description: 'Restore manifest-driven bwrap/seatbelt selection for this workspace.',
                    examples: [ 'enable sandbox' ],
                    notes: 'Equivalent to `sandbox enable`. Restart running agents to apply the change.'
                },
                'repo': {
                    syntax: 'enable repo <name> [branch] | enable repo <name> --branch <branch>',
                    description: 'Enable a repository for agent listings (see list repos). If not already installed, clones the repository.',
                    params: {
                        '<name>': 'Repository name (predefined or custom)',
                        '[branch]': 'Git branch to clone (optional, only used when cloning)'
                    },
                    examples: [
                        'enable repo cloud',
                        'enable repo basic',
                        'enable repo basic profile_implementation  # Enable and clone at specific branch',
                        'enable repo demo --branch feature  # Enable with branch flag'
                    ],
                    notes: 'Branch is only used when the repository needs to be cloned. If the repo is already installed, the branch argument is ignored.'
                },
                'agent': {
                    syntax: 'enable agent <name|repo/name> [global|devel [repoName]] [--auth none|pwd|sso] [--user <name> --password <value>] [as <alias>]',
                    description: 'Register agent in .ploinky/agents.json (for start/stop/shutdown). Modes: isolated (omitted) creates a subfolder <agentName>; global uses current project; devel uses a repo under .ploinky/repos. Use "as <alias>" to create an additional instance with its own container name.',
                    examples: [
                        'enable agent demo',
                        'enable agent demo --auth pwd',
                        'enable agent demo --auth pwd --user admin --password admin',
                        'enable agent demo --auth sso',
                        'enable agent demo global',
                        'enable agent demo devel simulator',
                        'enable agent demo as demo2'
                    ],
                    notes: 'If --auth is omitted, no auth is applied unless the agent manifest declares a default auth mode. Pwd auth stores policy in .ploinky/agents.json and can also seed credentials via --user/--password or manifest defaults under `pwd.user` and `pwd.password`. Note: enable agent is optional. You can `enable repo` then `start <agent>`; it will use isolated mode (creates <agentName> subfolder). Aliases must be unique; commands like reinstall/disable should target the alias when multiple containers exist.'
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
            syntax: 'start [staticAgent] [port] [--branch <branch>] [--repo-branch <repo>=<branch>] [--branch-fallback default|fail] [--reset-repos]',
            examples: [ 'start MyStaticAgent 8080', 'start', 'start explorer 8080 --branch soul-gateway-local-integration' ],
            notes: 'Reads manifest of static agent: applies repos{} (clone+enable) and enable[] (enable agents). First run needs agent and port. --branch <branch> applies best-effort to the static agent\'s repo, every manifest dependency repo, AND the achillesAgentLib used by agent containers — each uses that branch where it exists, else its default/pinned branch. --repo-branch <repo>=<branch> (repeatable) overrides a single repo; --branch-fallback <default|fail> (fail aborts when a targeted branch is missing); --reset-repos force-checks-out dirty repos. (Advanced escape hatch: export PLOINKY_AGENTLIB_REF=<branch|git+/file: spec> to override just the achillesAgentLib source.)'
        },
        'status': {
            description: 'Show enabled agents and router configuration',
            syntax: 'status',
            examples: [ 'status' ],
            notes: 'Reads .ploinky/agents.json and prints container, binds, ports, and static config.'
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
            description: 'Restarts services. If an agent name is provided, it performs a non-destructive stop and start of that agent\'s container. If no agent name is provided, it restarts all agents and the router.',
            syntax: 'restart [agentName]',
            examples: [ 'restart', 'restart MyAPI' ],
            notes: 'The command only affects running containers when an agent name is specified. The general restart fails if start was not configured yet.'
        },
        'logs': {
            description: 'Inspect router logs',
            subcommands: {
                'tail': {
                    syntax: 'logs tail [router]',
                    description: 'Follow router logs',
                    examples: [ 'logs tail', 'logs tail router' ]
                },
                'last': {
                    syntax: 'logs last <N>',
                    description: 'Show last N router log lines',
                    examples: [ 'logs last 200', 'logs last 50' ]
                }
            }
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
                'repo': {
                    syntax: 'disable repo <name>',
                    description: 'Disable a repository from agent listings',
                    examples: [ 'disable repo cloud' ]
                },
                'agent': {
                    syntax: 'disable <agentName>',
                    description: 'Remove an enabled agent from .ploinky/agents.json (container must be destroyed first)',
                    examples: [ 'disable demo', 'disable agent repoName/demo' ]
                },
                'agents-all': {
                    syntax: 'disable agents-all',
                    description: 'Attempt to disable all enabled agents from .ploinky/agents.json without destroying containers',
                    examples: [ 'disable agents-all' ],
                    notes: 'Non-destructive: agents with existing containers are reported and skipped. Use stop/destroy first for full cleanup.'
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
                    description: 'List available repositories with URLs; mark installed and enabled. Use enable repo <name> to include in listings.',
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
                    description: 'Check the status of a submitted task',
                    params: {
                        '<agent>': 'Agent name',
                        '<task-id>': 'Task ID returned when task was submitted'
                    },
                    examples: [
                        'client task-status MyAPI task-123'
                    ]
                }
            }
        }
    };
    
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
