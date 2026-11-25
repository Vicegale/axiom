-- Axiom 0012: Steward deciding (docs/plan/steward.md, slice ST3).
-- A finding may ask for promotion to a stronger model: the complexity stage 2 rated the task
-- (simple, medium or hard). ST6 acts on it; ST3 only keeps it on the item.

ALTER TABLE steward_item ADD COLUMN promotion TEXT
  CHECK (promotion IS NULL OR promotion IN ('simple', 'medium', 'hard'));
