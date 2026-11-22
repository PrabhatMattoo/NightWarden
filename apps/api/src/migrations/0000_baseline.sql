CREATE TABLE `alerts` (
	`id` integer PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`group_key` text NOT NULL,
	`source_alert_id` text NOT NULL,
	`labels` text DEFAULT '{}' NOT NULL,
	`fired_at` text NOT NULL,
	`arrived_at` text NOT NULL,
	`cleared_at` text,
	`injected` integer DEFAULT false NOT NULL,
	`pending_delivery` integer DEFAULT false NOT NULL,
	`dropped_alerts` integer DEFAULT 0 NOT NULL,
	`group_context` text,
	`alert` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_alerts_session` ON `alerts` (`session_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_alerts_firing` ON `alerts` (`source_alert_id`,`fired_at`) WHERE "alerts"."cleared_at" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_alerts_open` ON `alerts` (`session_id`) WHERE "alerts"."cleared_at" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_alerts_group` ON `alerts` (`group_key`);--> statement-breakpoint
CREATE TABLE `session_transcript` (
	`session_id` text NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`content` text NOT NULL,
	`canonical` text,
	`timestamp` text NOT NULL,
	`client_id` text,
	`reminder` text,
	PRIMARY KEY(`session_id`, `seq`),
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "session_transcript_kind" CHECK("session_transcript"."kind" IN ('user', 'assistant', 'error', 'system_reminder')),
	CONSTRAINT "session_transcript_reminder" CHECK("session_transcript"."reminder" IN ('alert_opening', 'candidates_opening', 'frontier', 'falsification', 'report_request', 'report_retry', 'closing', 'text_only', 'reopen', 'record_check', 'toolset_change', 'injected_alerts', 'sandbox_ready', 'decision_wait'))
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`session_id` text PRIMARY KEY NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`investigation` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'completed' NOT NULL,
	`held_reason` text,
	`failed_attempts` integer DEFAULT 0 NOT NULL,
	`failure_kind` text,
	`stopped_at` text,
	`awaiting_tool_use_id` text,
	`awaiting_kind` text,
	`awaiting_since` text,
	`open_turn` text,
	`candidates` text DEFAULT '[]' NOT NULL,
	`findings` text DEFAULT '[]' NOT NULL,
	`report` text,
	`record_updated_at` text,
	`created_at` text NOT NULL,
	`last_activity_at` text NOT NULL,
	CONSTRAINT "sessions_status" CHECK("sessions"."status" IN ('action_required', 'running', 'resolved', 'stopped', 'failed', 'completed', 'not_started')),
	CONSTRAINT "sessions_failure_kind" CHECK("sessions"."failure_kind" IN ('transient', 'permanent')),
	CONSTRAINT "sessions_awaiting_kind" CHECK("sessions"."awaiting_kind" IN ('approval', 'clarification', 'continue'))
);
--> statement-breakpoint
CREATE INDEX `idx_sessions_list` ON `sessions` (`investigation`,("awaiting_tool_use_id" IS NOT NULL) DESC,"last_activity_at" DESC,`session_id`);--> statement-breakpoint
CREATE TABLE `tool_result_store` (
	`session_id` text NOT NULL,
	`tool_call_id` text NOT NULL,
	`content` text NOT NULL,
	PRIMARY KEY(`session_id`, `tool_call_id`),
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `runner` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`platform` text NOT NULL,
	`server_name` text NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text,
	CONSTRAINT "runner_platform" CHECK("runner"."platform" IN ('docker', 'kubernetes'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runner_token_unique` ON `runner` (`token`);--> statement-breakpoint
CREATE UNIQUE INDEX `runner_server_name_unique` ON `runner` (`server_name`);--> statement-breakpoint
CREATE TABLE `integrations` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`config` text NOT NULL,
	`secrets` text,
	`token_hash` text,
	`last_used_at` text,
	`rejected_at` text,
	`rejection` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `integrations_token_hash_unique` ON `integrations` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_integrations_name` ON `integrations` (`name`);--> statement-breakpoint
CREATE INDEX `idx_integrations_kind` ON `integrations` (`kind`);--> statement-breakpoint
CREATE TABLE `config` (
	`id` text PRIMARY KEY NOT NULL,
	`active_provider` text,
	`max_retries` integer,
	`max_investigations_per_hour` integer,
	`check_in_after_ms` integer,
	`tool_call_ceiling_ms` integer,
	`sandbox_idle_timeout_ms` integer,
	`sandbox_cpus` integer,
	`sandbox_memory_mb` integer,
	`sandbox_network` text,
	`key_check` text,
	`updated_at` text NOT NULL,
	CONSTRAINT "config_active_provider" CHECK("config"."active_provider" IN ('anthropic', 'openai', 'openrouter', 'openai-compatible')),
	CONSTRAINT "config_sandbox_network" CHECK("config"."sandbox_network" IN ('allowlist', 'open', 'none'))
);
--> statement-breakpoint
CREATE TABLE `provider_config` (
	`provider` text PRIMARY KEY NOT NULL,
	`model` text,
	`base_url` text,
	`api_key_encrypted` text,
	`reasoning_level` text,
	`updated_at` text NOT NULL,
	CONSTRAINT "provider_config_provider" CHECK("provider_config"."provider" IN ('anthropic', 'openai', 'openrouter', 'openai-compatible'))
);
--> statement-breakpoint
CREATE TABLE `sandbox_host_override` (
	`host` text PRIMARY KEY NOT NULL,
	`allowed` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_user_id_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE TABLE `auth_session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	`impersonated_by` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_session_token_unique` ON `auth_session` (`token`);--> statement-breakpoint
CREATE INDEX `auth_session_user_id_idx` ON `auth_session` (`user_id`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer NOT NULL,
	`image` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`role` text,
	`banned` integer,
	`ban_reason` text,
	`ban_expires` integer,
	`theme` text DEFAULT 'system' NOT NULL,
	CONSTRAINT "user_theme" CHECK("user"."theme" IN ('system', 'light', 'dark'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);