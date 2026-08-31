export function readinessCommands({ readyPrefix, ioPrefix, inputVariable }) {
    return [
        'IFS= read -r phase0_stat < "/proc/$$/stat"',
        'phase0_tail=${phase0_stat##*) }',
        'unset IFS',
        'set -- $phase0_tail',
        'phase0_pgrp=$3',
        'phase0_session=$4',
        'phase0_start=${20}',
        'phase0_uid=',
        "while IFS=: read -r phase0_key phase0_value; do [ \"$phase0_key\" = 'Uid' ] && { set -- $phase0_value; phase0_uid=$1; break; }; done < /proc/$$/status",
        `printf '${readyPrefix}%s|%s|%s|%s|%s\\n' "$$" "$phase0_pgrp" "$phase0_session" "$phase0_uid" "$phase0_start"`,
        `IFS= read -r ${inputVariable}`,
        `printf '${ioPrefix}%s\\n' "$${inputVariable}"`,
    ];
}
