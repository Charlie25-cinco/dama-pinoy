-- v2.6: server-owned single-elimination tournaments. No client result writes.
create table public.tournaments (
  id uuid primary key default gen_random_uuid(),
  name text not null check (name=btrim(name) and char_length(name) between 1 and 60 and name !~ '[[:cntrl:]<>]'),
  creator_id uuid references auth.users(id) on delete set null,
  creator_name text not null,
  bracket_size integer not null check(bracket_size in (4,8,16)),
  series_format text not null check(series_format in ('single','bestOfThree','bestOfFive','bestOfNine')),
  status text not null default 'open' check(status in ('open','active','completed','cancelled')),
  winner_id uuid references auth.users(id) on delete set null,
  winner_name text,
  slots integer, current_round integer not null default 0,
  created_at timestamptz not null default now(), started_at timestamptz, completed_at timestamptz
);
create table public.tournament_participants (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  display_name text not null, seed integer,
  eliminated boolean not null default false, withdrawn boolean not null default false,
  active boolean not null default false,
  joined_at timestamptz not null default now(), unique(tournament_id,user_id)
);
-- Enforced even across concurrent starts of two different tournaments.
create unique index tournament_one_active on public.tournament_participants(user_id) where active and user_id is not null;
create table public.tournament_matches (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  round integer not null check(round>0), match_number integer not null check(match_number>0),
  player1_id uuid references auth.users(id) on delete set null,
  player2_id uuid references auth.users(id) on delete set null,
  winner_id uuid references auth.users(id) on delete set null,
  room_id uuid unique references public.rooms(id) on delete set null,
  player1_name text, player2_name text, winner_name text,
  game_id uuid references public.games(id) on delete set null,
  status text not null default 'pending' check(status in ('pending','active','completed')),
  reason text, ready1 boolean not null default false, ready2 boolean not null default false,
  ready_deadline timestamptz not null default (now()+interval '10 minutes'),
  created_at timestamptz not null default now(), completed_at timestamptz,
  unique(tournament_id,round,match_number), check(player1_id is null or player2_id is null or player1_id<>player2_id)
);
-- Private bounded counters, not browser cooldowns, enforce creation/join limits.
create table public.tournament_limits (
  user_id uuid primary key references auth.users(id) on delete cascade,
  create_at timestamptz not null default now(), creates integer not null default 0,
  join_at timestamptz not null default now(), joins integer not null default 0
);
create index tournament_open_recent on public.tournaments(status,created_at desc);
create index tournament_participant_user on public.tournament_participants(user_id,tournament_id);
create index tournament_due on public.tournament_matches(status,ready_deadline);
alter table public.tournaments enable row level security;
alter table public.tournament_participants enable row level security;
alter table public.tournament_matches enable row level security;
alter table public.tournament_limits enable row level security;
revoke all on public.tournaments,public.tournament_participants,public.tournament_matches,public.tournament_limits from public,anon,authenticated;
grant select on public.tournaments,public.tournament_participants,public.tournament_matches to authenticated;
grant all on public.tournaments,public.tournament_participants,public.tournament_matches,public.tournament_limits to service_role;
create policy "Read public tournament info" on public.tournaments for select to authenticated using(true);
create policy "Read public bracket names" on public.tournament_participants for select to authenticated using(true);
create policy "Read public pairings" on public.tournament_matches for select to authenticated using(true);

-- Name snapshots distinguish a deleted seat from an original empty bye slot.
create function public.tournament_match_names() returns trigger language plpgsql
security definer set search_path=public,pg_temp as $$
begin
  if new.player1_id is not null then
    new.player1_name:=coalesce((select display_name from public.tournament_participants where tournament_id=new.tournament_id and user_id=new.player1_id),new.player1_name,'Deleted player');
  end if;
  if new.player2_id is not null then
    new.player2_name:=coalesce((select display_name from public.tournament_participants where tournament_id=new.tournament_id and user_id=new.player2_id),new.player2_name,'Deleted player');
  end if;
  if new.winner_id is not null then
    new.winner_name:=coalesce((select display_name from public.tournament_participants where tournament_id=new.tournament_id and user_id=new.winner_id),new.winner_name,'Deleted player');
  end if;
  return new;
end $$;
create trigger tournament_names before insert or update of player1_id,player2_id,winner_id on public.tournament_matches
  for each row execute function public.tournament_match_names();

create function public.tournament_account(p_user uuid) returns text language plpgsql
security definer set search_path=public,pg_temp as $$
declare label text;
begin
  select p.display_name into label from public.profiles p join auth.users u on u.id=p.id
    where p.id=p_user and u.is_anonymous is not true;
  if label is null then raise exception 'Tournament: Log in with a permanent account.'; end if;
  return label;
end $$;

create function public.tournament_rate(p_user uuid,p_create boolean) returns void language plpgsql
security definer set search_path=public,pg_temp as $$
declare v public.tournament_limits;
begin
  insert into public.tournament_limits(user_id) values(p_user) on conflict do nothing;
  select * into v from public.tournament_limits where user_id=p_user for update;
  if p_create then
    if v.create_at<=now()-interval '1 hour' then v.creates:=0; v.create_at:=now(); end if;
    if v.creates>=5 then raise exception 'Tournament: Creation limit reached. Try again in an hour.'; end if;
    update public.tournament_limits set creates=v.creates+1,create_at=v.create_at where user_id=p_user;
  else
    if v.join_at<=now()-interval '1 minute' then v.joins:=0; v.join_at:=now(); end if;
    if v.joins>=20 then raise exception 'Tournament: Join limit reached. Try again in a minute.'; end if;
    update public.tournament_limits set joins=v.joins+1,join_at=v.join_at where user_id=p_user;
  end if;
end $$;

create function public.tournament_create(p_user uuid,p_name text,p_size integer,p_format text)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare label text; tid uuid;
begin
  label:=public.tournament_account(p_user);
  perform public.tournament_rate(p_user,true);
  insert into public.tournaments(name,creator_id,creator_name,bracket_size,series_format)
    values(btrim(p_name),p_user,label,p_size,p_format) returning id into tid;
  insert into public.tournament_participants(tournament_id,user_id,display_name) values(tid,p_user,label);
  return tid;
end $$;

-- Called under the tournament lock; no unfinished feeder may advance.
create function public.tournament_advance(p_tournament uuid) returns void language plpgsql
security definer set search_path=public,pg_temp as $$
declare t public.tournaments; m public.tournament_matches; ids uuid[]; i integer; winner uuid;
begin
  select * into t from public.tournaments where id=p_tournament for update;
  if t.status<>'active' then return; end if;
  loop
    if exists(select 1 from public.tournament_matches where tournament_id=t.id and round=t.current_round and status<>'completed') then return; end if;
    select array_agg(winner_id order by match_number) into ids from public.tournament_matches
      where tournament_id=t.id and round=t.current_round;
    if cardinality(ids)=1 then
      winner:=ids[1];
      update public.tournaments set status='completed',winner_id=winner,
        winner_name=(select display_name from public.tournament_participants where tournament_id=t.id and user_id=winner),
        completed_at=now() where id=t.id;
      update public.tournament_participants set active=false where tournament_id=t.id;
      return;
    end if;
    if ids is null then return; end if;
    t.current_round:=t.current_round+1;
    update public.tournaments set current_round=t.current_round where id=t.id;
    for i in 1..cardinality(ids)/2 loop
      -- A withdrawn/deleted feeder winner cannot come back into the bracket.
      if not exists(select 1 from public.tournament_participants where tournament_id=t.id and user_id=ids[2*i-1] and not withdrawn) then ids[2*i-1]:=null; end if;
      if not exists(select 1 from public.tournament_participants where tournament_id=t.id and user_id=ids[2*i] and not withdrawn) then ids[2*i]:=null; end if;
      insert into public.tournament_matches(tournament_id,round,match_number,player1_id,player2_id)
        values(t.id,t.current_round,i,ids[2*i-1],ids[2*i]) returning * into m;
      if m.player1_id is null or m.player2_id is null then
        update public.tournament_matches set status='completed',winner_id=coalesce(player1_id,player2_id),
          reason='bye',completed_at=now() where id=m.id;
      end if;
    end loop;
  end loop;
end $$;

create function public.tournament_finish(p_match uuid,p_winner uuid,p_reason text,p_game uuid default null)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare m public.tournament_matches;
begin
  select * into m from public.tournament_matches where id=p_match;
  perform 1 from public.tournaments where id=m.tournament_id for update;
  select * into m from public.tournament_matches where id=p_match for update;
  if m.status='completed' then return; end if;
  if p_winner is not null and p_winner is distinct from m.player1_id and p_winner is distinct from m.player2_id then
    raise exception 'Tournament: Invalid winner.';
  end if;
  update public.tournament_matches set status='completed',winner_id=p_winner,reason=p_reason,
    game_id=p_game,completed_at=now() where id=m.id;
  update public.tournament_participants set eliminated=true
    where tournament_id=m.tournament_id and user_id in (m.player1_id,m.player2_id) and user_id is distinct from p_winner;
  perform public.tournament_advance(m.tournament_id);
end $$;

create function public.tournament_join(p_user uuid,p_tournament uuid) returns void language plpgsql
security definer set search_path=public,pg_temp as $$
declare t public.tournaments; label text;
begin
  label:=public.tournament_account(p_user);
  perform public.tournament_rate(p_user,false);
  select * into t from public.tournaments where id=p_tournament for update;
  if not found or t.status<>'open' then raise exception 'Tournament: Joining is closed.'; end if;
  if exists(select 1 from public.tournament_participants where tournament_id=t.id and user_id=p_user) then
    raise exception 'Tournament: You already joined.'; end if;
  if (select count(*) from public.tournament_participants where tournament_id=t.id)>=t.bracket_size then
    raise exception 'Tournament: Tournament is full.'; end if;
  insert into public.tournament_participants(tournament_id,user_id,display_name) values(t.id,p_user,label);
end $$;

create function public.tournament_edit(p_user uuid,p_tournament uuid,p_name text,p_size integer,p_format text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare t public.tournaments;
begin
  perform public.tournament_account(p_user);
  select * into t from public.tournaments where id=p_tournament for update;
  if not found or t.status<>'open' or t.creator_id is distinct from p_user then
    raise exception 'Tournament: Only the creator can edit an open tournament.'; end if;
  if p_size<(select count(*) from public.tournament_participants where tournament_id=t.id) then
    raise exception 'Tournament: Bracket size is smaller than the participant list.'; end if;
  update public.tournaments set name=btrim(p_name),bracket_size=p_size,series_format=p_format where id=t.id;
end $$;

create function public.tournament_start(p_user uuid,p_tournament uuid) returns void language plpgsql
security definer set search_path=public,pg_temp as $$
declare t public.tournaments; n integer; size integer:=2; seeds integer[]:=array[1,2]; next_seeds integer[];
  k integer; i integer; a uuid; b uuid;
begin
  perform public.tournament_account(p_user);
  select * into t from public.tournaments where id=p_tournament for update;
  if not found or t.status<>'open' or t.creator_id is distinct from p_user then raise exception 'Tournament: Only the creator can start an open tournament.'; end if;
  select count(*) into n from public.tournament_participants where tournament_id=t.id;
  if n<2 then raise exception 'Tournament: At least two players are needed.'; end if;
  if exists(select 1 from public.tournament_participants p join public.tournament_participants q on q.user_id=p.user_id and q.active
    where p.tournament_id=t.id) then raise exception 'Tournament: A participant already has an active tournament.'; end if;
  while size<n loop
    size:=size*2; next_seeds:=array[]::integer[];
    foreach k in array seeds loop next_seeds:=next_seeds||array[k,size+1-k]; end loop;
    seeds:=next_seeds;
  end loop;
  with shuffled as (select id,row_number() over(order by random(),id) as seed from public.tournament_participants where tournament_id=t.id)
    update public.tournament_participants p set seed=s.seed,active=true from shuffled s where p.id=s.id;
  update public.tournaments set status='active',slots=size,current_round=1,started_at=now() where id=t.id;
  for i in 1..size/2 loop
    select user_id into a from public.tournament_participants where tournament_id=t.id and seed=seeds[2*i-1];
    select user_id into b from public.tournament_participants where tournament_id=t.id and seed=seeds[2*i];
    insert into public.tournament_matches(tournament_id,round,match_number,player1_id,player2_id,status,winner_id,reason,completed_at)
      values(t.id,1,i,a,b,case when a is null or b is null then 'completed' else 'pending' end,
        case when a is null or b is null then coalesce(a,b) end,
        case when a is null or b is null then 'bye' end,case when a is null or b is null then now() end);
  end loop;
  perform public.tournament_advance(t.id);
exception when unique_violation then raise exception 'Tournament: A participant already has an active tournament.';
end $$;

create function public.tournament_ready(p_user uuid,p_match uuid,p_board jsonb) returns uuid language plpgsql
security definer set search_path=public,pg_temp as $$
declare m public.tournament_matches; t public.tournaments; rid uuid; code text; color text; attempt integer;
begin
  perform public.tournament_account(p_user);
  select * into m from public.tournament_matches where id=p_match;
  select * into t from public.tournaments where id=m.tournament_id for update;
  select * into m from public.tournament_matches where id=p_match for update;
  if not found or t.status<>'active' or (p_user is distinct from m.player1_id and p_user is distinct from m.player2_id) then
    raise exception 'Tournament: This is not your assigned match.'; end if;
  if m.status='active' then return m.room_id; end if;
  if m.status<>'pending' or m.ready_deadline<=now() then raise exception 'Tournament: Ready deadline expired.'; end if;
  if exists(select 1 from public.rooms where status in ('active','waiting') and
    (host_user_id=p_user or guest_user_id=p_user)) then raise exception 'Tournament: Leave your other online room first.'; end if;
  if m.player1_id=p_user then m.ready1:=true; else m.ready2:=true; end if;
  update public.tournament_matches set ready1=m.ready1,ready2=m.ready2 where id=m.id;
  if not (m.ready1 and m.ready2) then return null; end if;
  if exists(select 1 from public.rooms where status in ('active','waiting') and
    (host_user_id in (m.player1_id,m.player2_id) or guest_user_id in (m.player1_id,m.player2_id))) then
    raise exception 'Tournament: Both players must leave other online rooms first.'; end if;
  color:=case when random()<0.5 then 'R' else 'B' end;
  for attempt in 1..8 loop
    code:=(select string_agg(substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789',1+floor(random()*30)::integer,1),'') from generate_series(1,6));
    begin
      insert into public.rooms(room_code,status,series_format,host_user_id,guest_user_id,host_name,guest_name,host_color,guest_color,guest_seen_at)
        select code,'active',t.series_format,m.player1_id,m.player2_id,a.display_name,b.display_name,color,
          case when color='R' then 'B' else 'R' end,now()
        from public.tournament_participants a,public.tournament_participants b
        where a.tournament_id=t.id and a.user_id=m.player1_id and b.tournament_id=t.id and b.user_id=m.player2_id
        returning id into rid;
      exit;
    exception when unique_violation then if attempt=8 then raise; end if;
    end;
  end loop;
  insert into public.games(room_id,game_number,host_color,guest_color,board)
    values(rid,1,color,case when color='R' then 'B' else 'R' end,p_board);
  update public.tournament_matches set status='active',room_id=rid where id=m.id;
  return rid;
end $$;

create function public.tournament_view(p_user uuid,p_tournament uuid default null) returns jsonb
language sql stable security definer set search_path=public,pg_temp as $$
  select case when p_tournament is null then jsonb_build_object(
    'open',coalesce((select jsonb_agg(to_jsonb(t) order by t.created_at desc) from
      (select * from public.tournaments where status='open' order by created_at desc limit 50) t),'[]'::jsonb),
    'mine',coalesce((select jsonb_agg(to_jsonb(t) order by t.created_at desc) from
      (select * from public.tournaments t where creator_id=p_user or exists
        (select 1 from public.tournament_participants p where p.tournament_id=t.id and p.user_id=p_user)
        order by created_at desc limit 50) t),'[]'::jsonb))
  else jsonb_build_object('tournament',(select to_jsonb(t) from public.tournaments t where id=p_tournament),
    'participants',coalesce((select jsonb_agg(to_jsonb(p) order by p.seed nulls last,p.joined_at,p.id)
      from public.tournament_participants p where p.tournament_id=p_tournament),'[]'::jsonb),
    'matches',coalesce((select jsonb_agg(to_jsonb(m) order by m.round,m.match_number)
      from public.tournament_matches m where m.tournament_id=p_tournament),'[]'::jsonb),
    'serverNow',now()) end;
$$;

-- Room completion runs inside the existing verified-move transaction. Draws
-- remain active pairings: only a repeat of the same format may resolve them.
create function public.tournament_room_result() returns trigger language plpgsql
security definer set search_path=public,pg_temp as $$
declare m public.tournament_matches; winner uuid; gid uuid;
begin
  if new.status not in ('finished','closed') or old.status=new.status then return new; end if;
  select * into m from public.tournament_matches where room_id=new.id and status='active';
  if not found then return new; end if;
  if new.status='finished' then
    if new.match_winner_user_id is null then return new; end if;
    select id into gid from public.games where room_id=new.id and series_number=new.current_series_number and game_number=new.current_game_number;
    perform public.tournament_finish(m.id,new.match_winner_user_id,'played',gid);
  else
    if new.host_seen_at>now()-interval '60 seconds' and new.guest_seen_at<=now()-interval '60 seconds' then winner:=new.host_user_id;
    elsif new.guest_seen_at>now()-interval '60 seconds' and new.host_seen_at<=now()-interval '60 seconds' then winner:=new.guest_user_id;
    end if;
    perform public.tournament_finish(m.id,winner,'disconnect');
  end if;
  return new;
end $$;
create trigger tournament_room_completed after update of status on public.rooms for each row execute function public.tournament_room_result();

create function public.tournament_withdraw(p_user uuid,p_tournament uuid) returns void language plpgsql
security definer set search_path=public,pg_temp as $$
declare t public.tournaments; m public.tournament_matches;
begin
  select * into t from public.tournaments where id=p_tournament for update;
  if not found then raise exception 'Tournament: Tournament unavailable.'; end if;
  if not exists(select 1 from public.tournament_participants where tournament_id=t.id and user_id=p_user) then
    raise exception 'Tournament: Only a participant can leave this tournament.'; end if;
  if t.status='open' then
    if t.creator_id=p_user then update public.tournaments set status='cancelled',completed_at=now() where id=t.id;
    else delete from public.tournament_participants where tournament_id=t.id and user_id=p_user; end if;
    return;
  end if;
  if t.status<>'active' then return; end if;
  update public.tournament_participants set withdrawn=true,eliminated=true,active=false where tournament_id=t.id and user_id=p_user;
  for m in select * from public.tournament_matches where tournament_id=t.id and status<>'completed' and (player1_id=p_user or player2_id=p_user) loop
    -- Do not wait on a move transaction holding the room and waiting for this
    -- tournament: reject/retry instead of reversing the lock order.
    if m.room_id is not null then perform 1 from public.rooms where id=m.room_id for update nowait; end if;
    perform public.tournament_finish(m.id,case when m.player1_id=p_user then m.player2_id else m.player1_id end,'withdrawal');
    if m.room_id is not null then update public.rooms set status='closed',version=version+1 where id=m.room_id; end if;
  end loop;
end $$;

-- Explicit leave from a tournament room is a withdrawal, never a fake game win.
create or replace function public.online_leave_room(p_room uuid,p_user uuid) returns void language plpgsql
security definer set search_path=public,pg_temp as $$
declare tid uuid;
begin
  select tournament_id into tid from public.tournament_matches where room_id=p_room and status='active'
    and (player1_id=p_user or player2_id=p_user);
  if tid is not null then perform public.tournament_withdraw(p_user,tid); return; end if;
  update public.rooms set status='closed',version=version+1,updated_at=now(),last_activity_at=now()
    where id=p_room and (host_user_id=p_user or guest_user_id=p_user);
end $$;

create function public.tournament_delete_user() returns trigger language plpgsql
security definer set search_path=public,pg_temp as $$
declare tid uuid;
begin
  for tid in select distinct tournament_id from public.tournament_participants where user_id=old.id loop
    perform public.tournament_withdraw(old.id,tid);
  end loop;
  update public.tournaments set creator_name='Deleted player' where creator_id=old.id;
  update public.tournaments set winner_name='Deleted player' where winner_id=old.id;
  update public.tournament_matches set
    player1_name=case when player1_id=old.id then 'Deleted player' else player1_name end,
    player2_name=case when player2_id=old.id then 'Deleted player' else player2_name end,
    winner_name=case when winner_id=old.id then 'Deleted player' else winner_name end
    where player1_id=old.id or player2_id=old.id or winner_id=old.id;
  update public.tournament_participants set display_name='Deleted player' where user_id=old.id;
  return old;
end $$;
-- Before existing room anonymization; the seat UUID still identifies the leaver.
create trigger aaa_tournament_delete before delete on auth.users for each row execute function public.tournament_delete_user();

create function public.tournament_tick() returns void language plpgsql
security definer set search_path=public,pg_temp as $$
declare m public.tournament_matches; r public.rooms; winner uuid;
begin
  for m in select * from public.tournament_matches where status in ('pending','active') order by tournament_id,round,match_number loop
    begin
      if m.status='pending' and m.ready_deadline<=now() then
        perform 1 from public.tournaments where id=m.tournament_id for update nowait;
        select * into m from public.tournament_matches where id=m.id for update nowait;
        if m.status<>'pending' or m.ready_deadline>now() then continue; end if;
        winner:=case when m.ready1 and not m.ready2 then m.player1_id when m.ready2 and not m.ready1 then m.player2_id end;
        perform public.tournament_finish(m.id,winner,'ready-timeout');
      elsif m.status='active' then
        select * into r from public.rooms where id=m.room_id for update nowait;
        if r.status in ('active','finished') and (r.host_seen_at<=now()-interval '60 seconds' or r.guest_seen_at<=now()-interval '60 seconds') then
          -- The room trigger records the bracket-only forfeit atomically.
          update public.rooms set status='closed',version=version+1,updated_at=now() where id=r.id;
        end if;
      end if;
    exception when lock_not_available or deadlock_detected then null; -- next tick retries
    end;
  end loop;
end $$;

-- Private functions only. Browser identities are derived by the Edge Function,
-- never trusted from a request body; read-only table access remains under RLS.
do $$ declare f record; begin
  for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname like 'tournament_%' loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);
    execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end $$;

-- Supabase Cron executes SQL as the database owner, not an exposed HTTP secret.
create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule('dama-tournament-deadlines','* * * * *','select public.tournament_tick()');
