-- HOW TO SCORE A | Stage 3C - Student Account Management
-- Adds server-side permissions needed for:
-- 1) changing a student's login Email
-- 2) keeping Email-based learning records in sync
-- 3) resetting a Temporary Password
--
-- Run ONCE in Supabase SQL Editor.
-- This does NOT change any existing data by itself.

grant usage on schema public to service_role;

grant select on table public.user_roles to service_role;

grant select, update on table public.scorea_daily_reflections to service_role;
grant select, update on table public.scorea_free_diagnostics to service_role;
grant select, update on table public.scorea_free_learning_profiles to service_role;
grant select, update on table public.scorea_free_challenge_days to service_role;

-- Verification
select
  table_name,
  privilege_type
from information_schema.role_table_grants
where table_schema='public'
  and grantee='service_role'
  and table_name in (
    'user_roles',
    'scorea_daily_reflections',
    'scorea_free_diagnostics',
    'scorea_free_learning_profiles',
    'scorea_free_challenge_days'
  )
order by table_name, privilege_type;
