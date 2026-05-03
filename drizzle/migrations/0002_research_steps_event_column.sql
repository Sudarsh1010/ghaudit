-- Slice 5: store the full encoded AgentEvent JSON per step row, so SSE
-- replay on EventSource reconnect can re-emit the original event with
-- the same id + type + payload. The default `{}` keeps the constraint
-- satisfied for any pre-existing rows from earlier slices; new rows
-- always supply a real value via `appendStep`.
ALTER TABLE `research_steps` ADD `event` text DEFAULT '{}' NOT NULL;
