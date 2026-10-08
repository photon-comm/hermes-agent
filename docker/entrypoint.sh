#!/bin/sh
# shellcheck shell=sh
#
# Entrypoint for the Hermes Agent on iMessage template.
#
# The base image is the official Hermes Agent image. It boots s6-overlay as
# PID 1, prepares the data volume, then runs the container command. This
# script wraps that flow:
#
#   (no arguments)    Check the variables, then hand off to the upstream
#                     entrypoint with "run-gateway" as the container command.
#   configure-hermes  Write the model settings into config.yaml and drop
#                     stale copies of service variables from the volume's
#                     .env. Runs from /etc/cont-init.d before any gateway
#                     starts.
#   run-gateway       Start the Hermes messaging gateway.
#   anything else     Passed to the upstream entrypoint unchanged, for
#                     example `docker run IMAGE hermes photon status`.
#
# Secret values are never printed. Only variable names are.

set -eu

UPSTREAM_ENTRYPOINT=/opt/hermes/docker/entrypoint-dispatch.sh
SELF=/opt/template/entrypoint.sh
HERMES_BIN=/opt/hermes/.venv/bin/hermes
SETUIDGID=/command/s6-setuidgid
# Written by the cont-init hook once configure-hermes succeeds in this boot.
CONFIGURED_MARKER=/run/hermes-template/configured
# Hermes Agent's own default OpenRouter model in the pinned release.
DEFAULT_MODEL=z-ai/glm-5.2

info() { printf '[template] %s\n' "$*"; }
fail() { printf '[template] %s\n' "$*" >&2; }

# True when s6-overlay is PID 1. Mirrors Hermes's own check.
s6_running() {
    [ "$(cat /proc/1/comm 2>/dev/null || true)" = "s6-svscan" ] && [ -d /run/s6/basedir ]
}

check_variables() {
    ok=true

    missing=""
    for name in PHOTON_PROJECT_ID PHOTON_PROJECT_SECRET OPENROUTER_API_KEY; do
        eval "value=\${$name:-}"
        [ -n "$value" ] || missing="$missing $name"
    done
    if [ -n "$missing" ]; then
        ok=false
        fail "Missing required variables:$missing"
        for name in $missing; do
            case "$name" in
                PHOTON_PROJECT_ID)
                    fail "  PHOTON_PROJECT_ID: your Photon project id. Copy it from your project in the Photon dashboard, https://app.photon.codes" ;;
                PHOTON_PROJECT_SECRET)
                    fail "  PHOTON_PROJECT_SECRET: the secret (API key) for that project, from the same place." ;;
                OPENROUTER_API_KEY)
                    fail "  OPENROUTER_API_KEY: create a key at https://openrouter.ai/settings/keys" ;;
            esac
        done
    fi

    if [ -n "${PHOTON_ALLOWED_USERS:-}" ]; then
        position=0
        old_ifs=$IFS
        IFS=,
        set -f
        for entry in $PHOTON_ALLOWED_USERS; do
            position=$((position + 1))
            entry=$(printf '%s' "$entry" | tr -d ' \t')
            [ -n "$entry" ] || continue
            if ! printf '%s\n' "$entry" | grep -Eq '^\+[1-9][0-9]{6,14}$'; then
                ok=false
                fail "PHOTON_ALLOWED_USERS entry $position is not a phone number in E.164 format, like +15551234567."
            fi
        done
        set +f
        IFS=$old_ifs
    fi

    if [ -n "${PHOTON_SIDECAR_PORT:-}" ]; then
        case "$PHOTON_SIDECAR_PORT" in
            *[!0-9]*) port_ok=false ;;
            *) port_ok=true ;;
        esac
        if [ "$port_ok" = false ] || [ "$PHOTON_SIDECAR_PORT" -lt 1 ] || [ "$PHOTON_SIDECAR_PORT" -gt 65535 ]; then
            ok=false
            fail "PHOTON_SIDECAR_PORT must be a port number between 1 and 65535."
        fi
    fi

    case "${HERMES_MODEL:-}" in
        *[[:space:]]*)
            ok=false
            fail "HERMES_MODEL must be an OpenRouter model id with no spaces, like $DEFAULT_MODEL." ;;
    esac

    [ "$ok" = true ]
}

# Values in $HERMES_HOME/.env override the process environment in Hermes.
# Remove any key that is also set as a service variable, so the service
# variables always win. Prints the names it removed, never the values.
drop_shadowed_dotenv_keys() {
    env_file="$HERMES_HOME/.env"
    [ -f "$env_file" ] || return 0
    tmp="$env_file.template-tmp"
    : > "$tmp"
    removed=$(awk -v out="$tmp" '
        {
            line = $0
            sub(/^[ \t]*export[ \t]+/, "", line)
            if (match(line, /^[A-Za-z_][A-Za-z0-9_]*[ \t]*=/)) {
                key = substr(line, 1, RLENGTH)
                sub(/[ \t]*=$/, "", key)
                if ((key in ENVIRON) && ENVIRON[key] != "") {
                    if (!(key in seen)) { seen[key] = 1; names = names " " key }
                    next
                }
            }
            print > out
        }
        END { close(out); printf "%s", names }
    ' "$env_file")
    if [ -n "$removed" ]; then
        chmod 600 "$tmp"
        mv "$tmp" "$env_file"
        info "Removed from $env_file so the service variables apply:$removed"
    else
        rm -f "$tmp"
    fi
}

set_config() {
    if ! output=$("$HERMES_BIN" config set "$1" "$2" 2>&1); then
        fail "Could not set $1 in $HERMES_HOME/config.yaml:"
        printf '%s\n' "$output" >&2
        return 1
    fi
}

configure_hermes() {
    if [ "$(id -u)" = 0 ]; then
        # Hermes state belongs to the hermes user. Run this step as that user.
        HOME=/opt/data "$SETUIDGID" hermes "$SELF" configure-hermes
        return
    fi
    export HOME=/opt/data
    HERMES_HOME=${HERMES_HOME:-/opt/data}
    export HERMES_HOME
    cd "$HERMES_HOME"

    drop_shadowed_dotenv_keys

    model=${HERMES_MODEL:-$DEFAULT_MODEL}
    set_config model.provider openrouter
    set_config model.default "$model"
    info "Model: $model through OpenRouter."
}

run_gateway() {
    # Under s6 the cont-init hook has already configured Hermes for this
    # boot. Without s6 (a platform that keeps PID 1 for itself), do it here.
    if ! s6_running || [ ! -f "$CONFIGURED_MARKER" ]; then
        configure_hermes
    fi

    if [ -n "${PHOTON_ALLOWED_USERS:-}" ]; then
        info "Photon: only the numbers in PHOTON_ALLOWED_USERS can talk to the agent."
    else
        info "Photon: PHOTON_ALLOWED_USERS is empty, so unknown senders get a pairing code."
    fi

    if s6_running; then
        # s6 supervises the gateway and restarts it if it crashes. This
        # process stays alive as the container's heartbeat. Gateway logs go
        # to stdout and to $HERMES_HOME/logs/gateways/default/current.
        info "Starting the Hermes gateway under s6 supervision."
        exec hermes gateway run
    fi
    # No s6: the gateway is the main process. A restart requested from chat
    # exits with status 75 so the platform's restart policy brings it back.
    info "Starting the Hermes gateway in the foreground."
    exec hermes gateway run --external-supervisor
}

case "${1:-}" in
    configure-hermes)
        configure_hermes
        ;;
    run-gateway)
        run_gateway
        ;;
    "")
        if ! check_variables; then
            fail "Set the variables above and deploy again. See README.md for where each one comes from."
            exit 1
        fi
        info "Variables look good. Starting Hermes Agent."
        exec "$UPSTREAM_ENTRYPOINT" "$SELF" run-gateway
        ;;
    *)
        exec "$UPSTREAM_ENTRYPOINT" "$@"
        ;;
esac
