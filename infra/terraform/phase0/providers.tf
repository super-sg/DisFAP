# ---------------------------------------------------------------------------
# phase0 :: providers.tf
# ---------------------------------------------------------------------------

provider "aws" {
  region = var.aws_region

  # Stamp ownership + cost-allocation tags onto every resource created by this
  # config, including ones the module doesn't tag explicitly.
  default_tags {
    tags = {
      "dfap:project" = "disfap"
      "dfap:phase"   = "phase0"
      "dfap:managed" = "true"
    }
  }
}
