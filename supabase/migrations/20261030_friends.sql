-- v2.7: private social graph, immutable tags, verified presence leases and invites.
alter table public.profiles add column player_tag text;
create function public.social_profile_tag() returns trigger language plpgsql
security definer set search_path=public,pg_temp as $$
declare tag text;
begin
  if tg_op='UPDATE' and old.player_tag is not null then
    if new.player_tag is distinct from old.player_tag then raise exception 'Friends: Player tags are permanent.'; end if;
    return new;
  end if;
  -- Serialize allocation, including collision retries, until the insert commits.
  perform pg_advisory_xact_lock(hashtextextended('dama-social-tags',0));
  loop
    tag:=upper(substr(replace(gen_random_uuid()::text,'-',''),1,8));
    exit when not exists(select 1 from public.profiles where player_tag=tag);
  end loop;
  new.player_tag:=tag; return new;
end $$;
create trigger social_tag before insert or update of player_tag on public.profiles
  for each row execute function public.social_profile_tag();
update public.profiles set player_tag=null;
alter table public.profiles alter column player_tag set not null;
alter table public.profiles add constraint profiles_tag_unique unique(player_tag);
alter table public.profiles add constraint profiles_tag_format check(player_tag ~ '^[A-F0-9]{8}$');

create table public.friendships (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references auth.users(id) on delete cascade,
  addressee_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending' check(status in ('pending','accepted','declined')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check(requester_id<>addressee_id)
);
create unique index friendship_pair on public.friendships(least(requester_id,addressee_id),greatest(requester_id,addressee_id));
create index friendship_recipient on public.friendships(addressee_id,status);
create index friendship_sender on public.friendships(requester_id,status);
create table public.friend_blocks (
  blocker_id uuid not null references auth.users(id) on delete cascade,
  blocked_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(), primary key(blocker_id,blocked_id),check(blocker_id<>blocked_id)
);
create index friend_blocks_reverse on public.friend_blocks(blocked_id,blocker_id);
create table public.friend_cooldowns (
  user1 uuid not null references auth.users(id) on delete cascade,
  user2 uuid not null references auth.users(id) on delete cascade,
  until_at timestamptz not null, primary key(user1,user2),check(user1<user2)
);
create table public.social_limits (
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check(kind in ('search','request','invite')),
  window_at timestamptz not null default now(), uses integer not null default 0,
  primary key(user_id,kind)
);
create table public.friend_sessions (
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null, seen_at timestamptz not null default now(), primary key(user_id,session_id)
);
alter table public.rooms add column friends_private boolean not null default false;
alter table public.rooms add column friends_invitee uuid references auth.users(id) on delete set null;
create table public.friend_invites (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references auth.users(id) on delete cascade,
  recipient_id uuid not null references auth.users(id) on delete cascade,
  room_id uuid not null references public.rooms(id) on delete cascade,
  status text not null default 'pending' check(status in ('pending','accepted','declined','revoked')),
  created_at timestamptz not null default now(), expires_at timestamptz not null default(now()+interval '5 minutes'),
  check(sender_id<>recipient_id)
);
create unique index friend_invite_pending_room on public.friend_invites(room_id) where status='pending';
create index friend_invite_recipient on public.friend_invites(recipient_id,status,expires_at);
create index friend_invite_sender on public.friend_invites(sender_id,status,expires_at);
do $$ declare tab text; begin
  foreach tab in array array['friendships','friend_blocks','friend_cooldowns','social_limits','friend_sessions','friend_invites'] loop
    execute format('alter table public.%I enable row level security',tab);
    execute format('revoke all on public.%I from public,anon,authenticated',tab);
    execute format('grant all on public.%I to service_role',tab);
  end loop;
end $$;
grant select on public.friendships,public.friend_blocks,public.friend_invites to authenticated;
create policy "Own friendship edges" on public.friendships for select to authenticated
  using(auth.uid() in (requester_id,addressee_id));
create policy "Own block list" on public.friend_blocks for select to authenticated using(blocker_id=auth.uid());
create policy "Own room invites" on public.friend_invites for select to authenticated using(auth.uid() in (sender_id,recipient_id));

create function public.social_account(p_user uuid) returns void language plpgsql
security definer set search_path=public,pg_temp as $$
begin
  if not exists(select 1 from public.profiles p join auth.users u on p.id=u.id where p.id=p_user and u.is_anonymous is not true) then
    raise exception 'Friends: Log in with a permanent account.'; end if;
end $$;
create function public.social_blocked(a uuid,b uuid) returns boolean language sql stable
security definer set search_path=public,pg_temp as $$
  select exists(select 1 from public.friend_blocks where (blocker_id=a and blocked_id=b) or (blocker_id=b and blocked_id=a));
$$;
create function public.social_friends(a uuid,b uuid) returns boolean language sql stable
security definer set search_path=public,pg_temp as $$
  select not public.social_blocked(a,b) and exists(select 1 from public.friendships where
    least(requester_id,addressee_id)=least(a,b) and greatest(requester_id,addressee_id)=greatest(a,b) and status='accepted');
$$;
create function public.social_rate(p_user uuid,p_kind text) returns void language plpgsql
security definer set search_path=public,pg_temp as $$
declare v public.social_limits; duration interval; cap integer;
begin
  duration:=case when p_kind='request' then interval '1 hour' else interval '1 minute' end;
  cap:=case p_kind when 'request' then 10 when 'invite' then 5 else 30 end;
  insert into public.social_limits(user_id,kind) values(p_user,p_kind) on conflict do nothing;
  select * into v from public.social_limits where user_id=p_user and kind=p_kind for update;
  if v.window_at<=now()-duration then v.uses:=0; v.window_at:=now(); end if;
  if v.uses>=cap then raise exception 'Friends: Rate limit reached. Please try again later.'; end if;
  update public.social_limits set uses=v.uses+1,window_at=v.window_at where user_id=p_user and kind=p_kind;
end $$;

-- Inbox events contain no graph, identity, room, or presence payload. Only the
-- verified inbox owner can read; clients can publish only their own Presence.
create policy "Account reads own social inbox" on realtime.messages for select to authenticated
  using(extension in ('broadcast','presence') and realtime.topic()='social:'||auth.uid()::text
    and exists(select 1 from public.profiles where id=auth.uid()));
create policy "Account tracks own social presence" on realtime.messages for insert to authenticated
  with check(extension='presence' and realtime.topic()='social:'||auth.uid()::text
    and exists(select 1 from public.profiles where id=auth.uid()));
create function public.social_hint(p_user uuid) returns void language plpgsql
security definer set search_path=public,pg_temp as $$
begin
  perform realtime.send('{}'::jsonb,'social-changed','social:'||p_user::text,true);
end $$;
create function public.social_edge_hint() returns trigger language plpgsql
security definer set search_path=public,pg_temp as $$
declare row_data jsonb;
begin
  row_data:=case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end;
  perform public.social_hint(coalesce(row_data->>'requester_id',row_data->>'sender_id',row_data->>'blocker_id')::uuid);
  perform public.social_hint(coalesce(row_data->>'addressee_id',row_data->>'recipient_id',row_data->>'blocked_id')::uuid);
  return null;
end $$;
create trigger friendship_hint after insert or update or delete on public.friendships for each row execute function public.social_edge_hint();
create trigger friend_block_hint after insert or delete on public.friend_blocks for each row execute function public.social_edge_hint();
create trigger friend_invite_hint after insert or update or delete on public.friend_invites for each row execute function public.social_edge_hint();

create function public.social_presence(p_user uuid,p_session uuid,p_online boolean) returns void language plpgsql
security definer set search_path=public,pg_temp as $$
declare was_online boolean; is_online boolean; other uuid;
begin
  perform public.social_account(p_user);
  was_online:=exists(select 1 from public.friend_sessions where user_id=p_user and seen_at>now()-interval '45 seconds');
  delete from public.friend_sessions where user_id=p_user and seen_at<=now()-interval '45 seconds';
  if p_online then
    insert into public.friend_sessions(user_id,session_id) values(p_user,p_session)
      on conflict(user_id,session_id) do update set seen_at=now();
  else delete from public.friend_sessions where user_id=p_user and session_id=p_session;
  end if;
  is_online:=exists(select 1 from public.friend_sessions where user_id=p_user and seen_at>now()-interval '45 seconds');
  if was_online is distinct from is_online then
    for other in select case when requester_id=p_user then addressee_id else requester_id end from public.friendships
      where status='accepted' and p_user in (requester_id,addressee_id) loop
      if public.social_friends(p_user,other) then perform public.social_hint(other); end if;
    end loop;
  end if;
end $$;

create function public.social_state(p_user uuid) returns jsonb language plpgsql
security definer set search_path=public,pg_temp as $$
declare result jsonb;
begin
  perform public.social_account(p_user);
  select jsonb_build_object(
    'self',(select jsonb_build_object('id',id,'name',display_name,'tag',player_tag) from public.profiles where id=p_user),
    'friends',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'name',p.display_name,'tag',p.player_tag,
      'online',exists(select 1 from public.friend_sessions s where s.user_id=p.id and s.seen_at>now()-interval '45 seconds')) order by p.display_name,p.id)
      from public.friendships edge join public.profiles p on p.id=case when edge.requester_id=p_user then edge.addressee_id else edge.requester_id end
      where edge.status='accepted' and p_user in (edge.requester_id,edge.addressee_id) and not public.social_blocked(p_user,p.id)),'[]'::jsonb),
    'requests',coalesce((select jsonb_agg(jsonb_build_object('id',f.id,'userId',p.id,'name',p.display_name,'tag',p.player_tag,
      'incoming',f.addressee_id=p_user,'status',f.status,'updatedAt',f.updated_at) order by f.created_at desc)
      from public.friendships f join public.profiles p on p.id=case when f.requester_id=p_user then f.addressee_id else f.requester_id end
      where p_user in (f.requester_id,f.addressee_id) and f.status<>'accepted' and
        (f.status='pending' or f.updated_at>now()-interval '24 hours') and not public.social_blocked(p_user,p.id)),'[]'::jsonb),
    'blocks',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'name',p.display_name,'tag',p.player_tag) order by p.display_name,p.id)
      from public.friend_blocks b join public.profiles p on p.id=b.blocked_id where b.blocker_id=p_user),'[]'::jsonb),
    'invites',coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'userId',p.id,'name',p.display_name,'tag',p.player_tag,
      'incoming',i.recipient_id=p_user,'expiresAt',i.expires_at) order by i.created_at desc)
      from public.friend_invites i join public.profiles p on p.id=case when i.sender_id=p_user then i.recipient_id else i.sender_id end
      join public.rooms r on r.id=i.room_id where p_user in (i.sender_id,i.recipient_id) and i.status='pending' and i.expires_at>now()
        and r.status='waiting' and r.friends_private and r.friends_invitee=i.recipient_id and public.social_friends(i.sender_id,i.recipient_id)),'[]'::jsonb)
  ) into result;
  return result;
end $$;
create function public.social_search(p_user uuid,p_query text) returns jsonb language plpgsql
security definer set search_path=public,pg_temp as $$
declare q text:=btrim(p_query); result jsonb;
begin
  perform public.social_account(p_user);
  if q is null or char_length(q) not between 1 and 80 then raise exception 'Friends: Enter an exact display name or player tag.'; end if;
  perform public.social_rate(p_user,'search');
  select coalesce(jsonb_agg(to_jsonb(v)),'[]'::jsonb) into result from (
    select p.id,p.display_name as name,p.player_tag as tag,
      (select status from public.friendships f where least(f.requester_id,f.addressee_id)=least(p_user,p.id)
        and greatest(f.requester_id,f.addressee_id)=greatest(p_user,p.id)) as relationship
    from public.profiles p join auth.users u on u.id=p.id where p.id<>p_user and u.is_anonymous is not true
      and not public.social_blocked(p_user,p.id) and (lower(p.display_name)=lower(q) or p.player_tag=upper(q) or
        lower(p.display_name||'#'||p.player_tag)=lower(q)) order by p.display_name,p.player_tag limit 10
  ) v;
  return result;
end $$;
create function public.social_profile(p_user uuid,p_other uuid) returns jsonb language plpgsql
security definer set search_path=public,pg_temp as $$
begin
  perform public.social_account(p_user);
  if not public.social_friends(p_user,p_other) then raise exception 'Friends: Profile is available to accepted friends only.'; end if;
  return jsonb_build_object('id',p_other,'name',(select display_name from public.profiles where id=p_other),
    'tag',(select player_tag from public.profiles where id=p_other),'stats',public.online_account_stats(p_other));
end $$;

create function public.social_action(p_user uuid,p_other uuid,p_action text) returns void language plpgsql
security definer set search_path=public,pg_temp as $$
declare edge public.friendships; low_id uuid:=least(p_user,p_other); high_id uuid:=greatest(p_user,p_other);
begin
  perform public.social_account(p_user); perform public.social_account(p_other);
  if p_user=p_other then raise exception 'Friends: You cannot add or block yourself.'; end if;
  perform pg_advisory_xact_lock(hashtextextended('dama-social-mutations',0));
  select * into edge from public.friendships where least(requester_id,addressee_id)=low_id and greatest(requester_id,addressee_id)=high_id for update;
  if p_action='block' then
    insert into public.friend_blocks(blocker_id,blocked_id) values(p_user,p_other) on conflict do nothing;
    delete from public.friendships where id=edge.id;
  elsif p_action='unblock' then
    delete from public.friend_blocks where blocker_id=p_user and blocked_id=p_other;
    return;
  else
    if public.social_blocked(p_user,p_other) then raise exception 'Friends: Player unavailable.'; end if;
    if p_action='request' then
      if exists(select 1 from public.friend_cooldowns where user1=low_id and user2=high_id and until_at>now()) then
        raise exception 'Friends: Please wait 24 hours after a declined request.'; end if;
      if edge.status in ('accepted','pending') then raise exception 'Friends: Already friends or request pending.'; end if;
      perform public.social_rate(p_user,'request');
      delete from public.friendships where id=edge.id;
      insert into public.friendships(requester_id,addressee_id) values(p_user,p_other);
      return;
    elsif p_action in ('accept','decline') then
      if edge.status is distinct from 'pending' or edge.addressee_id<>p_user then raise exception 'Friends: Only the recipient can respond to a pending request.'; end if;
      update public.friendships set status=case when p_action='accept' then 'accepted' else 'declined' end,updated_at=now() where id=edge.id;
      if p_action='decline' then insert into public.friend_cooldowns(user1,user2,until_at) values(low_id,high_id,now()+interval '24 hours')
        on conflict(user1,user2) do update set until_at=excluded.until_at; end if;
      return;
    elsif p_action='cancel' then
      if edge.status is distinct from 'pending' or edge.requester_id<>p_user then raise exception 'Friends: Only the sender can cancel a pending request.'; end if;
      delete from public.friendships where id=edge.id; return;
    elsif p_action='remove' then
      if edge.status is distinct from 'accepted' then raise exception 'Friends: Friendship unavailable.'; end if;
      delete from public.friendships where id=edge.id;
    else raise exception 'Friends: Invalid action.';
    end if;
  end if;
  update public.friend_invites set status='revoked' where status='pending' and
    least(sender_id,recipient_id)=low_id and greatest(sender_id,recipient_id)=high_id;
end $$;

create function public.social_invite(p_user uuid,p_other uuid,p_room uuid,p_code text,p_color text,p_format text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.rooms; rid uuid:=p_room; iid uuid;
begin
  perform public.social_account(p_user); perform public.social_account(p_other);
  perform pg_advisory_xact_lock(hashtextextended('dama-social-mutations',0));
  if not public.social_friends(p_user,p_other) then raise exception 'Friends: Invite accepted friends only.'; end if;
  if not exists(select 1 from public.friend_sessions where user_id=p_other and seen_at>now()-interval '45 seconds') then
    raise exception 'Friends: Your friend is offline.'; end if;
  perform public.social_rate(p_user,'invite');
  if rid is null then
    if exists(select 1 from public.rooms where status in ('waiting','active') and p_user in (host_user_id,guest_user_id)) then
      raise exception 'Friends: Leave your other online room first.'; end if;
    if (select count(*) from public.rooms where host_user_id=p_user and created_at>now()-interval '1 hour')>=5 then
      raise exception 'Friends: Room creation limit reached.'; end if;
    rid:=public.online_create_room(p_code,(select display_name from public.profiles where id=p_user),p_user,p_color,p_format);
  end if;
  select * into r from public.rooms where id=rid for update;
  if not found or r.status<>'waiting' or r.host_user_id<>p_user or r.guest_user_id is not null or
    exists(select 1 from public.tournament_matches where room_id=rid) then raise exception 'Friends: Invite from your own normal waiting room only.'; end if;
  update public.friend_invites set status='revoked' where room_id=rid and status='pending';
  update public.rooms set friends_private=true,friends_invitee=p_other,version=version+1,host_seen_at=now(),last_activity_at=now() where id=rid;
  insert into public.friend_invites(sender_id,recipient_id,room_id) values(p_user,p_other,rid) returning id into iid;
  return jsonb_build_object('roomId',rid,'inviteId',iid);
end $$;
create function public.social_invite_reply(p_user uuid,p_invite uuid,p_join boolean,p_board jsonb)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare i public.friend_invites; rid uuid;
begin
  perform public.social_account(p_user);
  perform pg_advisory_xact_lock(hashtextextended('dama-social-mutations',0));
  select * into i from public.friend_invites where id=p_invite for update;
  if not found or p_user not in (i.sender_id,i.recipient_id) then raise exception 'Friends: Invite unavailable.'; end if;
  if not p_join then
    update public.friend_invites set status=case when sender_id=p_user then 'revoked' else 'declined' end where id=i.id and status='pending'; return null;
  end if;
  if i.recipient_id<>p_user or i.status<>'pending' or i.expires_at<=now() or not public.social_friends(i.sender_id,p_user) then
    raise exception 'Friends: Invite expired or unavailable.'; end if;
  if exists(select 1 from public.rooms where status in ('active','waiting') and p_user in (host_user_id,guest_user_id)) then
    raise exception 'Friends: Leave your other online room first.'; end if;
  select id into rid from public.rooms where id=i.room_id and friends_private and friends_invitee=p_user;
  if rid is null then raise exception 'Friends: Invite unavailable.'; end if;
  return public.online_join_room((select room_code from public.rooms where id=rid),
    (select display_name from public.profiles where id=p_user),p_user,p_board);
end $$;

-- Keep the existing series/game insertion code; the wrapper locks reservation
-- and social graph before it can commit a join. Neither code entry nor expiry
-- may turn a reserved room into a public one.
alter function public.online_join_room(text,text,uuid,jsonb) rename to online_join_room_v26;
create function public.online_join_room(p_code text,p_name text,p_user uuid,p_board jsonb)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.rooms; rid uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('dama-social-mutations',0));
  select * into r from public.rooms where room_code=p_code for update;
  if r.friends_private then
    perform public.social_account(p_user);
    if r.friends_invitee is distinct from p_user or not public.social_friends(r.host_user_id,p_user) or not exists
      (select 1 from public.friend_invites where room_id=r.id and recipient_id=p_user and status='pending' and expires_at>now()) then
      raise exception 'Room unavailable'; end if;
  end if;
  rid:=public.online_join_room_v26(p_code,p_name,p_user,p_board);
  if r.friends_private then update public.friend_invites set status='accepted' where room_id=r.id and recipient_id=p_user and status='pending'; end if;
  return rid;
end $$;
revoke all on function public.online_join_room(text,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.online_join_room(text,text,uuid,jsonb) to service_role;

alter function public.online_join_spectator(text,text,uuid) rename to online_join_spectator_v26;
create function public.online_join_spectator(p_code text,p_name text,p_user uuid) returns uuid language plpgsql
security definer set search_path=public,pg_temp as $$
begin
  perform 1 from public.rooms where room_code=p_code and not friends_private for update;
  if not found then raise exception 'Room unavailable'; end if;
  return public.online_join_spectator_v26(p_code,p_name,p_user);
end $$;
revoke all on function public.online_join_spectator(text,text,uuid) from public,anon,authenticated;
grant execute on function public.online_join_spectator(text,text,uuid) to service_role;

do $$ declare f record; begin
  for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname like 'social_%' loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);
    execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end $$;
