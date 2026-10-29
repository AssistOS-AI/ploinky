// Sanitized subsets of the G-L observations (nested Podman 5.8.2 / crun 1.27.1 inside the pinned Box image,
// 2026-10-29, run c4ca34): only security-relevant fields; host paths, env and image data are dropped.
// Real ordinary agents: `podman inspect` omits HostConfig.MaskedPaths/ReadonlyPaths, the exact-instance OCI spec
// at OCIConfigPath carries them.
export const GL_FIXTURES = {
    "darwinArm64": {
        "inspect": {
            "Id": "0f4e9d40ee5e92483e0d2b9ceae02d9c7ade5eb74fc99c7d7a2d1f91b19a2f73",
            "OCIConfigPath": "/tmp/storage-run-1000/overlay-containers/0f4e9d40ee5e92483e0d2b9ceae02d9c7ade5eb74fc99c7d7a2d1f91b19a2f73/userdata/config.json",
            "OCIRuntime": "crun",
            "Config": {
                "Labels": {
                    "io.assistos.ploinky.enable-generation": "a438d06e-7c7e-489e-88c5-8141aa7b5b29",
                    "io.assistos.ploinky.instance-id": "004adde6-ed4c-413c-a223-6faed12ea76c",
                    "io.assistos.ploinky.managed": "1",
                    "io.assistos.ploinky.resource": "agent",
                    "io.assistos.ploinky.workspace": "1033bee122ce"
                }
            },
            "HostConfig": {
                "Privileged": false,
                "SecurityOpt": []
            },
            "Mounts": [
                {
                    "Type": "bind",
                    "Destination": "/Agent",
                    "RW": false
                },
                {
                    "Type": "bind",
                    "Destination": "/root/.ploinky/repos",
                    "RW": true
                },
                {
                    "Type": "bind",
                    "Destination": "/shared",
                    "RW": true
                },
                {
                    "Type": "bind",
                    "Destination": "/root/.ploinky",
                    "RW": false
                },
                {
                    "Type": "bind",
                    "Destination": "/code",
                    "RW": false
                },
                {
                    "Type": "bind",
                    "Destination": "/ws/.ploinky/deps/store/objects/dc27607a-6d94-4c94-9e0b-90fb1dc79ca5/payload/node_modules",
                    "RW": false
                },
                {
                    "Type": "bind",
                    "Destination": "/opt/ploinky-agentlib",
                    "RW": false
                },
                {
                    "Type": "bind",
                    "Destination": "/run/ploinky-health-probes",
                    "RW": true
                },
                {
                    "Type": "bind",
                    "Destination": "/root/.ploinky/data",
                    "RW": false
                },
                {
                    "Type": "bind",
                    "Destination": "/run/ploinky-edge-topology",
                    "RW": false
                },
                {
                    "Type": "bind",
                    "Destination": "/root",
                    "RW": true
                },
                {
                    "Type": "bind",
                    "Destination": "/root/.ploinky-box",
                    "RW": false
                },
                {
                    "Type": "bind",
                    "Destination": "/ws/glrepo/glagent",
                    "RW": false
                },
                {
                    "Type": "bind",
                    "Destination": "/run/ploinky/router-descriptor.json",
                    "RW": false
                },
                {
                    "Type": "bind",
                    "Destination": "/code/node_modules",
                    "RW": false
                },
                {
                    "Type": "bind",
                    "Destination": "/home/agent",
                    "RW": true
                }
            ]
        },
        "spec": {
            "ociVersion": "1.2.1",
            "linux": {
                "maskedPaths": [
                    "/proc/acpi",
                    "/proc/kcore",
                    "/proc/keys",
                    "/proc/latency_stats",
                    "/proc/sched_debug",
                    "/proc/scsi",
                    "/proc/timer_list",
                    "/proc/timer_stats",
                    "/sys/devices/virtual/powercap",
                    "/sys/firmware",
                    "/sys/fs/selinux",
                    "/proc/interrupts",
                    "/sys/devices/virtual/powercap"
                ],
                "readonlyPaths": [
                    "/proc/asound",
                    "/proc/bus",
                    "/proc/fs",
                    "/proc/irq",
                    "/proc/sys",
                    "/proc/sysrq-trigger"
                ]
            },
            "mounts": [
                {
                    "destination": "/shared",
                    "type": "bind",
                    "options": [
                        "rprivate",
                        "rbind"
                    ]
                },
                {
                    "destination": "/Agent",
                    "type": "bind",
                    "options": [
                        "ro",
                        "rprivate",
                        "rbind"
                    ]
                },
                {
                    "destination": "/code",
                    "type": "bind",
                    "options": [
                        "ro",
                        "rprivate",
                        "rbind"
                    ]
                },
                {
                    "destination": "/root",
                    "type": "bind",
                    "options": [
                        "rprivate",
                        "rbind"
                    ]
                },
                {
                    "destination": "/proc",
                    "type": "proc",
                    "options": [
                        "nosuid",
                        "noexec",
                        "nodev"
                    ]
                },
                {
                    "destination": "/dev",
                    "type": "tmpfs",
                    "options": [
                        "nosuid",
                        "strictatime",
                        "mode=755",
                        "size=65536k"
                    ]
                },
                {
                    "destination": "/sys",
                    "type": "sysfs",
                    "options": [
                        "nosuid",
                        "noexec",
                        "nodev",
                        "ro"
                    ]
                },
                {
                    "destination": "/root/.ploinky-box",
                    "type": "bind",
                    "options": [
                        "ro",
                        "rprivate",
                        "nosuid",
                        "nodev",
                        "rbind"
                    ]
                },
                {
                    "destination": "/home/agent",
                    "type": "bind",
                    "options": [
                        "rprivate",
                        "rbind"
                    ]
                },
                {
                    "destination": "/opt/ploinky-agentlib",
                    "type": "bind",
                    "options": [
                        "ro",
                        "rprivate",
                        "nodev",
                        "rbind"
                    ]
                },
                {
                    "destination": "/run/ploinky-edge-topology",
                    "type": "bind",
                    "options": [
                        "ro",
                        "rprivate",
                        "rbind"
                    ]
                },
                {
                    "destination": "/run/ploinky-health-probes",
                    "type": "bind",
                    "options": [
                        "rprivate",
                        "nosuid",
                        "nodev",
                        "rbind"
                    ]
                },
                {
                    "destination": "/code/node_modules",
                    "type": "bind",
                    "options": [
                        "ro",
                        "rprivate",
                        "rbind"
                    ]
                },
                {
                    "destination": "/run/podman-init",
                    "type": "bind",
                    "options": [
                        "bind",
                        "ro",
                        "private",
                        "nodev"
                    ]
                },
                {
                    "destination": "/root/.ploinky",
                    "type": "bind",
                    "options": [
                        "ro",
                        "rprivate",
                        "rbind"
                    ]
                },
                {
                    "destination": "/dev/pts",
                    "type": "devpts",
                    "options": [
                        "nosuid",
                        "noexec",
                        "newinstance",
                        "ptmxmode=0666",
                        "mode=0620",
                        "gid=5"
                    ]
                },
                {
                    "destination": "/dev/mqueue",
                    "type": "mqueue",
                    "options": [
                        "nosuid",
                        "noexec",
                        "nodev"
                    ]
                },
                {
                    "destination": "/etc/resolv.conf",
                    "type": "bind",
                    "options": [
                        "bind",
                        "rprivate"
                    ]
                },
                {
                    "destination": "/etc/hosts",
                    "type": "bind",
                    "options": [
                        "bind",
                        "rprivate"
                    ]
                },
                {
                    "destination": "/dev/shm",
                    "type": "bind",
                    "options": [
                        "bind",
                        "rprivate",
                        "nosuid",
                        "noexec",
                        "nodev"
                    ]
                },
                {
                    "destination": "/run/.containerenv",
                    "type": "bind",
                    "options": [
                        "bind",
                        "rprivate"
                    ]
                },
                {
                    "destination": "/etc/hostname",
                    "type": "bind",
                    "options": [
                        "bind",
                        "rprivate"
                    ]
                },
                {
                    "destination": "/root/.ploinky/data",
                    "type": "bind",
                    "options": [
                        "ro",
                        "rprivate",
                        "nosuid",
                        "nodev",
                        "rbind"
                    ]
                },
                {
                    "destination": "/root/.ploinky/repos",
                    "type": "bind",
                    "options": [
                        "rprivate",
                        "rbind"
                    ]
                },
                {
                    "destination": "/run/ploinky/router-descriptor.json",
                    "type": "bind",
                    "options": [
                        "ro",
                        "rprivate",
                        "rbind"
                    ]
                },
                {
                    "destination": "/sys/fs/cgroup",
                    "type": "cgroup",
                    "options": [
                        "rprivate",
                        "nosuid",
                        "noexec",
                        "nodev",
                        "relatime",
                        "ro"
                    ]
                },
                {
                    "destination": "/run/secrets/rhsm",
                    "type": "bind",
                    "options": [
                        "bind",
                        "rprivate"
                    ]
                },
                {
                    "destination": "/ws/glrepo/glagent",
                    "type": "bind",
                    "options": [
                        "ro",
                        "rprivate",
                        "rbind"
                    ]
                },
                {
                    "destination": "/ws/.ploinky/deps/store/objects/dc27607a-6d94-4c94-9e0b-90fb1dc79ca5/payload/node_modules",
                    "type": "bind",
                    "options": [
                        "ro",
                        "rprivate",
                        "rbind"
                    ]
                }
            ]
        },
        "info": {
            "version": {
                "Version": "5.8.2"
            },
            "host": {
                "ociRuntime": {
                    "name": "crun",
                    "version": "crun version 1.27.1"
                }
            }
        }
    },
    "linuxAmd64": {
        "inspect": {
            "Id": "eb2278b3341660c198462df478188aa36c8ab0cb7765848befdbe3fcb7912c99",
            "OCIConfigPath": "/tmp/storage-run-1000/overlay-containers/eb2278b3341660c198462df478188aa36c8ab0cb7765848befdbe3fcb7912c99/userdata/config.json",
            "OCIRuntime": "crun",
            "Config": {
                "Labels": {
                    "io.assistos.ploinky.enable-generation": "5b7fcf62-eeae-4fd6-876d-cb51fb834f56",
                    "io.assistos.ploinky.instance-id": "1024d848-aa94-4f91-870d-ae4b8af71589",
                    "io.assistos.ploinky.managed": "1",
                    "io.assistos.ploinky.resource": "agent",
                    "io.assistos.ploinky.workspace": "b78845273e26"
                }
            },
            "HostConfig": {
                "Privileged": false,
                "SecurityOpt": []
            },
            "Mounts": [
                {
                    "Type": "bind",
                    "Destination": "/code",
                    "RW": false
                },
                {
                    "Type": "bind",
                    "Destination": "/shared",
                    "RW": true
                },
                {
                    "Type": "bind",
                    "Destination": "/home/agent",
                    "RW": true
                },
                {
                    "Type": "bind",
                    "Destination": "/run/ploinky/router-descriptor.json",
                    "RW": false
                },
                {
                    "Type": "bind",
                    "Destination": "/opt/ploinky-agentlib",
                    "RW": false
                },
                {
                    "Type": "bind",
                    "Destination": "/run/ploinky-health-probes",
                    "RW": true
                },
                {
                    "Type": "bind",
                    "Destination": "/root",
                    "RW": true
                },
                {
                    "Type": "bind",
                    "Destination": "/root/.ploinky/data",
                    "RW": false
                },
                {
                    "Type": "bind",
                    "Destination": "/run/ploinky-edge-topology",
                    "RW": false
                },
                {
                    "Type": "bind",
                    "Destination": "/code/node_modules",
                    "RW": false
                },
                {
                    "Type": "bind",
                    "Destination": "/root/.ploinky",
                    "RW": false
                },
                {
                    "Type": "bind",
                    "Destination": "/root/.ploinky/repos",
                    "RW": true
                },
                {
                    "Type": "bind",
                    "Destination": "/root/.ploinky-box",
                    "RW": false
                },
                {
                    "Type": "bind",
                    "Destination": "/ws/glrepo/glagent",
                    "RW": false
                },
                {
                    "Type": "bind",
                    "Destination": "/ws/.ploinky/deps/store/objects/731426d0-ce45-49d8-b17b-5c9e81bc8277/payload/node_modules",
                    "RW": false
                },
                {
                    "Type": "bind",
                    "Destination": "/Agent",
                    "RW": false
                }
            ]
        },
        "spec": {
            "ociVersion": "1.2.1",
            "linux": {
                "maskedPaths": [
                    "/proc/acpi",
                    "/proc/kcore",
                    "/proc/keys",
                    "/proc/latency_stats",
                    "/proc/sched_debug",
                    "/proc/scsi",
                    "/proc/timer_list",
                    "/proc/timer_stats",
                    "/sys/devices/virtual/powercap",
                    "/sys/firmware",
                    "/sys/fs/selinux",
                    "/proc/interrupts",
                    "/sys/devices/system/cpu/cpu0/thermal_throttle",
                    "/sys/devices/system/cpu/cpu1/thermal_throttle",
                    "/sys/devices/system/cpu/cpu10/thermal_throttle",
                    "/sys/devices/system/cpu/cpu11/thermal_throttle",
                    "/sys/devices/system/cpu/cpu12/thermal_throttle",
                    "/sys/devices/system/cpu/cpu13/thermal_throttle",
                    "/sys/devices/system/cpu/cpu14/thermal_throttle",
                    "/sys/devices/system/cpu/cpu15/thermal_throttle",
                    "/sys/devices/system/cpu/cpu16/thermal_throttle",
                    "/sys/devices/system/cpu/cpu17/thermal_throttle",
                    "/sys/devices/system/cpu/cpu18/thermal_throttle",
                    "/sys/devices/system/cpu/cpu19/thermal_throttle",
                    "/sys/devices/system/cpu/cpu2/thermal_throttle",
                    "/sys/devices/system/cpu/cpu3/thermal_throttle",
                    "/sys/devices/system/cpu/cpu4/thermal_throttle",
                    "/sys/devices/system/cpu/cpu5/thermal_throttle",
                    "/sys/devices/system/cpu/cpu6/thermal_throttle",
                    "/sys/devices/system/cpu/cpu7/thermal_throttle",
                    "/sys/devices/system/cpu/cpu8/thermal_throttle",
                    "/sys/devices/system/cpu/cpu9/thermal_throttle",
                    "/sys/devices/virtual/powercap"
                ],
                "readonlyPaths": [
                    "/proc/asound",
                    "/proc/bus",
                    "/proc/fs",
                    "/proc/irq",
                    "/proc/sys",
                    "/proc/sysrq-trigger"
                ]
            },
            "mounts": [
                {
                    "destination": "/root",
                    "type": "bind",
                    "options": [
                        "rprivate",
                        "rbind"
                    ]
                },
                {
                    "destination": "/Agent",
                    "type": "bind",
                    "options": [
                        "ro",
                        "rprivate",
                        "rbind"
                    ]
                },
                {
                    "destination": "/code",
                    "type": "bind",
                    "options": [
                        "ro",
                        "rprivate",
                        "rbind"
                    ]
                },
                {
                    "destination": "/shared",
                    "type": "bind",
                    "options": [
                        "rprivate",
                        "rbind"
                    ]
                },
                {
                    "destination": "/proc",
                    "type": "proc",
                    "options": [
                        "nosuid",
                        "noexec",
                        "nodev"
                    ]
                },
                {
                    "destination": "/dev",
                    "type": "tmpfs",
                    "options": [
                        "nosuid",
                        "strictatime",
                        "mode=755",
                        "size=65536k"
                    ]
                },
                {
                    "destination": "/sys",
                    "type": "sysfs",
                    "options": [
                        "nosuid",
                        "noexec",
                        "nodev",
                        "ro"
                    ]
                },
                {
                    "destination": "/root/.ploinky-box",
                    "type": "bind",
                    "options": [
                        "ro",
                        "rprivate",
                        "nosuid",
                        "nodev",
                        "rbind"
                    ]
                },
                {
                    "destination": "/home/agent",
                    "type": "bind",
                    "options": [
                        "rprivate",
                        "rbind"
                    ]
                },
                {
                    "destination": "/run/ploinky-edge-topology",
                    "type": "bind",
                    "options": [
                        "ro",
                        "rprivate",
                        "rbind"
                    ]
                },
                {
                    "destination": "/code/node_modules",
                    "type": "bind",
                    "options": [
                        "ro",
                        "rprivate",
                        "rbind"
                    ]
                },
                {
                    "destination": "/opt/ploinky-agentlib",
                    "type": "bind",
                    "options": [
                        "ro",
                        "rprivate",
                        "rbind"
                    ]
                },
                {
                    "destination": "/root/.ploinky",
                    "type": "bind",
                    "options": [
                        "ro",
                        "rprivate",
                        "rbind"
                    ]
                },
                {
                    "destination": "/run/ploinky-health-probes",
                    "type": "bind",
                    "options": [
                        "rprivate",
                        "nosuid",
                        "nodev",
                        "rbind"
                    ]
                },
                {
                    "destination": "/run/podman-init",
                    "type": "bind",
                    "options": [
                        "bind",
                        "ro",
                        "private"
                    ]
                },
                {
                    "destination": "/dev/pts",
                    "type": "devpts",
                    "options": [
                        "nosuid",
                        "noexec",
                        "newinstance",
                        "ptmxmode=0666",
                        "mode=0620",
                        "gid=5"
                    ]
                },
                {
                    "destination": "/dev/mqueue",
                    "type": "mqueue",
                    "options": [
                        "nosuid",
                        "noexec",
                        "nodev"
                    ]
                },
                {
                    "destination": "/dev/shm",
                    "type": "bind",
                    "options": [
                        "bind",
                        "rprivate",
                        "nosuid",
                        "noexec",
                        "nodev"
                    ]
                },
                {
                    "destination": "/run/.containerenv",
                    "type": "bind",
                    "options": [
                        "bind",
                        "rprivate"
                    ]
                },
                {
                    "destination": "/etc/hostname",
                    "type": "bind",
                    "options": [
                        "bind",
                        "rprivate"
                    ]
                },
                {
                    "destination": "/etc/resolv.conf",
                    "type": "bind",
                    "options": [
                        "bind",
                        "rprivate"
                    ]
                },
                {
                    "destination": "/etc/hosts",
                    "type": "bind",
                    "options": [
                        "bind",
                        "rprivate"
                    ]
                },
                {
                    "destination": "/run/ploinky/router-descriptor.json",
                    "type": "bind",
                    "options": [
                        "ro",
                        "rprivate",
                        "rbind"
                    ]
                },
                {
                    "destination": "/root/.ploinky/repos",
                    "type": "bind",
                    "options": [
                        "rprivate",
                        "rbind"
                    ]
                },
                {
                    "destination": "/root/.ploinky/data",
                    "type": "bind",
                    "options": [
                        "ro",
                        "rprivate",
                        "nosuid",
                        "nodev",
                        "rbind"
                    ]
                },
                {
                    "destination": "/sys/fs/cgroup",
                    "type": "cgroup",
                    "options": [
                        "rprivate",
                        "nosuid",
                        "noexec",
                        "nodev",
                        "relatime",
                        "ro"
                    ]
                },
                {
                    "destination": "/ws/glrepo/glagent",
                    "type": "bind",
                    "options": [
                        "ro",
                        "rprivate",
                        "rbind"
                    ]
                },
                {
                    "destination": "/ws/.ploinky/deps/store/objects/731426d0-ce45-49d8-b17b-5c9e81bc8277/payload/node_modules",
                    "type": "bind",
                    "options": [
                        "ro",
                        "rprivate",
                        "rbind"
                    ]
                }
            ]
        },
        "info": {
            "version": {
                "Version": "5.8.2"
            },
            "host": {
                "ociRuntime": {
                    "name": "crun",
                    "version": "crun version 1.27.1"
                }
            }
        }
    }
};

export const GL_PLATFORMS = Object.freeze(Object.keys(GL_FIXTURES));

/** Fresh deep copies of one platform's inspect record, OCI spec and `podman info` answer. */
export function glObservation(platform) {
    const fixture = structuredClone(GL_FIXTURES[platform]);
    return { inspect: fixture.inspect, spec: fixture.spec, info: fixture.info };
}

/** Engine-version reader returning what `readPodmanVersions` would parse from the fixture's info. */
export function glVersions(info) {
    return () => ({ podman: info.version.Version, ociRuntimeName: info.host.ociRuntime.name,
        ociRuntimeVersion: /^crun version (\S+)$/.exec(info.host.ociRuntime.version)[1] });
}

/**
 * Injected dependencies for `collectPodmanOciEvidence`: the spec is served
 * only for the path inspect names, and re-inspect returns `inspect` again.
 */
export function glCollectorDeps({ inspect, spec, info }, overrides = {}) {
    return {
        readFile: (file) => (file === inspect.OCIConfigPath ? JSON.stringify(spec) : null),
        readVersions: glVersions(info),
        reinspect: () => structuredClone(inspect),
        ...overrides,
    };
}
