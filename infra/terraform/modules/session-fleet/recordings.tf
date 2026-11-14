# ---------------------------------------------------------------------------
# session-fleet :: recordings.tf
#
# Tamper-evident session-recording store. A recording is legal/audit evidence
# ("what did the contractor do?"), so the bucket is built to be write-once:
#   * Object Lock in COMPLIANCE mode — once written, an object version cannot be
#     deleted or overwritten by ANYONE (including the account root) until its
#     retention expires. This is the whole point; GOVERNANCE mode would let a
#     privileged user erase evidence.
#   * Versioning ON — a hard requirement for Object Lock.
#   * SSE-KMS with a dedicated CMK — encrypted at rest under a key we control.
#   * Public access fully blocked + TLS-only + KMS-only bucket policy.
# ---------------------------------------------------------------------------

# --- Recordings CMK ---------------------------------------------------------
resource "aws_kms_key" "recordings" {
  description             = "${var.name_prefix} session-recording encryption CMK"
  deletion_window_in_days = 30
  enable_key_rotation     = true

  tags = merge(local.common_tags, {
    Name = "${var.name_prefix}-recordings-cmk"
  })
}

resource "aws_kms_alias" "recordings" {
  name          = "alias/${var.name_prefix}-recordings"
  target_key_id = aws_kms_key.recordings.key_id
}

# --- Bucket -----------------------------------------------------------------
# object_lock_enabled MUST be set at creation; it cannot be toggled later.
resource "aws_s3_bucket" "recordings" {
  bucket              = "${var.name_prefix}-recordings-${local.account_id}"
  object_lock_enabled = true
  force_destroy       = false # never auto-empty a compliance evidence store

  tags = merge(local.common_tags, {
    Name        = "${var.name_prefix}-recordings"
    "dfap:role" = "recordings"
  })
}

resource "aws_s3_bucket_versioning" "recordings" {
  bucket = aws_s3_bucket.recordings.id
  versioning_configuration {
    status = "Enabled" # required for Object Lock
  }
}

resource "aws_s3_bucket_object_lock_configuration" "recordings" {
  bucket = aws_s3_bucket.recordings.id

  rule {
    default_retention {
      mode = "COMPLIANCE" # immutable — not even root can shorten/delete
      days = var.recording_retention_days
    }
  }

  # Object Lock config depends on versioning already being enabled.
  depends_on = [aws_s3_bucket_versioning.recordings]
}

resource "aws_s3_bucket_server_side_encryption_configuration" "recordings" {
  bucket = aws_s3_bucket.recordings.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.recordings.arn
    }
    bucket_key_enabled = true # cut KMS request cost on high-volume writes
  }
}

resource "aws_s3_bucket_public_access_block" "recordings" {
  bucket                  = aws_s3_bucket.recordings.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# --- Bucket policy: TLS-only + refuse unencrypted / wrong-key puts ----------
data "aws_iam_policy_document" "recordings" {
  # Deny any request not over TLS.
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.recordings.arn, "${aws_s3_bucket.recordings.arn}/*"]
    principals {
      type        = "AWS"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  # Refuse any PutObject not encrypted with our CMK.
  statement {
    sid       = "DenyWrongKmsKey"
    effect    = "Deny"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.recordings.arn}/*"]
    principals {
      type        = "AWS"
      identifiers = ["*"]
    }
    condition {
      test     = "StringNotEquals"
      variable = "s3:x-amz-server-side-encryption-aws-kms-key-id"
      values   = [aws_kms_key.recordings.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "recordings" {
  bucket = aws_s3_bucket.recordings.id
  policy = data.aws_iam_policy_document.recordings.json

  # Public access block must exist first or S3 may reject the policy put.
  depends_on = [aws_s3_bucket_public_access_block.recordings]
}
