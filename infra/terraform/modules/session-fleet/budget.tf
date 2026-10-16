# ---------------------------------------------------------------------------
# session-fleet :: budget.tf
#
# Account-level cost guardrail — the outermost of the five teardown layers in
# spirit: even if everything else leaks instances, the spend can't silently run
# away. Phase-0 target is $50/mo (brief + architecture). Two notifications:
#   * 80% FORECASTED  — early warning that the month is trending over.
#   * 100% ACTUAL     — you have crossed the line right now.
# Budgets are a global (us-east-1-backed) service; no region wiring needed.
# ---------------------------------------------------------------------------

resource "aws_budgets_budget" "monthly" {
  name         = "${var.name_prefix}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.budget_limit_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  # Early warning: month is forecast to blow the cap.
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.budget_notification_email]
  }

  # Hard signal: actual spend has reached the cap.
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.budget_notification_email]
  }
}
