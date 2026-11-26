-- Axiom 0013: Steward promotion and prepared fixes (docs/plan/steward.md, slice ST6).
-- A quiet note on an item: "report only", "promotion skipped: cap reached", "couldn't prepare a
-- fix: ..." and similar facts the view shows next to a finding.

ALTER TABLE steward_item ADD COLUMN note TEXT;
