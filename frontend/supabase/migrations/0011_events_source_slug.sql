-- Per-thread attribution for the backlink loop. NULL for home landings without a
-- ?src marker and for all pre-migration rows. Not PII — a random base64url share slug.
alter table events add column if not exists source_slug text;

create index if not exists events_source_slug_idx on events (source_slug);
