# Hermes Agent, on iMessage

This template runs [Hermes Agent](https://github.com/NousResearch/hermes-agent), the open-source agent from [Nous Research](https://nousresearch.com), and connects it to iMessage through [Photon](https://photon.codes). You text a phone number, and Hermes texts back.

It uses the Photon platform plugin that ships with Hermes. The plugin holds a long-lived gRPC stream to Photon through a small Node sidecar inside the container, so the service needs no public URL and no open port. Everything is configured from environment variables, and all of Hermes's state lives on one volume at `/opt/data`.

## Set up through the Photon dashboard

1. In the [Photon dashboard](https://app.photon.codes), create a project from the **Hermes Agent** template.
2. Choose a shared or a dedicated iMessage line.
3. Confirm your phone number.
4. Connect your Railway account.
5. Provide your OpenRouter API key as `OPENROUTER_API_KEY`. To use a model other than the default, set `HERMES_MODEL`.

Photon deploys this template to your Railway account with the Photon variables already set. When the deploy finishes, text the iMessage number the dashboard shows you.

## Deploy by hand on Railway

You need the [Railway CLI](https://docs.railway.com/cli) and the values described in [Environment variables](#environment-variables).

```sh
railway login
railway init --name hermes-agent
railway add --service hermes-agent

# Hermes keeps all of its state here.
railway volume add --mount-path /opt/data

railway variable set PHOTON_PROJECT_ID=your-project-id
railway variable set PHOTON_PROJECT_SECRET=your-project-secret
railway variable set PHOTON_ALLOWED_USERS=+15551234567
railway variable set OPENROUTER_API_KEY=your-openrouter-key

railway up
```

Commands on the command line end up in your shell history. To keep secrets out of it, set the variables on the service's Variables tab in the Railway dashboard instead.

The volume must be mounted at `/opt/data`. Add it as shown above, or from the service's settings. Without the volume, Hermes forgets every conversation on each deploy.

Railway builds the `Dockerfile` at the root of the repository; there is no Railway config file to keep in step. Railway's defaults fit this service: one replica, restarted when it exits with an error. Keep it at one replica. Two copies of the gateway on the same Photon project would both answer every message. There is no healthcheck: the gateway has no public HTTP endpoint to check.

To watch it start:

```sh
railway logs
```

If you see `✗ photon failed to connect`, Photon most likely rejected the credentials. Check `PHOTON_PROJECT_ID` and `PHOTON_PROJECT_SECRET`. The full error is in `/opt/data/logs/gateway.log`; open a shell with `railway ssh` and read it, or run `hermes logs --follow`.

## Run locally with Docker

```sh
cp .env.example .env
# Fill in the values in .env.

docker build -t hermes-agent-photon .
docker run --rm --name hermes --env-file .env -v hermes-data:/opt/data hermes-agent-photon
```

`hermes-data` is a named Docker volume. Prefer it to a bind mount on macOS: Hermes's SQLite database can be corrupted on file systems shared with a virtual machine.

To run a Hermes command, use the running container. Starting a second container on the same volume can start a second gateway.

```sh
docker exec -it hermes hermes photon status
```

## Environment variables

| Variable | Required | What it is |
| --- | --- | --- |
| `PHOTON_PROJECT_ID` | Yes | Your Photon project id, from your project in the [Photon dashboard](https://app.photon.codes). |
| `PHOTON_PROJECT_SECRET` | Yes | The secret (API key) for that project, from the same place. |
| `OPENROUTER_API_KEY` | Yes | Your [OpenRouter API key](https://openrouter.ai/settings/keys). OpenRouter charges for the tokens the agent uses. |
| `HERMES_MODEL` | No | OpenRouter model id. Defaults to `z-ai/glm-5.2`, the OpenRouter default of the pinned Hermes release. The model must support tool calling. |
| `PHOTON_ALLOWED_USERS` | No | Phone numbers that may talk to the agent, in E.164 format, separated by commas, like `+15551234567`. When empty, unknown senders get a pairing code. |
| `PHOTON_SIDECAR_PORT` | No | Loopback port for the Photon sidecar inside the container. Defaults to `8789`. |

The container stops at start with a list of what is missing or malformed, and never prints a secret.

Hermes reads other variables too. Every `PHOTON_*` option is in the [Photon plugin docs](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/photon), and the full list is in the [environment variable reference](https://hermes-agent.nousresearch.com/docs/reference/environment-variables).

### Who can talk to the agent

With `PHOTON_ALLOWED_USERS` set, the agent answers those numbers and ignores everyone else. Without it, Hermes falls back to pairing: an unknown sender gets a code, and you approve it from a shell in the container.

```sh
railway ssh
hermes pairing approve photon <CODE>
```

## How it starts

The image is the official `nousresearch/hermes-agent` image with three changes.

1. `docker/entrypoint.sh` checks the variables before anything else runs.
2. A startup hook writes the model settings into `/opt/data/config.yaml`. It also removes any copy of a service variable from `/opt/data/.env`. Hermes lets that file override the environment, and this keeps the values you set on the service in charge.
3. The Photon sidecar's npm dependencies are installed again from their lockfile during the build. The published image's copy looks stale to Hermes, which then tries to rebuild the sidecar at runtime and fails.

After that, the upstream image takes over. It prepares the volume and drops to the non-root `hermes` user. Then it starts `hermes gateway run` under its process supervisor, which restarts the gateway if it crashes. Gateway logs go to the container output and to `/opt/data/logs/gateways/default/current`.

## Hermes version

The Dockerfile pins Hermes Agent v0.21.5, release `v2026.9.24` (upstream commit `f97608f1`), by tag and image digest. To upgrade, change the tag and the digest in the `FROM` line together and rebuild.

## Credits and license

[Hermes Agent](https://github.com/NousResearch/hermes-agent) is made by [Nous Research](https://nousresearch.com) and released under the MIT License. Its documentation is at [hermes-agent.nousresearch.com](https://hermes-agent.nousresearch.com). This template copies no Hermes source files; it builds on the published Hermes Agent image.

The template's own files are released under the MIT License. See [LICENSE](LICENSE).
