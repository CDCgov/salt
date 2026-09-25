-- Adds a survey-level JEXL expression that can lower the number of coupons
-- issued at survey completion. The facility's coupons_to_issue is always the
-- ceiling; this script can only reduce it (numeric result, or true/false for
-- all/none). Blank means "issue the facility count" (previous behavior).
--
-- Apply with:  sqlite3 data/database/salt.db < scripts/add-coupon-count-script.sql
ALTER TABLE surveys ADD COLUMN coupon_count_script TEXT;
