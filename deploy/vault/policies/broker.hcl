# =============================================================================
# DisFAP broker policy (split deployment only)
# =============================================================================
# The broker's ONLY Vault operation is consuming a single-use response-wrapped
# token at connect time. It never writes a secret, never reads a KV path
# directly, and never manages tokens.
#
# In the shipped single-host stack the broker runs inside the API process, so
# this policy is not in use yet. Create the role before you split the broker out
# (see docs/security/architecture.md, "Broker trust boundary").
# =============================================================================

path "sys/wrapping/unwrap" {
  capabilities = ["update"]
}
