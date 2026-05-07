# ============================================================================
# Dev Environment — Backend Configuration
# Uses S3 + DynamoDB for remote state with locking.
# ============================================================================

terraform {
  backend "s3" {
    bucket         = "software-sharing-terraform-state"
    key            = "dev/vm-layer/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "software-sharing-terraform-locks"
  }
}
