# =============================================================================
# Vault server config — DisFAP Phase-0
# =============================================================================
# !!!!!!!!!!!!!!!!!!!!!!!!!!!!!  NOT PRODUCTION-GRADE  !!!!!!!!!!!!!!!!!!!!!!!!!!
#
# This is a SINGLE-NODE Vault on FILE storage with a plaintext listener,
# suitable ONLY for the Phase-0 single-t4g.small footprint. It exists so the
# broker/api can exercise the real read-once, response-wrapped credential path
# against a real Vault API — not against a fake.
#
# What makes this UNSAFE for production, and what production MUST do instead:
#
#   * storage "file"        -> integrated storage `raft` on 3+ nodes (HA, no
#                              single disk = single point of total data loss).
#   * manual unseal         -> `seal "awskms"` auto-unseal so no human holds
#                              unseal keys and restarts don't need a human.
#   * tls_disable = 1       -> a TLS listener with a real cert. Here the
#                              listener is only reachable over the private,
#                              `internal: true` Docker network (no host, no
#                              internet), so plaintext is contained to that
#                              segment — but production terminates TLS at Vault.
#   * disable_mlock = true  -> mlock enabled (secrets never swap to disk).
#
# After first `docker compose up`, Vault boots SEALED and UNINITIALISED. See
# the README section "Initialise & unseal Vault (one time)".
# =============================================================================

storage "file" {
  path = "/vault/data"
}

listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = 1
}

# Advertised address other cluster members / clients use. In Phase-0 the only
# clients are api/broker on the internal network, which reach us as `vault`.
api_addr = "http://vault:8200"

# Phase-0: containers often can't mlock without extra host tuning; disabling it
# keeps the single-node box booting cleanly. Production sets this to false and
# relies on the IPC_LOCK capability granted in docker-compose.yml.
disable_mlock = true

ui = true
