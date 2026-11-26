-- Axiom 0017: "don't ask again" choices on Claude Code approvals (docs/plan/desk.md, D13).
-- `suggestions`: JSON array of the permission updates Claude Code offered with the request (its
-- `permission_suggestions`, cleaned by core). `applied`: JSON array of the updates the owner chose
-- to send back with an allow (NULL for a plain allow, a deny or an expiry).

ALTER TABLE approval ADD COLUMN suggestions TEXT;
ALTER TABLE approval ADD COLUMN applied TEXT;
