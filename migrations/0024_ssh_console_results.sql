-- Bounded on-demand result storage for the restricted Hub SSH console.
-- Results are written only for signed ssh_console commands.
ALTER TABLE commands ADD COLUMN result_json TEXT;
