-- ════════════════════════════════════════════════════════════════════
-- 003 — Product name on each fitment row
--
-- Customers are told the product by name ("Evolution AS-4 Premium
-- Windshield for Club Car"), never by SKU. The fitment list carries the
-- customer-facing product name so the assistant never needs the SKU.
-- Safe to run more than once.
-- ════════════════════════════════════════════════════════════════════

alter table fitment add column if not exists product text;
