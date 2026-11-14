#!/bin/sh
# =============================================================================
# DisFAP — one-time Vault bootstrap (Phase-0 single host)
# =============================================================================
# Run AFTER `vault operator init` and `vault operator unseal`. It must be run
# with the INITIAL ROOT TOKEN, exactly once (or again after a policy change):
#
#   cd deploy
#   make vault-bootstrap
#
# The root token is read from the terminal, never from `.env`, never from an
# environment variable (a root token in `docker inspect` or a crash dump is a
# full compromise). The application receives only the AppRole credentials this
# script prints at the end.
#
# It creates:
#   - policy `disfap-api`    (KV sessions/* + wrapping, see policies/api.hcl)
#   - policy `disfap-broker` (unwrap only, reserved for the split deployment)
#   - AppRole `disfap-api`:  token_ttl=20m, token_max_ttl=1h, no default policy
#
# Idempotent: re-running rotates the AppRole secret_id.
# =============================================================================
set -eu

: "${VAULT_ADDR:?VAULT_ADDR is not set (run inside the vault container / compose)}"

BOOTSTRAP_DIR="${BOOTSTRAP_DIR:-/vault/bootstrap}"

printf 'Vault root token (input hidden): '
# -r: no backslash escaping; -s: no echo.
read -rs ROOT_TOKEN
printf '\n'
if [ -z "${ROOT_TOKEN:-}" ]; then
  echo 'error: empty token' >&2
  exit 1
fi
export VAULT_TOKEN="$ROOT_TOKEN"

# Prove the token works before changing anything.
if ! vault token lookup >/dev/null 2>&1; then
  echo 'error: the supplied token is not valid for this Vault' >&2
  exit 1
fi

echo '==> writing policies'
vault policy write disfap-api "${BOOTSTRAP_DIR}/policies/api.hcl" >/dev/null
vault policy write disfap-broker "${BOOTSTRAP_DIR}/policies/broker.hcl" >/dev/null

echo '==> enabling approle auth method'
if vault auth list -format=json | grep -q '"approle/"'; then
  echo '    already enabled'
else
  vault auth enable approle >/dev/null
fi

echo '==> configuring AppRole roles'
vault write auth/approle/role/disfap-api \
  token_policies=disfap-api \
  token_ttl=20m \
  token_max_ttl=1h \
  token_no_default_policy=true \
  secret_id_ttl=0 \
  secret_id_num_uses=0 \
  bind_secret_id=true >/dev/null

vault write auth/approle/role/disfap-broker \
  token_policies=disfap-broker \
  token_ttl=20m \
  token_max_ttl=1h \
  token_no_default_policy=true \
  secret_id_ttl=0 \
  secret_id_num_uses=0 \
  bind_secret_id=true >/dev/null

ROLE_ID=$(vault read -field=role_id auth/approle/role/disfap-api/role-id)
SECRET_ID=$(vault write -f -field=secret_id auth/approle/role/disfap-api/secret-id)

unset VAULT_TOKEN ROOT_TOKEN

cat <<EOF

==> done. Put these in deploy/.env (they are scoped to disfap-api):

VAULT_ADDR=http://vault:8200
VAULT_APPROLE_ROLE_ID=${ROLE_ID}
VAULT_APPROLE_SECRET_ID=${SECRET_ID}

Remove any VAULT_TOKEN= line from deploy/.env: the application must not hold a
root or administrator token. The secret_id above is a credential — treat it like
a password, and keep deploy/.env out of version control (it already is).
Rotate it with:  vault write -f auth/approle/role/disfap-api/secret-id
EOF
