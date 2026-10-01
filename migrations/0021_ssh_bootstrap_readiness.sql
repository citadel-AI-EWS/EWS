-- Add Windows restricted-SSH bootstrap readiness without storing credentials.
ALTER TABLE node_ssh_state ADD COLUMN restricted_bootstrap_state_present INTEGER NOT NULL DEFAULT 0 CHECK (restricted_bootstrap_state_present IN (0,1));
ALTER TABLE node_ssh_state ADD COLUMN restricted_console_installed INTEGER NOT NULL DEFAULT 0 CHECK (restricted_console_installed IN (0,1));
ALTER TABLE node_ssh_state ADD COLUMN cloudflare_ca_public_key_present INTEGER NOT NULL DEFAULT 0 CHECK (cloudflare_ca_public_key_present IN (0,1));
ALTER TABLE node_ssh_state ADD COLUMN sshd_force_command_managed INTEGER NOT NULL DEFAULT 0 CHECK (sshd_force_command_managed IN (0,1));
ALTER TABLE node_ssh_state ADD COLUMN restricted_policy_ready INTEGER NOT NULL DEFAULT 0 CHECK (restricted_policy_ready IN (0,1));
