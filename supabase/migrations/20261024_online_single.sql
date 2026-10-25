-- Dama Pinoy v2.0: guest-only Single Game rooms. Apply in the Supabase SQL editor.
-- Writes are reserved for the online-room Edge Function (service_role).
create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  room_code text not null unique check (room_code ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$'),
  status text not null default 'waiting' check (status in ('waiting', 'active', 'finished', 'closed')),
  series_format text not null default 'single' check (series_format = 'single'),
  current_game_number integer not null default 1 check (current_game_number > 0),
  host_user_id uuid not null,
  guest_user_id uuid check (guest_user_id is null or guest_user_id <> host_user_id),
  host_name text not null check (char_length(host_name) between 1 and 20),
  guest_name text check (guest_name is null or char_length(guest_name) between 1 and 20),
  host_color text not null default 'R' check (host_color in ('R', 'B')),
  guest_color text not null default 'B' check (guest_color in ('R', 'B')),
  current_turn text not null default 'R' check (current_turn in ('R', 'B')),
  version integer not null default 0 check (version >= 0),
  rematch_host boolean not null default false,
  rematch_guest boolean not null default false,
  host_seen_at timestamptz not null default now(),
  guest_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  check (host_color <> guest_color)
);

create table public.games (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  game_number integer not null check (game_number > 0),
  status text not null default 'active' check (status in ('active', 'finished')),
  starting_color text not null default 'R' check (starting_color = 'R'),
  board jsonb not null,
  quiet_plies integer not null default 0 check (quiet_plies between 0 and 200),
  winner_color text check (winner_color in ('R', 'B')),
  result_reason text check (result_reason in ('no-pieces', 'no-moves', 'quiet-limit')),
  move_count integer not null default 0 check (move_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (room_id, game_number)
);

create table public.moves (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games(id) on delete cascade,
  move_number integer not null check (move_number > 0),
  player_color text not null check (player_color in ('R', 'B')),
  player_user_id uuid not null,
  from_row integer not null check (from_row between 0 and 7),
  from_col integer not null check (from_col between 0 and 7),
  to_row integer not null check (to_row between 0 and 7),
  to_col integer not null check (to_col between 0 and 7),
  piece_type text not null check (piece_type in ('normal', 'dama')),
  path jsonb not null,
  captured_squares jsonb not null default '[]'::jsonb,
  promoted boolean not null default false,
  created_at timestamptz not null default now(),
  unique (game_id, move_number)
);

create table public.match_results (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  game_id uuid not null unique references public.games(id) on delete cascade,
  series_format text not null default 'single' check (series_format = 'single'),
  winner_user_id uuid,
  winner_name text,
  host_score integer not null default 0 check (host_score between 0 and 1),
  guest_score integer not null default 0 check (guest_score between 0 and 1),
  draws integer not null default 0 check (draws between 0 and 1),
  created_at timestamptz not null default now(),
  check (host_score + guest_score + draws = 1)
);

create index rooms_activity_idx on public.rooms (last_activity_at);
create index games_room_idx on public.games (room_id, game_number desc);
create index moves_game_idx on public.moves (game_id, move_number);

alter table public.rooms enable row level security;
alter table public.games enable row level security;
alter table public.moves enable row level security;
alter table public.match_results enable row level security;

revoke all on public.rooms, public.games, public.moves, public.match_results from anon, authenticated;
grant select on public.rooms, public.games, public.moves, public.match_results to authenticated;
grant all on public.rooms, public.games, public.moves, public.match_results to service_role;

create policy "Members can read their room" on public.rooms for select to authenticated
  using (host_user_id = (select auth.uid()) or guest_user_id = (select auth.uid()));
create policy "Members can read games" on public.games for select to authenticated
  using (exists (select 1 from public.rooms r where r.id = room_id
    and (r.host_user_id = (select auth.uid()) or r.guest_user_id = (select auth.uid()))));
create policy "Members can read moves" on public.moves for select to authenticated
  using (exists (select 1 from public.games g join public.rooms r on r.id = g.room_id
    where g.id = game_id and
    (r.host_user_id = (select auth.uid()) or r.guest_user_id = (select auth.uid()))));
create policy "Members can read results" on public.match_results for select to authenticated
  using (exists (select 1 from public.rooms r where r.id = room_id
    and (r.host_user_id = (select auth.uid()) or r.guest_user_id = (select auth.uid()))));

-- Supabase already enables RLS on realtime.messages. Turn off public channel access
-- in Realtime Settings and join channels with config.private = true.
create policy "Room members receive presence and broadcast" on realtime.messages
  for select to authenticated using (extension in ('presence', 'broadcast') and
    exists (select 1 from public.rooms r where realtime.topic() = 'room:' || r.id::text
      and r.status <> 'closed' and
      (r.host_user_id = (select auth.uid()) or r.guest_user_id = (select auth.uid()))));
create policy "Room members send presence and broadcast" on realtime.messages
  for insert to authenticated with check (extension in ('presence', 'broadcast') and
    exists (select 1 from public.rooms r where realtime.topic() = 'room:' || r.id::text
      and r.status <> 'closed' and
      (r.host_user_id = (select auth.uid()) or r.guest_user_id = (select auth.uid()))));

create function public.online_create_room(p_code text, p_name text, p_user uuid)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  insert into public.rooms (room_code, host_name, host_user_id)
  values (p_code, p_name, p_user) returning id into v_id;
  return v_id;
end; $$;

create function public.online_join_room(p_code text, p_name text, p_user uuid, p_board jsonb)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_room public.rooms%rowtype;
declare v_game uuid;
begin
  select * into v_room from public.rooms where room_code = p_code for update;
  if not found or v_room.status <> 'waiting' or v_room.guest_user_id is not null or
     v_room.host_user_id = p_user or v_room.host_seen_at < now() - interval '60 seconds' or
     v_room.last_activity_at < now() - interval '30 minutes' then
    raise exception 'Room unavailable' using errcode = 'P0001';
  end if;
  update public.rooms set guest_user_id = p_user, guest_name = p_name,
    guest_seen_at = now(), status = 'active', current_turn = 'R',
    updated_at = now(), last_activity_at = now(), version = version + 1
  where id = v_room.id;
  insert into public.games (room_id, game_number, board)
  values (v_room.id, 1, p_board) returning id into v_game;
  return v_room.id;
end; $$;

create function public.online_commit_move(
  p_room uuid, p_game uuid, p_user uuid, p_expected_count integer,
  p_move jsonb, p_board jsonb, p_quiet integer, p_result jsonb
) returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_room public.rooms%rowtype;
declare v_game public.games%rowtype;
declare v_winner text;
begin
  select * into v_room from public.rooms where id = p_room for update;
  if not found or v_room.status <> 'active' or v_room.guest_user_id is null or
     v_room.last_activity_at < now() - interval '30 minutes' or
     (v_room.host_user_id is distinct from p_user and v_room.guest_user_id is distinct from p_user) or
     (case when v_room.host_user_id = p_user then v_room.host_color
       else v_room.guest_color end) <> v_room.current_turn then
    raise exception 'Room or turn unavailable' using errcode = 'P0001';
  end if;
  select * into v_game from public.games where id = p_game and room_id = p_room
    and game_number = v_room.current_game_number for update;
  if not found or v_game.status <> 'active' or v_game.move_count <> p_expected_count or
     (p_move->>'playerColor') <> v_room.current_turn then
    raise exception 'Stale or invalid move' using errcode = 'P0001';
  end if;
  insert into public.moves (game_id, move_number, player_color, player_user_id,
    from_row, from_col, to_row, to_col, piece_type, path, captured_squares, promoted)
  values (p_game, p_expected_count + 1, v_room.current_turn, p_user,
    (p_move->'from'->>'row')::integer, (p_move->'from'->>'col')::integer,
    (p_move->'to'->>'row')::integer, (p_move->'to'->>'col')::integer,
    p_move->>'pieceType', p_move->'path', p_move->'captures',
    (p_move->>'promoted')::boolean);
  v_winner := p_result->>'winner';
  update public.games set board = p_board, quiet_plies = p_quiet,
    move_count = move_count + 1, status = case when p_result is null then 'active' else 'finished' end,
    winner_color = v_winner, result_reason = p_result->>'reason', updated_at = now()
  where id = p_game;
  update public.rooms set current_turn = case when current_turn = 'R' then 'B' else 'R' end,
    status = case when p_result is null then 'active' else 'finished' end,
    version = version + 1, last_activity_at = now(), updated_at = now()
  where id = p_room;
  if p_result is not null then
    insert into public.match_results (room_id, game_id, winner_user_id,
      winner_name, host_score, guest_score, draws)
    values (p_room, p_game,
      case when v_winner is null then null when v_winner = v_room.host_color
        then v_room.host_user_id else v_room.guest_user_id end,
      case when v_winner is null then null when v_winner = v_room.host_color
        then v_room.host_name else v_room.guest_name end,
      case when v_winner = v_room.host_color then 1 else 0 end,
      case when v_winner = v_room.guest_color then 1 else 0 end,
      case when v_winner is null then 1 else 0 end);
  end if;
end; $$;

create function public.online_request_rematch(p_room uuid, p_user uuid, p_board jsonb)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_room public.rooms%rowtype;
begin
  select * into v_room from public.rooms where id = p_room for update;
  if not found or v_room.status <> 'finished' or v_room.guest_user_id is null or
     (v_room.host_user_id is distinct from p_user and v_room.guest_user_id is distinct from p_user) then
    raise exception 'Rematch unavailable' using errcode = 'P0001';
  end if;
  if v_room.host_user_id = p_user then
    update public.rooms set rematch_host = true where id = p_room;
    v_room.rematch_host := true;
  else
    update public.rooms set rematch_guest = true where id = p_room;
    v_room.rematch_guest := true;
  end if;
  if v_room.rematch_host and v_room.rematch_guest then
    insert into public.games (room_id, game_number, board)
    values (p_room, v_room.current_game_number + 1, p_board);
    update public.rooms set status = 'active', current_game_number = current_game_number + 1,
      current_turn = 'R', rematch_host = false, rematch_guest = false,
      version = version + 1, last_activity_at = now(), updated_at = now()
    where id = p_room;
    return true;
  end if;
  update public.rooms set version = version + 1,
    last_activity_at = now(), updated_at = now() where id = p_room;
  return false;
end; $$;

create function public.online_heartbeat(p_room uuid, p_user uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_room public.rooms%rowtype;
begin
  select * into v_room from public.rooms where id = p_room for update;
  if not found or (v_room.host_user_id is distinct from p_user and v_room.guest_user_id is distinct from p_user) then
    raise exception 'Room unavailable' using errcode = 'P0001';
  end if;
  if v_room.status = 'closed' then return; end if;
  if v_room.last_activity_at < now() - interval '30 minutes' or
     (v_room.guest_user_id is not null and
      (v_room.host_seen_at < now() - interval '60 seconds' or
       v_room.guest_seen_at < now() - interval '60 seconds')) then
    update public.rooms set status = 'closed', version = version + 1,
      updated_at = now() where id = p_room;
    return;
  end if;
  if v_room.host_user_id = p_user then
    update public.rooms set host_seen_at = now(), last_activity_at = now() where id = p_room;
  else
    update public.rooms set guest_seen_at = now(), last_activity_at = now() where id = p_room;
  end if;
end; $$;

create function public.online_leave_room(p_room uuid, p_user uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.rooms set status = 'closed', version = version + 1,
    updated_at = now(), last_activity_at = now()
  where id = p_room and (host_user_id = p_user or guest_user_id = p_user);
end; $$;

revoke all on function public.online_create_room(text, text, uuid) from public, anon, authenticated;
revoke all on function public.online_join_room(text, text, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.online_commit_move(uuid, uuid, uuid, integer, jsonb, jsonb, integer, jsonb) from public, anon, authenticated;
revoke all on function public.online_request_rematch(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.online_heartbeat(uuid, uuid) from public, anon, authenticated;
revoke all on function public.online_leave_room(uuid, uuid) from public, anon, authenticated;
grant execute on function public.online_create_room(text, text, uuid) to service_role;
grant execute on function public.online_join_room(text, text, uuid, jsonb) to service_role;
grant execute on function public.online_commit_move(uuid, uuid, uuid, integer, jsonb, jsonb, integer, jsonb) to service_role;
grant execute on function public.online_request_rematch(uuid, uuid, jsonb) to service_role;
grant execute on function public.online_heartbeat(uuid, uuid) to service_role;
grant execute on function public.online_leave_room(uuid, uuid) to service_role;
