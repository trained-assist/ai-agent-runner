# Provisioning an isolated GHA gateway credential

Each Runner API sandbox gets a distinct key for its GHA gateway client. The matching value
is installed in three places: a named client secret on the GHA gateway, `GHA_WORKER_TOKEN`
on that Runner API Worker, and a sandbox-specific GitHub Actions environment secret. For
sandbox3, the names are `WORKER_CLIENT_TOKEN_SANDBOX3_AGENT_API`, `GHA_WORKER_TOKEN`, and
`GHA_WORKER_TOKEN_SANDBOX3_AGENT_API` respectively.

After the gateway client-credential support and Runner capacity-cutover changes have been
deployed to their sandbox environments, run from this repository:

```sh
GHA_GATEWAY_REPO_DIR=/path/to/opencode-gha-runner \
  node scripts/provision-gha-client-credential.mjs --client-id sandbox3_agent_api \
  --gateway-env sandbox --runner-config wrangler.sandbox3.jsonc --github-env sandbox
```

The operator needs Cloudflare credentials for both sandbox Workers and GitHub Actions
environment-secret write access. The command refuses to overwrite any existing copy. It
generates 32 random bytes, streams the value over stdin to each secret manager, verifies that
the gateway accepts the new Bearer token without creating a run, and never prints the value.
If a later step fails, it removes copies created in this invocation and reports any cleanup
that needs attention. Use a new client ID for an additional sandbox; use a separately reviewed
rotation procedure when a credential already exists.

The canary workflow reads `GHA_WORKER_TOKEN_SANDBOX3_AGENT_API`, while the Runner API reads its
own `GHA_WORKER_TOKEN`. The sandbox3 Runner points to the isolated GHA gateway sandbox. The
production GHA gateway URL and its existing primary token are untouched.
