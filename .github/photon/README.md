# photon.jsonc checker

`photon.jsonc` at the root of this repository tells Photon what this template
needs: its channel, how messages reach it, which Photon values to write into
its environment and under which names, what the person deploying fills in, and
where it can run. Photon reads it to build the setup flow and to deploy.

This directory holds a copy of the spec version 1 schema and the reference
checker, which the `photon.jsonc` workflow runs on every change. They will be
replaced by the `@photon-ai/template` package once it ships.

```sh
npm ci --prefix .github/photon/tools
node .github/photon/tools/check.mjs photon.jsonc
```

Add `--normalized` to see the file as Photon reads it, with every default
filled in.
