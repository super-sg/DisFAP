# ADR-001: Warm pool over Terraform-per-session

**Status:** accepted · 2026-07-22

## Context

The original DisFAP design provisions an ephemeral VM per session with a `terraform apply` at session start ("JIT via Terraform").

## Problem

Measured cost of a per-session apply: 45–110 s for Linux, 85–260 s for Windows (provider cold start + state lock + refresh + `RunInstances` + boot to RDP-ready). Users abandon interactive actions well before 30 s. Beyond latency: applies serialize on state locks, one state file per session sprawls into thousands of objects, and a partial apply leaves billable resources with no state record — unreconcilable orphans.

## Decision

Terraform owns the **fleet**: VPC, subnets, security-group templates, IAM, and **EC2 launch templates** (one per workspace template, version-pinned, PR-reviewed). Individual session VMs are created by the pool manager calling `RunInstances` against those launch templates, and claimed from a three-tier pool:

| Tier | State | Time to session | Idle cost |
|---|---|---|---|
| Hot | Running, RDP up | 2–5 s | full rate |
| Warm | EBS-backed stopped | 35–60 s | ~7% (EBS only) |
| Cold | None — launch from AMI | 45–110 s | $0 |

Claims are race-free via `SELECT … FOR UPDATE SKIP LOCKED`; an empty pool falls through to a cold launch with a progress UI, never a queue.

## Consequences

- The launch template *is* the declarative VM spec — the review/audit benefits of IaC are retained.
- Capacity, latency, and cost become tunable pool parameters instead of Terraform behavior.
- Phase 0 runs with no pool at all (cold-launch every session) — the pool is an optimization layered on later, not a prerequisite.
- Instances are **never reused across sessions** (see ADR-004), so pool churn and the 1-minute EC2 billing minimum are a known COGS line.
