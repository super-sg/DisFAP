# ---------------------------------------------------------------------------
# session-fleet :: versions.tf
#
# Provider pinning for the reusable fleet module. Callers (e.g. phase0/) inherit
# these constraints. We pin the AWS provider to the 5.x line: every resource in
# this module (VPC interface endpoints, S3 Object Lock, budgets, IMDSv2 metadata
# options) is validated against that major and its argument surface is stable
# there. Bumping to 6.x is a deliberate, reviewed change — never implicit.
# ---------------------------------------------------------------------------

terraform {
  # 1.5 is the floor for `check` blocks and stable `moved`/import semantics we
  # rely on across the fleet. It is intentionally conservative.
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}
