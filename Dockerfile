# Hermes Agent on iMessage through Photon.
#
# Base: the official Hermes Agent image, pinned to release v2026.9.24
# (Hermes Agent v0.21.5, upstream commit f97608f178d1ffeca59860195ab7da295f7c8e5f)
# by tag and multi-arch digest. It already contains:
#   - Hermes Agent and its Python environment under /opt/hermes (read-only)
#   - Node.js 26 for the Photon sidecar
#   - the Photon sidecar's npm dependencies (spectrum-ts), installed at build time
#   - s6-overlay, which runs as PID 1, prepares the /opt/data volume and
#     supervises the gateway
# To upgrade, change the tag and the digest together.
FROM nousresearch/hermes-agent:v2026.9.24@sha256:fca358f12efd65bfaaca05884166f15c0e2788375ca30d77061ac1ebc96452b7

# The image starts as root so s6-overlay can fix volume ownership. Hermes
# itself runs as the non-root "hermes" user (uid 10000).
# hadolint ignore=DL3002
USER root

# Reinstall the Photon sidecar's npm dependencies from its lockfile at build
# time. The upstream image has them, but its node_modules is older than the
# lockfile next to it. Hermes then treats the install as stale, copies the
# sidecar into /opt/data and runs `npm ci` there at runtime, and that copy is
# missing send-format.mjs, so the sidecar crashes on start. A fresh install
# here keeps the sidecar running from the image with no runtime npm step.
ENV PHOTON_SIDECAR_DIR=/opt/hermes/plugins/platforms/photon/sidecar
RUN set -eu; \
    node --version; \
    npm ci --prefix "$PHOTON_SIDECAR_DIR" --no-audit --no-fund; \
    test -d "$PHOTON_SIDECAR_DIR/node_modules/spectrum-ts"; \
    test "$PHOTON_SIDECAR_DIR/node_modules/.package-lock.json" -nt "$PHOTON_SIDECAR_DIR/package-lock.json"

COPY docker/entrypoint.sh /opt/template/entrypoint.sh
COPY docker/cont-init.sh /etc/cont-init.d/016-hermes-template
RUN chmod 0755 /opt/template/entrypoint.sh /etc/cont-init.d/016-hermes-template

# All Hermes state (config.yaml, .env, sessions, memories, skills, logs)
# lives here. Mount a persistent volume at this path.
ENV HERMES_HOME=/opt/data

ENTRYPOINT ["/opt/template/entrypoint.sh"]
CMD []
