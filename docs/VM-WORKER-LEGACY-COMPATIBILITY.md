# VM worker compatibility boundaries

This worker implements the existing Agent API `ExternalWorkerAdapter` contract. It is
an execution target for that API; it is not the Control Plane, Runner HTTP service, or
MCP Host, and it does not establish that the newer CP → Runner → Host flow is fully
independent from `trained-assist-agent`.

The read-only source audit in [architecture issue #174](https://github.com/trained-assist/trained-agent-architecture/issues/174)
found legacy HTTP dependencies in Web and the primary Telegram bot, a pinned core
checkout in Search skill CI, a sibling-default in the runner migration rehearsal, and
an optional documents module path whose deployment value was not resolved. Those are
separate migration tracks. Keep legacy origins and services available until their own
user flows pass acceptance; do not silently route the new profile back to them.

The VM deployment drift workflow checks only `/version`, `/readyz`, worker binding
presence, and equality with the current `main` SHA. It does not inspect transitive
module paths, prove legacy-origin blocking, validate Telegram/Web callbacks, or prove
workspace continuity. Its green result is a VM deployment signal, not migration
acceptance for #174. A yellow warning must be investigated; it is not an automatic
fallback decision.

Before connecting this worker to a new execution profile, record the deployed CP,
Runner, Host and executor revisions separately and run the #174 acceptance checks in a
clean environment with sibling/core access denied. Keep old `AGENT_URL` and web
`AGENT_VERIFY_URL` routes isolated from the new profile. New-profile callbacks must
fail explicitly when unsupported and must never fall back to a legacy upstream.
