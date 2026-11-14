-- Owner-declared maximum rental window shown in the marketplace.
-- Additive and nullable: legacy listings keep the global API cap.
ALTER TABLE "software_licenses"
  ADD COLUMN "max_duration_hours" INTEGER;
