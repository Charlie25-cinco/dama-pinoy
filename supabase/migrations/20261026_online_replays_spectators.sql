-- v2.2.0: Auth-owned spectators and immutable, transactional game replays.
create table public.room_spectators (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  guest_id uuid not null,
  guest_name text not null check (char_length(guest_name) between 1 and 20),
  joined_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (room_id, guest_id)
);
create table public.online_replays (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  game_id uuid not null unique references public.games(id) on delete cascade,
  series_number integer not null check (series_number > 0),
  series_format text not null check (series_format in ('single','bestOfThree','bestOfFive','bestOfNine')),
  game_number integer not null check (game_number > 0),
  mode text not null default 'online' check (mode = 'online'),
  host_guest_id uuid not null,
  guest_guest_id uuid not null,
  host_name text not null,
  guest_name text not null,
  host_color text not null check (host_color in ('R','B')),
  guest_color text not null check (guest_color in ('R','B') and guest_color <> host_color),
  starting_color text not null default 'R' check (starting_color = 'R'),
  winner_color text check (winner_color in ('R','B')),
  winner_guest_id uuid,
  winner_name text,
  result text not null check (result in ('host','guest','draw')),
  result_reason text not null,
  host_score integer not null,
  guest_score integer not null,
  host_view text not null check (host_view in ('red-bottom','blue-bottom')),
  guest_view text not null check (guest_view in ('red-bottom','blue-bottom')),
  total_moves integer not null check (total_moves > 0),
  moves jsonb not null check (jsonb_typeof(moves) = 'array'),
  created_at timestamptz not null default now()
);
create index online_replays_host_recent on public.online_replays(host_guest_id, created_at desc);
create index online_replays_guest_recent on public.online_replays(guest_guest_id, created_at desc);
alter table public.room_spectators enable row level security;
alter table public.online_replays enable row level security;
revoke all on public.room_spectators, public.online_replays from public, anon, authenticated;
grant select on public.room_spectators, public.online_replays to authenticated;
grant all on public.room_spectators, public.online_replays to service_role;

-- No caller-supplied user ID: RLS derives identity from the verified JWT.
create function public.online_can_watch(p_room uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.rooms r where r.id = p_room and
    (r.host_user_id = auth.uid() or r.guest_user_id = auth.uid() or
      (r.status in ('active','finished') and exists (
        select 1 from public.room_spectators s where s.room_id = r.id
        and s.guest_id = auth.uid() and s.last_seen_at > now() - interval '60 seconds'))));
$$;
revoke all on function public.online_can_watch(uuid) from public, anon;
grant execute on function public.online_can_watch(uuid) to authenticated, service_role;
create policy "Room viewers read spectators" on public.room_spectators for select to authenticated
  using (public.online_can_watch(room_id));
create policy "Authorized replay viewers" on public.online_replays for select to authenticated
  using (host_guest_id = auth.uid() or guest_guest_id = auth.uid() or
    exists (select 1 from public.room_spectators s join public.rooms r on r.id = s.room_id
      where s.room_id = online_replays.room_id and s.guest_id = auth.uid()
      and s.last_seen_at > now() - interval '60 seconds' and r.status in ('active','finished')));
create policy "Spectators read room" on public.rooms for select to authenticated
  using (public.online_can_watch(id));
create policy "Spectators read game" on public.games for select to authenticated
  using (public.online_can_watch(room_id));
create policy "Spectators read moves" on public.moves for select to authenticated
  using (exists (select 1 from public.games g where g.id = game_id and public.online_can_watch(g.room_id)));
create policy "Viewers receive room hints" on realtime.messages for select to authenticated
  using (extension in ('presence','broadcast') and exists (
    select 1 from public.rooms r where realtime.topic() = 'room:' || r.id::text
      and r.status <> 'closed' and public.online_can_watch(r.id)));
create policy "Spectators send presence only" on realtime.messages for insert to authenticated
  with check (extension = 'presence' and exists (
    select 1 from public.rooms r where realtime.topic() = 'room:' || r.id::text
      and r.status <> 'closed' and public.online_can_watch(r.id)));

create function public.online_join_spectator(p_code text, p_name text, p_user uuid)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.rooms%rowtype;
begin
  select * into r from public.rooms where room_code = p_code for update;
  if not found or r.status <> 'active' or r.guest_user_id is null or
    r.host_user_id = p_user or r.guest_user_id = p_user or
    r.host_seen_at < now() - interval '60 seconds' or r.guest_seen_at < now() - interval '60 seconds' then
    raise exception 'Room unavailable';
  end if;
  delete from public.room_spectators where room_id = r.id and last_seen_at <= now() - interval '60 seconds';
  if not exists (select 1 from public.room_spectators where room_id = r.id and guest_id = p_user)
    and (select count(*) from public.room_spectators where room_id = r.id) >= 5 then
    raise exception 'Room unavailable: spectator limit reached';
  end if;
  insert into public.room_spectators(room_id, guest_id, guest_name) values (r.id,p_user,p_name)
    on conflict (room_id,guest_id) do update set guest_name = excluded.guest_name, last_seen_at = now();
  update public.rooms set version = version + 1 where id = r.id;
  return r.id;
end; $$;

create or replace function public.online_heartbeat(p_room uuid, p_user uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.rooms%rowtype; spectator boolean;
begin
  select * into r from public.rooms where id = p_room for update;
  if not found then raise exception 'Room unavailable'; end if;
  spectator := r.host_user_id is distinct from p_user and r.guest_user_id is distinct from p_user;
  if spectator and not exists (select 1 from public.room_spectators where room_id = p_room
    and guest_id = p_user and last_seen_at > now() - interval '60 seconds') then
    raise exception 'Room unavailable';
  end if;
  if r.status = 'closed' then return; end if;
  if r.last_activity_at < now() - interval '30 minutes' or
    (r.guest_user_id is not null and (r.host_seen_at < now() - interval '60 seconds'
      or r.guest_seen_at < now() - interval '60 seconds')) then
    update public.rooms set status = 'closed', version = version + 1, updated_at = now() where id = p_room;
    return;
  end if;
  if spectator then
    update public.room_spectators set last_seen_at = now() where room_id = p_room and guest_id = p_user;
  elsif r.host_user_id = p_user then
    update public.rooms set host_seen_at = now(), last_activity_at = now() where id = p_room;
  else
    update public.rooms set guest_seen_at = now(), last_activity_at = now() where id = p_room;
  end if;
end; $$;

create function public.online_leave_spectator(p_room uuid, p_user uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform 1 from public.rooms where id = p_room for update;
  delete from public.room_spectators where room_id = p_room and guest_id = p_user;
  if found then update public.rooms set version = version + 1 where id = p_room; end if;
end; $$;

-- Trigger executes within the move transaction: failed replay writes roll back
-- the game result too. game_id uniqueness prevents duplicate recordings.
create function public.online_record_replay() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.rooms%rowtype; history jsonb;
begin
  if new.status <> 'finished' or old.status = 'finished' then return new; end if;
  select * into strict r from public.rooms where id = new.room_id;
  select jsonb_agg(jsonb_build_object('number',m.move_number,'playerColor',m.player_color,
    'from',jsonb_build_object('row',m.from_row,'col',m.from_col),
    'to',jsonb_build_object('row',m.to_row,'col',m.to_col), 'path',m.path,
    'captures',m.captured_squares,'pieceType',m.piece_type,'promoted',m.promoted)
    order by m.move_number) into history from public.moves m where m.game_id = new.id;
  if jsonb_array_length(history) is distinct from new.move_count then raise exception 'Incomplete replay'; end if;
  insert into public.online_replays(room_id,game_id,series_number,series_format,game_number,
    host_guest_id,guest_guest_id,host_name,guest_name,host_color,guest_color,
    winner_color,winner_guest_id,winner_name,result,result_reason,host_score,guest_score,
    host_view,guest_view,total_moves,moves)
  values (r.id,new.id,new.series_number,r.series_format,new.game_number,
    r.host_user_id,r.guest_user_id,r.host_name,r.guest_name,new.host_color,new.guest_color,
    new.winner_color,case when new.winner_color = new.host_color then r.host_user_id
      when new.winner_color = new.guest_color then r.guest_user_id end,
    case when new.winner_color = new.host_color then r.host_name
      when new.winner_color = new.guest_color then r.guest_name end,
    case when new.winner_color = new.host_color then 'host'
      when new.winner_color = new.guest_color then 'guest' else 'draw' end,
    new.result_reason,r.host_score + case when new.winner_color = new.host_color then 1 else 0 end,
    r.guest_score + case when new.winner_color = new.guest_color then 1 else 0 end,
    case when new.host_color = 'R' then 'red-bottom' else 'blue-bottom' end,
    case when new.guest_color = 'R' then 'red-bottom' else 'blue-bottom' end,new.move_count,history);
  return new;
end; $$;
create trigger online_game_replay after update of status on public.games
  for each row execute function public.online_record_replay();
revoke all on function public.online_record_replay() from public, anon, authenticated;
revoke all on function public.online_join_spectator(text,text,uuid) from public, anon, authenticated;
revoke all on function public.online_leave_spectator(uuid,uuid) from public, anon, authenticated;
grant execute on function public.online_join_spectator(text,text,uuid) to service_role;
grant execute on function public.online_leave_spectator(uuid,uuid) to service_role;
