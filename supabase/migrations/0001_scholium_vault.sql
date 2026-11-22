-- Scholium's permanent store: an exact, continuously updated copy of every project and of the workspace.
-- Only the site's server (service role) can reach it; row level security is on with no policies.

create table if not exists public.scholium_rows (
  obj text not null,
  tbl text not null,
  k text collate "C" not null,
  v text not null,
  at timestamptz not null default now(),
  primary key (obj, tbl, k)
);

create table if not exists public.scholium_lease (
  id text primary key,
  site text not null,
  label text not null default '',
  epoch bigint not null default 1,
  at timestamptz not null default now()
);

alter table public.scholium_rows enable row level security;
alter table public.scholium_lease enable row level security;

-- Writes one batch for one object, only while the calling site holds the lease.
-- p_del: [{tbl, k}] units to clear (every row whose key is k + tab + part). p_put: [{tbl, k, v}] rows to store.
create or replace function public.scholium_apply(p_site text, p_epoch bigint, p_obj text, p_del jsonb, p_put jsonb)
returns text language plpgsql set search_path = public as $$
declare held boolean;
begin
  select true into held from scholium_lease where id = 'main' and site = p_site and epoch = p_epoch for share;
  if held is null then return 'standby'; end if;
  delete from scholium_rows r using jsonb_to_recordset(coalesce(p_del, '[]'::jsonb)) as d(tbl text, k text)
    where r.obj = p_obj and r.tbl = d.tbl and r.k >= d.k || E'\t' and r.k < d.k || E'\n';
  insert into scholium_rows (obj, tbl, k, v)
    select p_obj, x.tbl, x.k, x.v from jsonb_to_recordset(coalesce(p_put, '[]'::jsonb)) as x(tbl text, k text, v text)
    on conflict (obj, tbl, k) do update set v = excluded.v, at = now();
  return 'ok';
end $$;

-- Takes the lease. Without p_force it only succeeds when nobody holds it. Returns the lease as it now stands.
create or replace function public.scholium_claim(p_site text, p_label text, p_force boolean)
returns jsonb language plpgsql set search_path = public as $$
declare l scholium_lease;
begin
  insert into scholium_lease (id, site, label) values ('main', p_site, p_label) on conflict (id) do nothing;
  select * into l from scholium_lease where id = 'main' for update;
  if p_force and l.site <> p_site then
    update scholium_lease set site = p_site, label = p_label, epoch = l.epoch + 1, at = now() where id = 'main' returning * into l;
  end if;
  return jsonb_build_object('site', l.site, 'label', l.label, 'epoch', l.epoch, 'at', l.at);
end $$;

-- Reads one object back a page at a time, in key order, bounded by size.
create or replace function public.scholium_page(p_obj text, p_tbl text, p_k text, p_bytes integer)
returns jsonb language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('tbl', t.tbl, 'k', t.k, 'v', t.v) order by t.tbl, t.k), '[]'::jsonb)
  from (
    select s.tbl, s.k, s.v, sum(s.n) over (order by s.tbl, s.k) - s.n as before
    from (
      select tbl, k, v, octet_length(v) as n from scholium_rows
      where obj = p_obj and (tbl, k) > (p_tbl, p_k)
      order by tbl, k limit 4000
    ) s
  ) t
  where t.before < p_bytes;
$$;

-- Removes one object for good (a project the owner deleted), only while the calling site holds the lease.
create or replace function public.scholium_drop(p_site text, p_epoch bigint, p_obj text)
returns text language plpgsql set search_path = public as $$
begin
  if not exists (select 1 from scholium_lease where id = 'main' and site = p_site and epoch = p_epoch) then return 'standby'; end if;
  delete from scholium_rows where obj = p_obj;
  return 'ok';
end $$;

revoke all on function public.scholium_apply(text, bigint, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.scholium_claim(text, text, boolean) from public, anon, authenticated;
revoke all on function public.scholium_page(text, text, text, integer) from public, anon, authenticated;
revoke all on function public.scholium_drop(text, bigint, text) from public, anon, authenticated;
grant execute on function public.scholium_apply(text, bigint, text, jsonb, jsonb) to service_role;
grant execute on function public.scholium_claim(text, text, boolean) to service_role;
grant execute on function public.scholium_page(text, text, text, integer) to service_role;
grant execute on function public.scholium_drop(text, bigint, text) to service_role;
