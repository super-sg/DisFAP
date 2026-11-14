# ---------------------------------------------------------------------------
# session-fleet :: security.tf
#
# Two security groups define the entire tenant-isolation model at the network
# layer:
#
#   1. guacd_host  — the broker/guacd box. It is the ONLY thing allowed to open
#                    an RDP connection into a session VM.
#   2. session_template — the canonical per-session SG. The pool manager CLONES
#                    this rule set into a fresh, uniquely-named SG for every
#                    session at RunInstances time (ADR-004: burn-after-reading —
#                    the SG is created and destroyed with the instance).
#
# TENANT ISOLATION RATIONALE (read before touching any rule below):
#   * A session VM accepts RDP ONLY from the guacd SG, never from a CIDR and
#     never from another session. Two tenants' VMs can share a subnet and STILL
#     cannot see each other, because neither is a member of the SG the other
#     trusts.
#   * There is deliberately NO self-referencing rule ("allow from this same SG").
#     A self rule is the classic lateral-movement hole: it would let every
#     instance carrying the session SG talk to every other one. Because each
#     session gets its OWN cloned SG this is moot for the clones, but we must
#     never add a self rule to the template either, or the clone inherits it.
#   * Egress is default-deny. A pixel-only workspace originates no outbound
#     traffic; anything it needs is an explicit, audited allowlist entry.
#
# IMPLEMENTATION NOTE — why separate rule resources:
#   guacd_host and session_template reference EACH OTHER (guacd egresses to the
#   session SG; the session SG ingresses from the guacd SG). Expressed as inline
#   ingress/egress blocks that would be a Terraform dependency CYCLE. So both SGs
#   are declared rule-less (which, for aws_security_group, revokes AWS's implicit
#   allow-all egress => default-deny) and every rule is a standalone
#   aws_vpc_security_group_(ingress|egress)_rule that references SG IDs only.
# ---------------------------------------------------------------------------

# --- guacd / broker host SG -------------------------------------------------
# Declared rule-less on purpose: no inline egress => default-deny egress.
resource "aws_security_group" "guacd_host" {
  name        = "${var.name_prefix}-guacd-host"
  description = "Broker + guacd host. Terminates client WSS, opens RDP to session VMs."
  vpc_id      = aws_vpc.this.id

  tags = merge(local.common_tags, {
    Name        = "${var.name_prefix}-guacd-host"
    "dfap:role" = "guacd-host"
  })
}

# Ingress: the broker's WSS listener, reachable only from within the VPC (the
# public control host fronts it). Raw guacd (4822) is never exposed at all.
resource "aws_vpc_security_group_ingress_rule" "guacd_wss" {
  security_group_id = aws_security_group.guacd_host.id
  description       = "Broker WSS (/tunnel) from within the VPC"
  ip_protocol       = "tcp"
  from_port         = 8443
  to_port           = 8443
  cidr_ipv4         = var.vpc_cidr
}

# Egress: RDP out to session VMs (by SG membership, not CIDR).
resource "aws_vpc_security_group_egress_rule" "guacd_to_session_rdp" {
  security_group_id            = aws_security_group.guacd_host.id
  description                  = "RDP out to session VMs"
  ip_protocol                  = "tcp"
  from_port                    = var.rdp_port
  to_port                      = var.rdp_port
  referenced_security_group_id = aws_security_group.session_template.id
}

# Egress: HTTPS to the VPC interface endpoints (SSM/KMS/ECR/Logs/S3).
resource "aws_vpc_security_group_egress_rule" "guacd_to_endpoints" {
  security_group_id = aws_security_group.guacd_host.id
  description       = "HTTPS to VPC endpoints"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = var.vpc_cidr
}

# --- Per-session SG TEMPLATE ------------------------------------------------
# The blueprint the pool manager clones per session (CreateSecurityGroup +
# Authorize*). Materialized as a real, reviewed resource. Declared rule-less =>
# default-deny egress; the only rules are the ingress from guacd and any
# allowlisted egress below.
resource "aws_security_group" "session_template" {
  name        = "${var.name_prefix}-session-template"
  description = "TEMPLATE for per-session VM SGs. Ingress: RDP from guacd only. Egress: default-deny + allowlist. NEVER add a self rule."
  vpc_id      = aws_vpc.this.id

  tags = merge(local.common_tags, {
    Name        = "${var.name_prefix}-session-template"
    "dfap:role" = "session-sg-template"
  })
}

# INGRESS — RDP from the guacd host SG ONLY. Source is a security-group
# reference, so membership (not IP) is the trust boundary. NO self rule.
resource "aws_vpc_security_group_ingress_rule" "session_rdp_from_guacd" {
  security_group_id            = aws_security_group.session_template.id
  description                  = "RDP from guacd host only"
  ip_protocol                  = "tcp"
  from_port                    = var.rdp_port
  to_port                      = var.rdp_port
  referenced_security_group_id = aws_security_group.guacd_host.id
}

# EGRESS — default-deny by absence; the (default-empty) allowlist adds explicit,
# audited destinations only. No entry => the session VM makes NO outbound
# connections at all, which is the correct pixel-only posture.
resource "aws_vpc_security_group_egress_rule" "session_allowlist" {
  for_each = { for idx, r in var.session_egress_allowlist : tostring(idx) => r }

  security_group_id = aws_security_group.session_template.id
  description       = each.value.description
  ip_protocol       = each.value.protocol
  from_port         = each.value.from_port
  to_port           = each.value.to_port
  cidr_ipv4         = each.value.cidr
}
