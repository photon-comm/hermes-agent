#!/command/with-contenv sh
# shellcheck shell=sh
#
# Installed as /etc/cont-init.d/016-hermes-template. s6-overlay runs it as
# root after the upstream setup hook (01-hermes-setup) has prepared the data
# volume, and before 02-reconcile-profiles can start a gateway that was
# running before the last restart. So the gateway always starts with the
# model settings and variables of this deploy.

marker_dir=/run/hermes-template
rm -f "$marker_dir/configured"

if /opt/template/entrypoint.sh configure-hermes; then
    mkdir -p "$marker_dir"
    touch "$marker_dir/configured"
else
    echo "[template] Configuring Hermes failed. The gateway start will try again and stop the container if it fails." >&2
fi

# Never fail the boot from here. run-gateway retries and exits on error.
exit 0
