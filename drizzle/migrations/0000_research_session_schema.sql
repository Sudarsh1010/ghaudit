CREATE TABLE `prd_sections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text(40) NOT NULL,
	`section` text NOT NULL,
	`content` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `research_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `research_glossary` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text(40) NOT NULL,
	`term` text NOT NULL,
	`definition` text NOT NULL,
	`avoid_terms` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `research_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `research_open_qs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text(40) NOT NULL,
	`question` text NOT NULL,
	`context` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `research_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `research_questions` (
	`id` text(40) PRIMARY KEY NOT NULL,
	`session_id` text(40) NOT NULL,
	`step_id` integer,
	`question` text NOT NULL,
	`recommended_answer` text NOT NULL,
	`rationale` text NOT NULL,
	`user_reply` text,
	`asked_at` integer DEFAULT (unixepoch()) NOT NULL,
	`answered_at` integer,
	FOREIGN KEY (`session_id`) REFERENCES `research_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`step_id`) REFERENCES `research_steps`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `research_sessions` (
	`id` text(40) PRIMARY KEY NOT NULL,
	`initial_prompt` text NOT NULL,
	`status` text(20) NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `research_steps` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text(40) NOT NULL,
	`step_number` integer NOT NULL,
	`tool_name` text,
	`llm_prompt` text,
	`llm_response` text,
	`tool_request` text,
	`tool_response` text,
	`error_message` text,
	`status` text(7) NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `research_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
