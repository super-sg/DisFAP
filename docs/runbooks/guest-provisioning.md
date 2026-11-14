# Runbook — guest credential provisioning (Linux session VMs)

> **Status: production guest provisioning is NOT enabled and cannot be enabled
> yet.** The control plane verifies an AWS-signed EC2 instance identity document,
> enforces the server-side instance→session binding, and delivers the session
> credential once; the guest unit that consumes it (fail-closed) is built and
> shipped in the image. What is missing is **validation against real AWS**: the
> regional instance-identity **public certificates** and a live IMDS document.
> `DFAP_GUEST_PROVISIONING=instance-identity` is **refused in production** by
> `config.ts` until that validation is done. Do not claim zero-exposure guest
> login works until every step here has been run against your account.

This is the missing trust relationship that audit finding **C3** named: before
this work, nothing on the VM could obtain or materialize the session credential,
and the previous `userData` sealed-blob design required a decryption key in the
guest — which, if baked into a reusable AMI, is a shared secret across every
instance of that image.

---

## 0. The design in one paragraph

At first boot `dfap-provision.service` reads this instance's **AWS-signed
instance identity document** (`/latest/dynamic/instance-identity/document` +
`/signature`, IMDSv2), along with `instance-id`, `ami-id` and the
`dfap:session_id` instance tag, and POSTs the signed identity to the control
plane's `POST /internal/guest/provision`. The control plane:

1. verifies the RSA-SHA256 signature with the region's AWS public key;
2. joins the **verified** instance id → `pool_instances.cloud_instance_id` →
   the session this control plane launched it for;
3. checks the AMI/region/state/TTL binding;
4. reads the session credential from Vault (the same path the broker uses) and
   returns a strictly-validated package **once**.

The guest re-checks the package against its **own** instance id, image id and
session tag, creates a least-privilege `tsusers` account, and only then lets
xrdp/xrdp-sesman start. Any failure ⇒ the unit exits non-zero and the xrdp gate
drop-in keeps the listener down.

Why this is defensible: IMDS is link-local and only ever serves the instance's
**own** document, so instance A cannot obtain a valid document naming instance B
(and cannot forge one without AWS's private key). Authorization is server-side
data — the instance only *presents evidence*, it never names its own session.

---

## 1. What you need before starting

| Thing | Where it goes | Notes |
|---|---|---|
| AWS account id(s) | `accountId` inside the signed document | Binds the credential to your account. Verify it matches `pool_instances`. |
| AWS region | The instance's region | Selects the instance-identity public key. |
| AWS region instance-identity **public certificate** | `DFAP_GUEST_IDENTITY_CERT_FILE` (recommended) or `_PEM` | Bundle it in the deployment; **never** fetch it from the request path. |
| A built, hardened session AMI | Launch template image | Must be the AMI the control plane records for the session. |
| A reachable control-plane URL from the guest | `/etc/dfap/provision.env` → `DFAP_CONTROL_PLANE_URL` | The API endpoint; must be reachable through the guest egress policy. |

The public certificate is published by AWS per region (EC2 instance identity
document signing certificates). Pin the one for your region. A multi-region
deployment swaps in a `region → key` map behind the same
`AwsIdentityCertProvider` interface (`src/guest/aws-cert-provider.ts`).

---

## 2. Validate the trust root against real AWS (MANDATORY before enabling)

Do all of this on a **throwaway** instance of the target AMI in the target
region. Do NOT enable production provisioning until each check passes.

1. **Document fetched and verified.** From the instance:
   ```sh
   TOKEN=$(curl -fsS -X PUT "http://169.254.169.254/latest/api/token" \
            -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')
   curl -fsS -H "X-aws-ec2-metadata-token: $TOKEN" \
        http://169.254.169.254/latest/dynamic/instance-identity/document
   ```
   Confirm the control plane's `verifier.verify()` returns the SAME
   `instanceId`/`imageId`/`region`/`accountId`.
2. **Wrong-key rejected.** Re-sign the document with a local key and confirm the
   verifier rejects it (the test suite already does this with a fixture key).
3. **Binding enforced.** Confirm `pool_instances` has a row with this
   `cloud_instance_id` and a `claimed_by_session_id`, and that a session-less
   instance receives **403**.
4. **Image binding.** Confirm the session's expected image equals the AMI the
   instance reports. (Phase-0 uses a single configured image; per-instance image
   persistence is a documented follow-up — see §5.)
5. **Cross-instance isolation.** With two claimed instances A and B, confirm
   A's document yields only A's session and there is **no** request shape that
   returns B's credential.
6. **Fail-closed.** Stop the control plane (or block egress) and confirm on the
   guest that `dfap-provision.service` fails and `systemctl status xrdp` shows
   it NOT running (the gate drop-in).

---

## 3. Control-plane configuration (non-production first)

```sh
DFAP_GUEST_PROVISIONING=instance-identity
DFAP_GUEST_IDENTITY_CERT_FILE=/etc/dfap/aws-instance-identity.pem   # bundled, pinned
DFAP_GUEST_PROVISIONING_TTL_S=900
DFAP_GUEST_PROVISIONING_MAX_DELIVERIES=10
```

Attempting this with `DFAP_ENV=production` **fails config load** by design.

## 4. Guest (image) configuration

`dfap-provision.service` reads `/etc/dfap/provision.env`:

```sh
DFAP_PROVISIONING_ENABLED=1
DFAP_CONTROL_PLANE_URL=https://api.example.com
DFAP_SESSION_GROUP=tsusers
```

While `DFAP_PROVISIONING_ENABLED` is not `1` (the image default), provisioning
fails closed and the RDP listener stays down. The instance also needs
`dfap:session_id` as an instance tag — the pool manager/launch template stamps
it (the guest refuses without it).

---

## 5. Known gaps / follow-ups (honest list)

- **Real AWS validation not done.** The verifier is tested against generated
  keypairs only. Until §2 is run, production stays refused.
- **Per-instance image persistence.** `pool_instances` has no `image_id`; the
  expected image comes from configuration (single image in Phase-0). A
  multi-image fleet should persist the launched AMI per instance.
- **Multi-region key map.** `StaticAwsCertProvider` holds one key; extend for
  multi-region.
- **Delivery is request/response.** An SSM `SendCommand` push to a specific
  instance id is an accepted alternative behind the same
  `GuestCredentialSource`/delivery seam; it was not chosen because the pull path
  needs no command-history surface and gives the guest a fail-closed boot gate.
- **`proxy` / IMDS hop.** The guest must reach IMDS and the control plane; keep
  IMDSv2 required in the launch template (`HttpTokens=required`) and the
  `HttpPutResponseHopLimit` at 1 so the document cannot be fetched from a
  container outside the instance.
