#!/bin/sh
set -u
: "${TELEMETRY_PROBE_ENTRY:?}"
: "${TELEMETRY_PROBE_CONFIG:?}"
: "${TELEMETRY_PROBE_METRICS:?}"
probe_temp="${TELEMETRY_PROBE_METRICS}.tmp.$$"
trap 'rm -f "$probe_temp"' EXIT HUP INT TERM
probe_status=0
node "$TELEMETRY_PROBE_ENTRY" "$TELEMETRY_PROBE_CONFIG" > "$probe_temp" || probe_status=$?
if [ ! -s "$probe_temp" ]; then
  printf 'telemetry_probe_success 0\ntelemetry_probe_duration_seconds 0\n' > "$probe_temp"
  probe_status=1
fi
mv "$probe_temp" "$TELEMETRY_PROBE_METRICS" || exit 1
exit "$probe_status"
