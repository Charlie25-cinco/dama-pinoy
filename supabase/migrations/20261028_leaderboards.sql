-- v2.5: opt-in public leaderboards.
-- Counters are a projection of the server-recorded verified results
-- (account_game_results / account_series_results), so local games, AI games,
-- replays, and client-submitted values can never reach a ranking.
create table public.leaderboard_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (display_name = btrim(display_name) and
    char_length(display_name) between 1 and 20 and display_name !~ '[[:cntrl:]<>]'),
  visible boolean not null default false,
  total_games integer not null default 0 check (total_games >= 0),
  total_wins integer not null default 0 check (total_wins >= 0),
  total_losses integer not null default 0 check (total_losses >= 0),
  total_draws integer not null default 0 check (total_draws >= 0),
  current_win_streak integer not null default 0 check (current_win_streak >= 0),
  longest_win_streak integer not null default 0 check (longest_win_streak >= 0),
  best_of_3_wins integer not null default 0 check (best_of_3_wins >= 0),
  best_of_5_wins integer not null default 0 check (best_of_5_wins >= 0),
  best_of_9_wins integer not null default 0 check (best_of_9_wins >= 0),
  last_active_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.leaderboard_profiles enable row level security;
revoke all on public.leaderboard_profiles from public, anon, authenticated;
-- Opt-in is the only client-writable column; every counter stays server-only.
grant select on public.leaderboard_profiles to authenticated;
grant update (visible) on public.leaderboard_profiles to authenticated;
grant all on public.leaderboard_profiles to service_role;
create policy "Read visible leaderboard rows" on public.leaderboard_profiles
  for select to authenticated using (visible or user_id = auth.uid());
create policy "Toggle own leaderboard visibility" on public.leaderboard_profiles
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create trigger leaderboard_timestamp before update on public.leaderboard_profiles
  for each row execute function public.online_profile_stamp();

create index leaderboard_visible_wins on public.leaderboard_profiles (total_wins desc, total_games desc)
  where visible;
create index leaderboard_visible_streak on public.leaderboard_profiles (current_win_streak desc, total_wins desc)
  where visible;
create index account_game_results_user_time on public.account_game_results (user_id, created_at, game_id);
create index account_series_results_user_format on public.account_series_results (user_id, series_format, outcome);

-- Recompute (never increment) so repeated or replayed results cannot double count.
create function public.leaderboard_refresh(p_user uuid) returns void language plpgsql
security definer set search_path = public, pg_temp as $$
declare
  v_name text;
  v_games integer; v_wins integer; v_losses integer; v_draws integer;
  v_current integer; v_longest integer;
  v_bo3 integer; v_bo5 integer; v_bo9 integer;
  v_last timestamptz;
begin
  select display_name into v_name from public.profiles where id = p_user;
  -- Guests have no profile row and are never ranked.
  if v_name is null then return; end if;
  select count(*),
         count(*) filter (where outcome = 'win'),
         count(*) filter (where outcome = 'loss'),
         count(*) filter (where outcome = 'draw'),
         max(created_at)
    into v_games, v_wins, v_losses, v_draws, v_last
    from public.account_game_results where user_id = p_user;
  with ordered as (
    select outcome, row_number() over (order by created_at, game_id) as rn
    from public.account_game_results where user_id = p_user
  ), runs as (
    select outcome, rn - row_number() over (partition by outcome order by rn) as island, rn
    from ordered
  ), streaks as (
    select outcome, count(*) as run_length, max(rn) as last_rn from runs group by outcome, island
  )
  select coalesce(max(run_length) filter (where outcome = 'win'), 0),
         coalesce(max(run_length) filter (where outcome = 'win'
           and last_rn = (select max(rn) from ordered)), 0)
    into v_longest, v_current
    from streaks;
  select count(*) filter (where outcome = 'win' and series_format = 'bestOfThree'),
         count(*) filter (where outcome = 'win' and series_format = 'bestOfFive'),
         count(*) filter (where outcome = 'win' and series_format = 'bestOfNine')
    into v_bo3, v_bo5, v_bo9
    from public.account_series_results where user_id = p_user;
  insert into public.leaderboard_profiles as lp (user_id, display_name, total_games, total_wins,
    total_losses, total_draws, current_win_streak, longest_win_streak,
    best_of_3_wins, best_of_5_wins, best_of_9_wins, last_active_at)
  values (p_user, v_name, v_games, v_wins, v_losses, v_draws, v_current, v_longest,
    v_bo3, v_bo5, v_bo9, coalesce(v_last, now()))
  on conflict (user_id) do update set
    display_name = excluded.display_name,
    total_games = excluded.total_games,
    total_wins = excluded.total_wins,
    total_losses = excluded.total_losses,
    total_draws = excluded.total_draws,
    current_win_streak = excluded.current_win_streak,
    longest_win_streak = excluded.longest_win_streak,
    best_of_3_wins = excluded.best_of_3_wins,
    best_of_5_wins = excluded.best_of_5_wins,
    best_of_9_wins = excluded.best_of_9_wins,
    last_active_at = greatest(lp.last_active_at, excluded.last_active_at);
end; $$;
revoke all on function public.leaderboard_refresh(uuid) from public, anon, authenticated;

create function public.leaderboard_record() returns trigger language plpgsql
security definer set search_path = public, pg_temp as $$
begin
  perform public.leaderboard_refresh(new.user_id);
  return new;
end; $$;
revoke all on function public.leaderboard_record() from public, anon, authenticated;
create trigger leaderboard_game_result after insert on public.account_game_results
  for each row execute function public.leaderboard_record();
create trigger leaderboard_series_result after insert on public.account_series_results
  for each row execute function public.leaderboard_record();

create function public.leaderboard_profile_created() returns trigger language plpgsql
security definer set search_path = public, pg_temp as $$
begin
  perform public.leaderboard_refresh(new.id);
  return new;
end; $$;
revoke all on function public.leaderboard_profile_created() from public, anon, authenticated;
create trigger leaderboard_profile_insert after insert on public.profiles
  for each row execute function public.leaderboard_profile_created();

create function public.leaderboard_name_sync() returns trigger language plpgsql
security definer set search_path = public, pg_temp as $$
begin
  update public.leaderboard_profiles set display_name = new.display_name where user_id = new.id;
  return new;
end; $$;
revoke all on function public.leaderboard_name_sync() from public, anon, authenticated;
create trigger leaderboard_profile_name after update of display_name on public.profiles
  for each row execute function public.leaderboard_name_sync();

-- One read for every board, with the caller's own rank when it qualifies.
create function public.leaderboard_page(p_board text, p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_rows jsonb;
  v_me jsonb;
  v_self jsonb;
begin
  if p_board is null or p_board not in ('wins', 'win_rate', 'bo3', 'bo5', 'bo9', 'streak') then
    raise exception 'Unknown leaderboard type';
  end if;
  with base as (
    select lp.user_id, lp.display_name, lp.total_wins, lp.total_games, lp.total_losses,
           lp.total_draws, lp.current_win_streak, lp.longest_win_streak,
           lp.best_of_3_wins, lp.best_of_5_wins, lp.best_of_9_wins, lp.last_active_at,
           round(100.0 * lp.total_wins / nullif(lp.total_games, 0), 1) as win_rate,
           case p_board
             when 'wins' then lp.total_wins::numeric
             when 'win_rate' then coalesce(100.0 * lp.total_wins / nullif(lp.total_games, 0), 0)
             when 'bo3' then lp.best_of_3_wins::numeric
             when 'bo5' then lp.best_of_5_wins::numeric
             when 'bo9' then lp.best_of_9_wins::numeric
             else lp.current_win_streak::numeric
           end as metric
    from public.leaderboard_profiles lp
    where lp.visible and (p_board <> 'win_rate' or lp.total_games >= 10)
  ), ranked as (
    select base.*,
           row_number() over (order by metric desc, total_wins desc, last_active_at asc,
              display_name asc, user_id asc) as rank
    from base
  )
  select coalesce(jsonb_agg(to_jsonb(ranked) order by rank) filter (where rank <= v_limit), '[]'::jsonb),
         (select to_jsonb(me) from ranked me where me.user_id = auth.uid())
    into v_rows, v_me from ranked;
  select to_jsonb(self) into v_self
    from (select user_id, display_name, visible, total_games, total_wins, total_losses,
                 total_draws, current_win_streak, longest_win_streak, best_of_3_wins,
                 best_of_5_wins, best_of_9_wins, last_active_at
          from public.leaderboard_profiles where user_id = auth.uid()) self;
  return jsonb_build_object('board', p_board, 'rows', v_rows, 'me', v_me,
    'self', v_self, 'visible', coalesce((v_self->>'visible')::boolean, false));
end; $$;
revoke all on function public.leaderboard_page(text, integer) from public, anon;
grant execute on function public.leaderboard_page(text, integer) to authenticated;

insert into public.leaderboard_profiles (user_id, display_name)
  select id, display_name from public.profiles on conflict (user_id) do nothing;
select public.leaderboard_refresh(id) from public.profiles;
