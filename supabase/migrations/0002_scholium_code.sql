-- A copy of the site's own code, kept beside the work it produced, so both can be taken to another account.
-- One row, replaced whenever the code is saved again. Readable and writable with the service key only.
create table if not exists public.scholium_code (
  id int primary key check (id = 1),
  at timestamptz not null default now(),
  bytes int not null,
  files int not null,
  sha text not null,
  data text not null
);
alter table public.scholium_code enable row level security;
revoke all on public.scholium_code from public, anon, authenticated;
grant select, insert, update, delete on public.scholium_code to service_role;

-- How much room the stored projects take, so the site can warn before the database fills up.
create or replace function public.scholium_size()
returns bigint language sql stable security definer set search_path = public as $$
  select pg_total_relation_size('public.scholium_rows')::bigint;
$$;
revoke all on function public.scholium_size() from public, anon, authenticated;
grant execute on function public.scholium_size() to service_role;
