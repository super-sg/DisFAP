# ============================================================================
# Prod Environment — Backend Configuration
# ============================================================================

terraform {
  backend "s3" {
    bucket         = "software-sharing-terraform-state"
    key            = "prod/vm-layer/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "software-sharing-terraform-locks"
  }
}
