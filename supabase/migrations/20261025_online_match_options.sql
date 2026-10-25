-- Dama Pinoy v2.1: online host color, match formats, and series play.
-- Apply after 20261024_online_single.sql. Writes remain service-role only.

alter table public.rooms
  add column if not exists current_series_number integer not null default 1,
  add column if not exists host_score integer not null default 0,
  add column if not exists guest_score integer not null default 0,
  add column if not exists draws integer not null default 0,
  add column if not exists match_winner_user_id uuid;

alter table public.rooms drop constraint if exists rooms_series_format_check;
alter table public.rooms add constraint rooms_series_format_check
  check (series_format in ('single', 'bestOfThree', 'bestOfFive', 'bestOfNine'));

-- Older rooms could contain unlimited single-game rematches. They cannot be
-- represented as one series, so close them without exposing a partial game.
update public.rooms
set status = 'closed', guest_user_id = null, current_game_number = 1,
    host_score = 0, guest_score = 0, draws = 0, match_winner_user_id = null,
    rematch_host = false, rematch_guest = false
where current_game_number > 1;

alter table public.rooms drop constraint if exists rooms_current_series_number_check;
alter table public.rooms add constraint rooms_current_series_number_check
  check (current_series_number > 0);
alter table public.rooms drop constraint if exists rooms_host_score_check;
alter table public.rooms add constraint rooms_host_score_check
  check (host_score between 0 and 9);
alter table public.rooms drop constraint if exists rooms_guest_score_check;
alter table public.rooms add constraint rooms_guest_score_check
  check (guest_score between 0 and 9);
alter table public.rooms drop constraint if exists rooms_draws_check;
alter table public.rooms add constraint rooms_draws_check
  check (draws between 0 and 9);
alter table public.rooms drop constraint if exists rooms_match_winner_check;
alter table public.rooms add constraint rooms_match_winner_check
  check (match_winner_user_id is null or match_winner_user_id = host_user_id
    or match_winner_user_id = guest_user_id);

update public.rooms r set
  host_score = coalesce((select sum(mr.host_score) from public.match_results mr
    where mr.room_id = r.id), 0),
  guest_score = coalesce((select sum(mr.guest_score) from public.match_results mr
    where mr.room_id = r.id), 0),
  draws = coalesce((select sum(mr.draws) from public.match_results mr
    where mr.room_id = r.id), 0),
  match_winner_user_id = (select mr.winner_user_id from public.match_results mr
    where mr.room_id = r.id and mr.winner_user_id is not null
    order by mr.created_at desc limit 1)
where r.guest_user_id is not null;

alter table public.games
  add column if not exists series_number integer not null default 1,
  add column if not exists host_color text,
  add column if not exists guest_color text;

update public.games g set
  host_color = r.host_color,
  guest_color = r.guest_color
from public.rooms r
where r.id = g.room_id and (g.host_color is null or g.guest_color is null);

alter table public.games alter column host_color set not null;
alter table public.games alter column guest_color set not null;
alter table public.games drop constraint if exists games_room_id_game_number_key;
do $$
declare v_constraint text;
begin
  select conname into v_constraint
  from pg_constraint
  where conrelid = 'public.games'::regclass and contype = 'u'
    and conkey = array[
      (select attnum from pg_attribute
        where attrelid = 'public.games'::regclass and attname = 'room_id'),
      (select attnum from pg_attribute
        where attrelid = 'public.games'::regclass and attname = 'game_number')
    ]::smallint[];
  if v_constraint is not null then
    execute format('alter table public.games drop constraint %I', v_constraint);
  end if;
end $$;
alter table public.games drop constraint if exists games_room_series_game_key;
alter table public.games add constraint games_room_series_game_key
  unique (room_id, series_number, game_number);
alter table public.games drop constraint if exists games_series_number_check;
alter table public.games add constraint games_series_number_check
  check (series_number > 0);
alter table public.games drop constraint if exists games_colors_check;
alter table public.games add constraint games_colors_check
  check (host_color in ('R', 'B') and guest_color in ('R', 'B')
    and host_color <> guest_color);

alter table public.match_results
  add column if not exists winner_color text;

update public.match_results mr set winner_color = g.winner_color
from public.games g where g.id = mr.game_id and mr.winner_color is null;

alter table public.match_results drop constraint if exists match_results_series_format_check;
alter table public.match_results add constraint match_results_series_format_check
  check (series_format in ('single', 'bestOfThree', 'bestOfFive', 'bestOfNine'));
alter table public.match_results drop constraint if exists match_results_winner_color_check;
alter table public.match_results add constraint match_results_winner_color_check
  check (winner_color is null or winner_color in ('R', 'B'));

drop function if exists public.online_create_room(text, text, uuid);

create function public.online_create_room(
  p_code text, p_name text, p_user uuid,
  p_color text default 'R', p_format text default 'single'
) returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if p_color not in ('R', 'B') or
     p_format not in ('single', 'bestOfThree', 'bestOfFive', 'bestOfNine') then
    raise exception 'Invalid room options' using errcode = 'P0001';
  end if;
  insert into public.rooms (room_code, host_name, host_user_id,
    host_color, guest_color, series_format)
  values (p_code, p_name, p_user, p_color,
    case when p_color = 'R' then 'B' else 'R' end, p_format)
  returning id into v_id;
  return v_id;
end; $$;

create or replace function public.online_join_room(
  p_code text, p_name text, p_user uuid, p_board jsonb
) returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_room public.rooms%rowtype;
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
  insert into public.games (room_id, series_number, game_number,
    host_color, guest_color, board)
  values (v_room.id, v_room.current_series_number, v_room.current_game_number,
    v_room.host_color, v_room.guest_color, p_board);
  return v_room.id;
end; $$;

create or replace function public.online_commit_move(
  p_room uuid, p_game uuid, p_user uuid, p_expected_count integer,
  p_move jsonb, p_board jsonb, p_quiet integer, p_result jsonb
) returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_room public.rooms%rowtype;
  v_game public.games%rowtype;
  v_owner_color text;
  v_winner text;
  v_host_point integer := 0;
  v_guest_point integer := 0;
  v_draw_point integer := 0;
  v_limit integer;
  v_majority integer;
  v_total integer;
  v_host_score integer;
  v_guest_score integer;
  v_draws integer;
  v_match_finished boolean := false;
  v_match_winner uuid;
begin
  select * into v_room from public.rooms where id = p_room for update;
  if not found or v_room.status <> 'active' or v_room.guest_user_id is null or
     v_room.last_activity_at < now() - interval '30 minutes' or
     (v_room.host_user_id is distinct from p_user and v_room.guest_user_id is distinct from p_user) then
    raise exception 'Room or turn unavailable' using errcode = 'P0001';
  end if;
  select * into v_game from public.games
    where id = p_game and room_id = p_room
      and series_number = v_room.current_series_number
      and game_number = v_room.current_game_number for update;
  if not found or v_game.status <> 'active' or v_game.move_count <> p_expected_count then
    raise exception 'Stale or invalid move' using errcode = 'P0001';
  end if;
  v_owner_color := case when v_room.host_user_id = p_user
    then v_game.host_color else v_game.guest_color end;
  if v_owner_color <> v_room.current_turn or
     (p_move->>'playerColor') <> v_room.current_turn then
    raise exception 'Room or turn unavailable' using errcode = 'P0001';
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
    move_count = move_count + 1,
    status = case when p_result is null then 'active' else 'finished' end,
    winner_color = v_winner, result_reason = p_result->>'reason', updated_at = now()
  where id = p_game;

  v_host_score := v_room.host_score;
  v_guest_score := v_room.guest_score;
  v_draws := v_room.draws;
  if p_result is not null then
    v_host_point := case when v_winner = v_game.host_color then 1 else 0 end;
    v_guest_point := case when v_winner = v_game.guest_color then 1 else 0 end;
    v_draw_point := case when v_winner is null then 1 else 0 end;
    v_host_score := v_host_score + v_host_point;
    v_guest_score := v_guest_score + v_guest_point;
    v_draws := v_draws + v_draw_point;
    v_limit := case v_room.series_format
      when 'bestOfThree' then 3 when 'bestOfFive' then 5
      when 'bestOfNine' then 9 else 1 end;
    v_majority := (v_limit / 2) + 1;
    v_total := v_host_score + v_guest_score + v_draws;
    if v_host_score >= v_majority or v_guest_score >= v_majority or
       v_total >= v_limit then
      v_match_finished := true;
      if v_host_score > v_guest_score then
        v_match_winner := v_room.host_user_id;
      elsif v_guest_score > v_host_score then
        v_match_winner := v_room.guest_user_id;
      end if;
    end if;
    insert into public.match_results (room_id, game_id, series_format,
      winner_user_id, winner_name, host_score, guest_score, draws, winner_color)
    values (p_room, p_game, v_room.series_format,
      case when v_winner is null then null
        when v_winner = v_game.host_color then v_room.host_user_id
        else v_room.guest_user_id end,
      case when v_winner is null then null
        when v_winner = v_game.host_color then v_room.host_name
        else v_room.guest_name end,
      v_host_point, v_guest_point, v_draw_point, v_winner);
  end if;

  update public.rooms set
    current_turn = case when current_turn = 'R' then 'B' else 'R' end,
    status = case when p_result is null then 'active'
      when v_match_finished then 'finished' else 'active' end,
    host_score = v_host_score, guest_score = v_guest_score, draws = v_draws,
    match_winner_user_id = case when p_result is null
      then match_winner_user_id else v_match_winner end,
    version = version + 1, last_activity_at = now(), updated_at = now()
  where id = p_room;
end; $$;

create or replace function public.online_request_rematch(
  p_room uuid, p_user uuid, p_board jsonb
) returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_room public.rooms%rowtype;
  v_game public.games%rowtype;
  v_next_host text;
  v_next_guest text;
begin
  select * into v_room from public.rooms where id = p_room for update;
  if not found or v_room.status not in ('active', 'finished') or
     v_room.guest_user_id is null or
     (v_room.host_user_id is distinct from p_user and v_room.guest_user_id is distinct from p_user) then
    raise exception 'Rematch unavailable' using errcode = 'P0001';
  end if;
  select * into v_game from public.games
    where room_id = p_room and series_number = v_room.current_series_number
      and game_number = v_room.current_game_number for update;
  if not found or v_game.status <> 'finished' then
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
    if v_room.status = 'finished' then
      insert into public.games (room_id, series_number, game_number,
        host_color, guest_color, board)
      values (p_room, v_room.current_series_number + 1, 1,
        v_room.host_color, v_room.guest_color, p_board);
      update public.rooms set status = 'active',
        current_series_number = current_series_number + 1,
        current_game_number = 1, current_turn = 'R',
        host_score = 0, guest_score = 0, draws = 0,
        match_winner_user_id = null,
        rematch_host = false, rematch_guest = false,
        version = version + 1, last_activity_at = now(), updated_at = now()
      where id = p_room;
    else
      v_next_host := v_game.guest_color;
      v_next_guest := v_game.host_color;
      insert into public.games (room_id, series_number, game_number,
        host_color, guest_color, board)
      values (p_room, v_room.current_series_number,
        v_room.current_game_number + 1, v_next_host, v_next_guest, p_board);
      update public.rooms set status = 'active',
        current_game_number = current_game_number + 1, current_turn = 'R',
        rematch_host = false, rematch_guest = false,
        version = version + 1, last_activity_at = now(), updated_at = now()
      where id = p_room;
    end if;
    return true;
  end if;
  update public.rooms set version = version + 1,
    last_activity_at = now(), updated_at = now() where id = p_room;
  return false;
end; $$;

revoke all on function public.online_create_room(text, text, uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.online_join_room(text, text, uuid, jsonb)
  from public, anon, authenticated;
revoke all on function public.online_commit_move(uuid, uuid, uuid, integer, jsonb, jsonb, integer, jsonb)
  from public, anon, authenticated;
revoke all on function public.online_request_rematch(uuid, uuid, jsonb)
  from public, anon, authenticated;
revoke all on function public.online_heartbeat(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.online_leave_room(uuid, uuid)
  from public, anon, authenticated;

grant execute on function public.online_create_room(text, text, uuid, text, text)
  to service_role;
grant execute on function public.online_join_room(text, text, uuid, jsonb)
  to service_role;
grant execute on function public.online_commit_move(uuid, uuid, uuid, integer, jsonb, jsonb, integer, jsonb)
  to service_role;
grant execute on function public.online_request_rematch(uuid, uuid, jsonb)
  to service_role;
grant execute on function public.online_heartbeat(uuid, uuid)
  to service_role;
grant execute on function public.online_leave_room(uuid, uuid)
  to service_role;
