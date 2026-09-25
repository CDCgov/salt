-- Optional per-facility enrollment quota. NULL = no quota (unlimited).
-- Tablets stop starting new surveys (walk-ins and coupon holders alike) once
-- the number of completed surveys on the tablet reaches this value.
--
-- Apply with:  sqlite3 data/database/salt.db < scripts/add-facility-enrollment-quota.sql
ALTER TABLE facilities ADD COLUMN enrollment_quota INTEGER DEFAULT NULL;
