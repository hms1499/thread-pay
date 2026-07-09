-- Migration: multi-tone variations (A/B tones)
--
-- One payment (×3 price) generates the same topic in all three tones. The invoice
-- is tagged with variant_tones so the redeem branch knows to fan out. The
-- generations row keeps every variant; thread_content stays = the winner's thread
-- so history/share/regenerate read paths are unchanged. selected_tone names the
-- current winner. All columns are nullable → existing single-tone rows are untouched.
--
-- Run this in the Supabase SQL editor.

alter table invoices    add column if not exists variant_tones jsonb;   -- e.g. ["educational","funny","threadboi"]; NULL for single-tone
alter table generations add column if not exists variants      jsonb;   -- [{"tone":"educational","thread":["..."]}]; NULL for single-tone
alter table generations add column if not exists selected_tone text;    -- winner tone; NULL for single-tone
