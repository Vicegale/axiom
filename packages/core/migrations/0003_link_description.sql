-- Axiom 0003: an optional one-line description on a link (docs/spec/05-data-model.md, "Link").

ALTER TABLE link ADD COLUMN description TEXT;
