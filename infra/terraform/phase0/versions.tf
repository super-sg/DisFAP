# ---------------------------------------------------------------------------
# phase0 :: versions.tf
#
# Root config for the cheapest DisFAP footprint: ONE t4g.small "control host"
# running the whole docker-compose stack (web + broker + guacd), plus a single
# instantiation of the session-fleet module in its no-NAT / cold-launch mode.
#
# Providers are pinned to aws ~> 5.x to match the module.
# ---------------------------------------------------------------------------

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # -------------------------------------------------------------------------
  # REMOTE STATE BACKEND (commented example).
  #
  # State contains resource IDs and, for some resources, sensitive material — it
  # is gitignored (see repo .gitignore: *.tfstate). For anything beyond a single
  # laptop, store it remotely with locking. Create the bucket + table ONCE, by
  # hand or a tiny bootstrap config, THEN uncomment and `terraform init
  # -migrate-state`:
  #
  # backend "s3" {
  #   bucket         = "disfap-tfstate-<account_id>"   # versioned, SSE-KMS, private
  #   key            = "phase0/terraform.tfstate"
  #   region         = "us-east-1"
  #   dynamodb_table = "disfap-tflock"                  # PK: LockID (String)
  #   encrypt        = true
  # }
  # -------------------------------------------------------------------------
}
