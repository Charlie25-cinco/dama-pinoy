-- v2.3: optional permanent Auth identities, private server-validated stats,
-- and privacy-preserving deletion. Existing Auth-owned guest seats are reused.
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (display_name = btrim(display_name) and
    char_length(display_name) between 1 and 20 and display_name !~ '[[:cntrl:]<>]'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
revoke all on public.profiles from public, anon, authenticated;
grant select on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;
grant all on public.profiles to service_role;
create policy "Read own profile" on public.profiles for select to authenticated using (id = auth.uid());
create policy "Edit own profile" on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create function public.online_profile_stamp() returns trigger language plpgsql
set search_path = public, pg_temp as $$
begin new.updated_at := now(); return new; end; $$;
create trigger profile_timestamp before update on public.profiles
  for each row execute function public.online_profile_stamp();
revoke all on function public.online_profile_stamp() from public, anon, authenticated;

create function public.online_create_profile() returns trigger language plpgsql
security definer set search_path = public, pg_temp as $$
declare label text;
begin
  if new.is_anonymous is not true then
    label := btrim(coalesce(new.raw_user_meta_data->>'display_name','Player'));
    if char_length(label) not between 1 and 20 or label ~ '[[:cntrl:]<>]' then label := 'Player'; end if;
    insert into public.profiles(id,display_name) values(new.id,label) on conflict(id) do nothing;
    update public.rooms set version = version + 1
      where host_user_id = new.id or guest_user_id = new.id;
  end if;
  return new;
end; $$;
create trigger dama_account_profile after insert or update of is_anonymous on auth.users
  for each row execute function public.online_create_profile();
revoke all on function public.online_create_profile() from public, anon, authenticated;
insert into public.profiles(id,display_name)
  select id,'Player' from auth.users where is_anonymous is not true on conflict(id) do nothing;

create table public.account_game_results (
  user_id uuid not null references auth.users(id) on delete cascade,
  game_id uuid not null references public.games(id) on delete cascade,
  outcome text not null check(outcome in ('win','loss','draw')),
  series_format text not null,
  total_moves integer not null,
  captures_for integer not null,
  captures_against integer not null,
  created_at timestamptz not null default now(),
  primary key(user_id,game_id)
);
create table public.account_series_results (
  user_id uuid not null references auth.users(id) on delete cascade,
  room_id uuid not null references public.rooms(id) on delete cascade,
  series_number integer not null,
  series_format text not null,
  outcome text not null check(outcome in ('win','loss','draw')),
  created_at timestamptz not null default now(),
  primary key(user_id,room_id,series_number)
);
alter table public.account_game_results enable row level security;
alter table public.account_series_results enable row level security;
revoke all on public.account_game_results,public.account_series_results from public,anon,authenticated;
grant select on public.account_game_results,public.account_series_results to authenticated;
grant all on public.account_game_results,public.account_series_results to service_role;
create policy "Read own account games" on public.account_game_results for select to authenticated using(user_id=auth.uid());
create policy "Read own account series" on public.account_series_results for select to authenticated using(user_id=auth.uid());

create function public.online_account_game_stats() returns trigger language plpgsql
security definer set search_path = public, pg_temp as $$
declare seat record; captures_own integer; captures_other integer;
begin
  for seat in select new.host_guest_id as uid,new.host_color as color
    union all select new.guest_guest_id,new.guest_color loop
    if exists(select 1 from public.profiles where id=seat.uid) then
      select coalesce(sum(jsonb_array_length(m->'captures')) filter(where m->>'playerColor'=seat.color),0),
        coalesce(sum(jsonb_array_length(m->'captures')) filter(where m->>'playerColor'<>seat.color),0)
        into captures_own,captures_other from jsonb_array_elements(new.moves) m;
      insert into public.account_game_results(user_id,game_id,outcome,series_format,total_moves,captures_for,captures_against)
        values(seat.uid,new.game_id,case when new.winner_color is null then 'draw'
          when new.winner_color=seat.color then 'win' else 'loss' end,
          new.series_format,new.total_moves,captures_own,captures_other) on conflict do nothing;
    end if;
  end loop;
  return new;
end; $$;
create trigger account_game_record after insert on public.online_replays for each row
  execute function public.online_account_game_stats();
create function public.online_account_series_stats() returns trigger language plpgsql
security definer set search_path = public, pg_temp as $$
declare uid uuid;
begin
  if new.status='finished' and old.status is distinct from 'finished' then
    foreach uid in array array[new.host_user_id,new.guest_user_id] loop
      if exists(select 1 from public.profiles where id=uid) then
        insert into public.account_series_results(user_id,room_id,series_number,series_format,outcome)
        values(uid,new.id,new.current_series_number,new.series_format,
          case when new.match_winner_user_id is null then 'draw'
          when new.match_winner_user_id=uid then 'win' else 'loss' end) on conflict do nothing;
      end if;
    end loop;
  end if;
  return new;
end; $$;
create trigger account_series_record after update of status on public.rooms for each row
  execute function public.online_account_series_stats();
revoke all on function public.online_account_game_stats() from public,anon,authenticated;
revoke all on function public.online_account_series_stats() from public,anon,authenticated;

create function public.online_account_stats(p_user uuid) returns jsonb language sql stable
security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('games',(select jsonb_build_object('played',count(*),
    'wins',count(*) filter(where outcome='win'),'losses',count(*) filter(where outcome='loss'),
    'draws',count(*) filter(where outcome='draw'),'capturesFor',coalesce(sum(captures_for),0),
    'capturesAgainst',coalesce(sum(captures_against),0),'averageMoves',coalesce(round(avg(total_moves),1),0))
    from public.account_game_results where user_id=p_user),
    'series',(select jsonb_build_object('played',count(*),'wins',count(*) filter(where outcome='win'),
      'losses',count(*) filter(where outcome='loss'),'draws',count(*) filter(where outcome='draw'))
      from public.account_series_results where user_id=p_user));
$$;
revoke all on function public.online_account_stats(uuid) from public,anon,authenticated;
grant execute on function public.online_account_stats(uuid) to service_role;

-- Deletion atomically removes private stats/profile via FK cascades. Shared
-- game history retains a random, non-auth tombstone and no deleted player name.
create function public.online_anonymize_deleted_user() returns trigger language plpgsql
security definer set search_path = public, pg_temp as $$
declare tombstone uuid := gen_random_uuid();
begin
  update public.rooms set
    host_user_id=case when host_user_id=old.id then tombstone else host_user_id end,
    guest_user_id=case when guest_user_id=old.id then tombstone else guest_user_id end,
    match_winner_user_id=case when match_winner_user_id=old.id then tombstone else match_winner_user_id end,
    host_name=case when host_user_id=old.id then 'Deleted player' else host_name end,
    guest_name=case when guest_user_id=old.id then 'Deleted player' else guest_name end,
    status='closed',version=version+1,updated_at=now()
    where host_user_id=old.id or guest_user_id=old.id;
  update public.online_replays set
    host_guest_id=case when host_guest_id=old.id then tombstone else host_guest_id end,
    guest_guest_id=case when guest_guest_id=old.id then tombstone else guest_guest_id end,
    winner_guest_id=case when winner_guest_id=old.id then tombstone else winner_guest_id end,
    host_name=case when host_guest_id=old.id then 'Deleted player' else host_name end,
    guest_name=case when guest_guest_id=old.id then 'Deleted player' else guest_name end,
    winner_name=case when winner_guest_id=old.id then 'Deleted player' else winner_name end
    where host_guest_id=old.id or guest_guest_id=old.id;
  update public.match_results set winner_user_id=tombstone,winner_name='Deleted player' where winner_user_id=old.id;
  update public.moves set player_user_id=tombstone where player_user_id=old.id;
  delete from public.room_spectators where guest_id=old.id;
  return old;
end; $$;
create trigger dama_delete_account before delete on auth.users for each row
  execute function public.online_anonymize_deleted_user();
revoke all on function public.online_anonymize_deleted_user() from public,anon,authenticated;
