# =============================================================================
# DisFAP control-plane policy (KV v2 + response wrapping)
# =============================================================================
# Attached to the `disfap-api` AppRole. This is the identity the API process
# authenticates as — the Vault root token is NEVER used by the application.
#
# What it can do, and why each path is needed:
#   secret/data/sessions/*     mint (create/update) a per-session credential and
#                              read it back for verified guest provisioning.
#   secret/metadata/sessions/* delete ALL versions of a session secret when the
#                              session ends (KV v2 revoke = metadata delete).
#   sys/wrapping/wrap          ask Vault to response-wrap the write, so the
#                              plaintext never returns to the API at mint time.
#   sys/wrapping/unwrap        consume the single-use wrap token at connect time
#                              (the broker runs in this process today).
#
# Deliberately absent: any other mount, `sys/*` administration, policy or token
# management, `secret/metadata` listing, and cross-mount reads.
# =============================================================================

path "secret/data/sessions/*" {
  capabilities = ["create", "read", "update"]
}

path "secret/metadata/sessions/*" {
  capabilities = ["read", "delete"]
}

path "sys/wrapping/wrap" {
  capabilities = ["update"]
}

path "sys/wrapping/unwrap" {
  capabilities = ["update"]
}
