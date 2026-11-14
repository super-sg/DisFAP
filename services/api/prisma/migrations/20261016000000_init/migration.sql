-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('owner', 'admin', 'member', 'auditor');

-- CreateEnum
CREATE TYPE "Os" AS ENUM ('linux', 'windows');

-- CreateEnum
CREATE TYPE "ConnectionProtocol" AS ENUM ('rdp', 'vnc', 'dcv');

-- CreateEnum
CREATE TYPE "PoolState" AS ENUM ('provisioning', 'warming', 'warm', 'stopped', 'claimed', 'active', 'draining', 'terminating', 'terminated', 'quarantined');

-- CreateEnum
CREATE TYPE "SessionState" AS ENUM ('requested', 'allocating', 'ready', 'connected', 'idle', 'disconnected', 'terminating', 'ended', 'failed');

-- CreateEnum
CREATE TYPE "EndReason" AS ENUM ('user', 'idle_timeout', 'max_duration', 'admin', 'error', 'spot_interruption', 'orphan_reaped');

-- CreateEnum
CREATE TYPE "LicenseStatus" AS ENUM ('available', 'rented', 'paused');

-- CreateTable
CREATE TABLE "orgs" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orgs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_members" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "Role" NOT NULL,

    CONSTRAINT "org_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_templates" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "os" "Os" NOT NULL,
    "connection_protocol" "ConnectionProtocol" NOT NULL,
    "guac_params" JSONB NOT NULL,
    "idle_timeout_s" INTEGER NOT NULL DEFAULT 900,
    "max_session_s" INTEGER NOT NULL DEFAULT 28800,
    "recording_enabled" BOOLEAN NOT NULL DEFAULT false,
    "gpu" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_images" (
    "id" TEXT NOT NULL,
    "cloud" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "ami_id" TEXT NOT NULL,
    "snapshot_sha256" TEXT NOT NULL,
    "hardening_profile" TEXT NOT NULL,
    "built_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "workspace_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pool_instances" (
    "id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "az" TEXT NOT NULL,
    "cloud_instance_id" TEXT NOT NULL,
    "private_ip" TEXT,
    "state" "PoolState" NOT NULL,
    "claimed_by_session_id" TEXT,
    "security_group_id" TEXT,
    "launched_at" TIMESTAMP(3) NOT NULL,
    "ready_at" TIMESTAMP(3),
    "claimed_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "terminated_at" TIMESTAMP(3),
    "hourly_cost_usd" DECIMAL(10,4) NOT NULL,

    CONSTRAINT "pool_instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "instance_id" TEXT,
    "license_id" TEXT,
    "guacd_node_id" TEXT,
    "state" "SessionState" NOT NULL,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ready_at" TIMESTAMP(3),
    "first_pixel_at" TIMESTAMP(3),
    "connected_at" TIMESTAMP(3),
    "last_input_at" TIMESTAMP(3),
    "disconnected_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "end_reason" "EndReason",
    "billable_seconds" INTEGER,
    "client_ip" TEXT,
    "client_ua" TEXT,
    "vault_cred_path" TEXT,
    "recording_id" TEXT,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_events" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "actor" TEXT,
    "detail" JSONB NOT NULL,

    CONSTRAINT "session_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recordings" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "s3_bucket" TEXT NOT NULL,
    "s3_key" TEXT NOT NULL,
    "bytes" BIGINT NOT NULL,
    "duration_s" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "kms_key_id" TEXT NOT NULL,
    "retention_until" TIMESTAMP(3) NOT NULL,
    "legal_hold" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recordings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "detail" JSONB NOT NULL,
    "prev_hash" TEXT,
    "hash" TEXT NOT NULL,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plans" (
    "id" TEXT NOT NULL,
    "stripe_price_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "included_seat_hours" INTEGER NOT NULL,
    "overage_price_cents" INTEGER NOT NULL,
    "max_concurrent" INTEGER NOT NULL,
    "features" JSONB NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "stripe_customer_id" TEXT NOT NULL,
    "stripe_subscription_id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "seats" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "current_period_start" TIMESTAMP(3) NOT NULL,
    "current_period_end" TIMESTAMP(3) NOT NULL,
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_records" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "billable_seconds" INTEGER NOT NULL,
    "compute_cost_usd" DECIMAL(12,6) NOT NULL,
    "egress_bytes" BIGINT NOT NULL,
    "stripe_meter_event_id" TEXT,
    "reported_at" TIMESTAMP(3),

    CONSTRAINT "usage_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stripe_events" (
    "id" TEXT NOT NULL,
    "stripe_event_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "stripe_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "software_licenses" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "owner_name" TEXT NOT NULL,
    "software_name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "os" "Os" NOT NULL,
    "hourly_rate_usd" DECIMAL(10,2) NOT NULL,
    "status" "LicenseStatus" NOT NULL DEFAULT 'available',
    "current_rentee_id" TEXT,
    "encrypted_credentials" JSONB NOT NULL,
    "key_fingerprint" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "software_licenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "license_rentals" (
    "id" TEXT NOT NULL,
    "license_id" TEXT NOT NULL,
    "rentee_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "hours_requested" INTEGER NOT NULL,
    "total_charged_usd" DECIMAL(12,2) NOT NULL,
    "meter_event_id" TEXT,
    "pair_payload" JSONB,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),

    CONSTRAINT "license_rentals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "org_members_user_id_idx" ON "org_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "org_members_org_id_user_id_key" ON "org_members"("org_id", "user_id");

-- CreateIndex
CREATE INDEX "workspace_templates_org_id_active_idx" ON "workspace_templates"("org_id", "active");

-- CreateIndex
CREATE INDEX "workspace_images_region_cloud_idx" ON "workspace_images"("region", "cloud");

-- CreateIndex
CREATE UNIQUE INDEX "pool_instances_cloud_instance_id_key" ON "pool_instances"("cloud_instance_id");

-- CreateIndex
CREATE INDEX "pool_instances_template_id_state_idx" ON "pool_instances"("template_id", "state");

-- CreateIndex
CREATE INDEX "pool_instances_expires_at_idx" ON "pool_instances"("expires_at");

-- CreateIndex
CREATE INDEX "sessions_org_id_state_idx" ON "sessions"("org_id", "state");

-- CreateIndex
CREATE INDEX "sessions_state_idx" ON "sessions"("state");

-- CreateIndex
CREATE INDEX "sessions_license_id_state_idx" ON "sessions"("license_id", "state");

-- CreateIndex
CREATE INDEX "session_events_session_id_at_idx" ON "session_events"("session_id", "at");

-- CreateIndex
CREATE INDEX "recordings_session_id_idx" ON "recordings"("session_id");

-- CreateIndex
CREATE INDEX "audit_log_org_id_at_idx" ON "audit_log"("org_id", "at");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_org_id_key" ON "subscriptions"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "usage_records_stripe_meter_event_id_key" ON "usage_records"("stripe_meter_event_id");

-- CreateIndex
CREATE INDEX "usage_records_org_id_period_start_idx" ON "usage_records"("org_id", "period_start");

-- CreateIndex
CREATE UNIQUE INDEX "stripe_events_stripe_event_id_key" ON "stripe_events"("stripe_event_id");

-- CreateIndex
CREATE INDEX "software_licenses_status_category_idx" ON "software_licenses"("status", "category");

-- CreateIndex
CREATE INDEX "software_licenses_owner_id_idx" ON "software_licenses"("owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "license_rentals_session_id_key" ON "license_rentals"("session_id");

-- CreateIndex
CREATE UNIQUE INDEX "license_rentals_meter_event_id_key" ON "license_rentals"("meter_event_id");

-- CreateIndex
CREATE INDEX "license_rentals_license_id_started_at_idx" ON "license_rentals"("license_id", "started_at");

-- CreateIndex
CREATE INDEX "license_rentals_rentee_id_started_at_idx" ON "license_rentals"("rentee_id", "started_at");

-- AddForeignKey
ALTER TABLE "org_members" ADD CONSTRAINT "org_members_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_members" ADD CONSTRAINT "org_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_templates" ADD CONSTRAINT "workspace_templates_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pool_instances" ADD CONSTRAINT "pool_instances_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "workspace_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "workspace_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_events" ADD CONSTRAINT "session_events_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "license_rentals" ADD CONSTRAINT "license_rentals_license_id_fkey" FOREIGN KEY ("license_id") REFERENCES "software_licenses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

