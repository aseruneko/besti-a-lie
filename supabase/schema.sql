create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null check (
    char_length(username) between 2 and 24
    and username !~ '[\r\n\t]'
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  current_phase text not null default 'waiting'
    check (current_phase in ('waiting', 'prompt', 'writing', 'editing', 'voting', 'results')),
  include_master_as_player boolean not null default false,
  current_round integer not null default 1 check (current_round = 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.room_members (
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (room_id, user_id)
);

create table if not exists public.room_ai_participants (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  slot integer not null check (slot between 1 and 4),
  display_name text not null check (char_length(display_name) between 1 and 24),
  personality text not null default 'normal' check (
    personality in ('normal', 'weird', 'formal', 'archaic', 'technical')
  ),
  joined_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (room_id, slot)
);

create table if not exists public.prompts (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  round_number integer not null default 1 check (round_number = 1),
  word text not null check (char_length(word) between 1 and 80),
  correct_definition text not null check (char_length(correct_definition) between 1 and 1200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (room_id, round_number)
);

create table if not exists public.definitions (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  prompt_id uuid not null references public.prompts(id) on delete cascade,
  author_id uuid references public.profiles(id) on delete cascade,
  ai_author_id uuid references public.room_ai_participants(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 1200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (prompt_id, author_id),
  unique (prompt_id, ai_author_id),
  check ((author_id is not null) <> (ai_author_id is not null))
);

alter table public.definitions
alter column author_id drop not null;

alter table public.definitions
add column if not exists ai_author_id uuid references public.room_ai_participants(id) on delete cascade;

alter table public.definitions
drop constraint if exists definitions_one_author;

alter table public.definitions
add constraint definitions_one_author
check ((author_id is not null) <> (ai_author_id is not null));

alter table public.definitions
drop constraint if exists definitions_prompt_ai_author_unique;

alter table public.definitions
add constraint definitions_prompt_ai_author_unique unique (prompt_id, ai_author_id);

create table if not exists public.published_choices (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  prompt_id uuid not null references public.prompts(id) on delete cascade,
  source_definition_id uuid references public.definitions(id) on delete cascade,
  is_correct boolean not null default false,
  body text not null check (char_length(body) between 1 and 1200),
  display_order integer not null check (display_order between 1 and 200),
  created_at timestamptz not null default now(),
  unique (prompt_id, display_order),
  unique (prompt_id, source_definition_id)
);

create unique index if not exists one_correct_choice_per_prompt
on public.published_choices (prompt_id)
where is_correct;

create table if not exists public.votes (
  room_id uuid not null references public.rooms(id) on delete cascade,
  prompt_id uuid not null references public.prompts(id) on delete cascade,
  voter_id uuid not null references public.profiles(id) on delete cascade,
  choice_id uuid not null references public.published_choices(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (prompt_id, voter_id)
);

create or replace function public.is_room_member(
  check_room_id uuid,
  check_user_id uuid
)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.room_members
    where room_id = check_room_id
      and user_id = check_user_id
  );
$$;

create or replace function public.is_room_writer(
  target_room_id uuid,
  check_user_id uuid
)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.rooms r
    where r.id = target_room_id
      and (
        r.include_master_as_player
        or r.owner_id <> check_user_id
      )
      and public.is_room_member(target_room_id, check_user_id)
  );
$$;

create or replace function public.ai_participant_belongs_to_room(
  target_room_id uuid,
  target_ai_participant_id uuid
)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.room_ai_participants
    where id = target_ai_participant_id
      and room_id = target_room_id
  );
$$;

create or replace function public.is_room_voter(
  target_room_id uuid,
  check_user_id uuid
)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.rooms r
    where r.id = target_room_id
      and r.owner_id <> check_user_id
      and public.is_room_member(target_room_id, check_user_id)
  );
$$;

create or replace function public.room_accepts_new_members(check_room_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.rooms
    where id = check_room_id
      and current_phase = 'waiting'
  );
$$;

create or replace function public.join_room(target_room_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
begin
  if current_user_id is null then
    raise exception 'Authentication is required';
  end if;

  if not exists (
    select 1 from public.profiles where id = current_user_id
  ) then
    raise exception 'Profile is required';
  end if;

  if exists (
    select 1
    from public.room_members
    where room_id = target_room_id
      and user_id = current_user_id
  ) then
    return;
  end if;

  if not public.room_accepts_new_members(target_room_id) then
    raise exception 'Room is not accepting new members';
  end if;

  insert into public.room_members (room_id, user_id)
  values (target_room_id, current_user_id);
end;
$$;

create or replace function public.set_room_include_master(
  target_room_id uuid,
  next_include_master_as_player boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
begin
  update public.rooms
  set include_master_as_player = next_include_master_as_player,
      updated_at = now()
  where id = target_room_id
    and owner_id = current_user_id
    and current_phase = 'waiting';

  if not found then
    raise exception 'Only the room master can change this setting while waiting';
  end if;
end;
$$;

create or replace function public.set_room_ai_participant_count(
  target_room_id uuid,
  next_ai_participant_count integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  slot_value integer;
begin
  if current_user_id is null then
    raise exception 'Authentication is required';
  end if;

  if next_ai_participant_count < 0 or next_ai_participant_count > 4 then
    raise exception 'AI participant count must be between 0 and 4';
  end if;

  if not exists (
    select 1
    from public.rooms
    where id = target_room_id
      and owner_id = current_user_id
      and current_phase = 'waiting'
  ) then
    raise exception 'Only the room master can change AI participants while waiting';
  end if;

  delete from public.room_ai_participants
  where room_id = target_room_id
    and slot > next_ai_participant_count;

  for slot_value in 1..next_ai_participant_count loop
    insert into public.room_ai_participants (
      room_id,
      slot,
      display_name,
      personality
    )
    values (
      target_room_id,
      slot_value,
      'ふつうAI',
      'normal'
    )
    on conflict (room_id, slot) do nothing;
  end loop;
end;
$$;

create or replace function public.set_room_ai_participant_personality(
  target_room_id uuid,
  target_ai_participant_id uuid,
  next_personality text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  next_display_name text;
begin
  if current_user_id is null then
    raise exception 'Authentication is required';
  end if;

  next_display_name := case next_personality
    when 'normal' then 'ふつうAI'
    when 'weird' then 'へんなAI'
    when 'formal' then '硬派な辞書AI'
    when 'archaic' then '古語っぽいAI'
    when 'technical' then '専門用語AI'
    else null
  end;

  if next_display_name is null then
    raise exception 'Unknown AI personality';
  end if;

  if not exists (
    select 1
    from public.rooms
    where id = target_room_id
      and owner_id = current_user_id
      and current_phase = 'waiting'
  ) then
    raise exception 'Only the room master can change AI personalities while waiting';
  end if;

  update public.room_ai_participants
  set personality = next_personality,
      display_name = next_display_name,
      updated_at = now()
  where id = target_ai_participant_id
    and room_id = target_room_id;

  if not found then
    raise exception 'AI participant does not belong to this room';
  end if;
end;
$$;

create or replace function public.start_prompt(
  target_room_id uuid,
  next_word text,
  next_correct_definition text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  participant_count integer;
  writer_count integer;
begin
  next_word := btrim(next_word);
  next_correct_definition := btrim(next_correct_definition);

  if char_length(next_word) < 1 or char_length(next_word) > 80 then
    raise exception 'Word must be between 1 and 80 characters';
  end if;

  if char_length(next_correct_definition) < 1 or char_length(next_correct_definition) > 1200 then
    raise exception 'Correct definition must be between 1 and 1200 characters';
  end if;

  select
    (
      select count(*)
      from public.room_members
      where room_id = target_room_id
    ) + (
      select count(*)
      from public.room_ai_participants
      where room_id = target_room_id
    )
  into participant_count;

  if participant_count < 2 then
    raise exception 'At least two participants are required';
  end if;

  select count(*) into writer_count
  from (
    select rm.user_id::text as participant_key
    from public.room_members rm
    join public.rooms r on r.id = rm.room_id
    where rm.room_id = target_room_id
      and (r.include_master_as_player or rm.user_id <> r.owner_id)
    union all
    select rai.id::text as participant_key
    from public.room_ai_participants rai
    where rai.room_id = target_room_id
  ) writers;

  if writer_count < 1 then
    raise exception 'At least one writer is required';
  end if;

  insert into public.prompts (
    room_id,
    round_number,
    word,
    correct_definition
  )
  select target_room_id, 1, next_word, next_correct_definition
  from public.rooms r
  where r.id = target_room_id
    and r.owner_id = current_user_id
    and r.current_phase in ('waiting', 'prompt')
  on conflict (room_id, round_number)
  do update set word = excluded.word,
                correct_definition = excluded.correct_definition,
                updated_at = now();

  if not found then
    raise exception 'Only the room master can start the prompt';
  end if;

  update public.rooms
  set current_phase = 'writing',
      updated_at = now()
  where id = target_room_id
    and owner_id = current_user_id
    and current_phase in ('waiting', 'prompt');
end;
$$;

create or replace function public.submit_definition(
  target_room_id uuid,
  next_body text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  prompt_record public.prompts%rowtype;
  writer_count integer;
  submitted_count integer;
begin
  next_body := btrim(next_body);

  if char_length(next_body) < 1 or char_length(next_body) > 1200 then
    raise exception 'Definition must be between 1 and 1200 characters';
  end if;

  if not public.is_room_writer(target_room_id, current_user_id) then
    raise exception 'You are not a writer in this room';
  end if;

  select p.* into prompt_record
  from public.prompts p
  join public.rooms r on r.id = p.room_id
  where p.room_id = target_room_id
    and p.round_number = 1
    and r.current_phase = 'writing';

  if prompt_record.id is null then
    raise exception 'Room is not accepting definitions';
  end if;

  insert into public.definitions (
    room_id,
    prompt_id,
    author_id,
    ai_author_id,
    body
  )
  values (
    target_room_id,
    prompt_record.id,
    current_user_id,
    null,
    next_body
  )
  on conflict (prompt_id, author_id)
  do update set body = excluded.body,
                updated_at = now();

  select count(*) into writer_count
  from (
    select rm.user_id::text as participant_key
    from public.room_members rm
    join public.rooms r on r.id = rm.room_id
    where rm.room_id = target_room_id
      and (r.include_master_as_player or rm.user_id <> r.owner_id)
    union all
    select rai.id::text as participant_key
    from public.room_ai_participants rai
    where rai.room_id = target_room_id
  ) writers;

  select count(*) into submitted_count
  from public.definitions
  where prompt_id = prompt_record.id;

  if submitted_count >= writer_count then
    update public.rooms
    set current_phase = 'editing',
        updated_at = now()
    where id = target_room_id;
  end if;
end;
$$;

create or replace function public.submit_ai_definition(
  target_room_id uuid,
  target_ai_participant_id uuid,
  next_body text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  prompt_record public.prompts%rowtype;
  writer_count integer;
  submitted_count integer;
begin
  next_body := btrim(next_body);

  if current_user_id is null then
    raise exception 'Authentication is required';
  end if;

  if char_length(next_body) < 1 or char_length(next_body) > 1200 then
    raise exception 'Definition must be between 1 and 1200 characters';
  end if;

  if not public.is_room_member(target_room_id, current_user_id) then
    raise exception 'Only room members can submit AI definitions';
  end if;

  if not public.ai_participant_belongs_to_room(target_room_id, target_ai_participant_id) then
    raise exception 'AI participant does not belong to this room';
  end if;

  select p.* into prompt_record
  from public.prompts p
  join public.rooms r on r.id = p.room_id
  where p.room_id = target_room_id
    and p.round_number = 1
    and r.current_phase = 'writing';

  if prompt_record.id is null then
    raise exception 'Room is not accepting definitions';
  end if;

  insert into public.definitions (
    room_id,
    prompt_id,
    author_id,
    ai_author_id,
    body
  )
  values (
    target_room_id,
    prompt_record.id,
    null,
    target_ai_participant_id,
    next_body
  )
  on conflict (prompt_id, ai_author_id)
  do update set body = excluded.body,
                updated_at = now();

  select count(*) into writer_count
  from (
    select rm.user_id::text as participant_key
    from public.room_members rm
    join public.rooms r on r.id = rm.room_id
    where rm.room_id = target_room_id
      and (r.include_master_as_player or rm.user_id <> r.owner_id)
    union all
    select rai.id::text as participant_key
    from public.room_ai_participants rai
    where rai.room_id = target_room_id
  ) writers;

  select count(*) into submitted_count
  from public.definitions
  where prompt_id = prompt_record.id;

  if submitted_count >= writer_count then
    update public.rooms
    set current_phase = 'editing',
        updated_at = now()
    where id = target_room_id;
  end if;
end;
$$;

create or replace function public.publish_choices(
  target_room_id uuid,
  choices jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  prompt_record public.prompts%rowtype;
  choice_record jsonb;
  correct_count integer;
  choice_count integer;
  source_id uuid;
  is_correct_choice boolean;
  body_text text;
  order_value integer;
begin
  select p.* into prompt_record
  from public.prompts p
  join public.rooms r on r.id = p.room_id
  where p.room_id = target_room_id
    and p.round_number = 1
    and r.owner_id = current_user_id
    and r.current_phase = 'editing';

  if prompt_record.id is null then
    raise exception 'Only the room master can publish choices while editing';
  end if;

  if jsonb_typeof(choices) <> 'array' then
    raise exception 'Choices must be an array';
  end if;

  select count(*) into choice_count from jsonb_array_elements(choices);
  if choice_count < 2 then
    raise exception 'At least two choices are required';
  end if;

  select count(*) into correct_count
  from jsonb_array_elements(choices) item
  where coalesce((item->>'isCorrect')::boolean, false);

  if correct_count <> 1 then
    raise exception 'Exactly one correct choice is required';
  end if;

  delete from public.votes where prompt_id = prompt_record.id;
  delete from public.published_choices where prompt_id = prompt_record.id;

  for choice_record in select * from jsonb_array_elements(choices)
  loop
    is_correct_choice := coalesce((choice_record->>'isCorrect')::boolean, false);
    body_text := btrim(coalesce(choice_record->>'body', ''));
    order_value := coalesce((choice_record->>'displayOrder')::integer, 0);

    if char_length(body_text) < 1 or char_length(body_text) > 1200 then
      raise exception 'Choice body must be between 1 and 1200 characters';
    end if;

    if order_value < 1 or order_value > 200 then
      raise exception 'Choice display order is invalid';
    end if;

    source_id := nullif(choice_record->>'sourceDefinitionId', '')::uuid;

    if is_correct_choice and source_id is not null then
      raise exception 'Correct choice cannot reference a submitted definition';
    end if;

    if not is_correct_choice then
      if source_id is null then
        raise exception 'A bluff choice must reference a submitted definition';
      end if;

      if not exists (
        select 1
        from public.definitions d
        where d.id = source_id
          and d.prompt_id = prompt_record.id
      ) then
        raise exception 'Choice references an unknown definition';
      end if;
    end if;

    insert into public.published_choices (
      room_id,
      prompt_id,
      source_definition_id,
      is_correct,
      body,
      display_order
    )
    values (
      target_room_id,
      prompt_record.id,
      source_id,
      is_correct_choice,
      body_text,
      order_value
    );
  end loop;

  update public.rooms
  set current_phase = 'voting',
      updated_at = now()
  where id = target_room_id;
end;
$$;

create or replace function public.submit_vote(
  target_room_id uuid,
  target_choice_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  prompt_record public.prompts%rowtype;
  choice_record public.published_choices%rowtype;
  voter_count integer;
  voted_count integer;
begin
  if not public.is_room_voter(target_room_id, current_user_id) then
    raise exception 'You are not a voter in this room';
  end if;

  select p.* into prompt_record
  from public.prompts p
  join public.rooms r on r.id = p.room_id
  where p.room_id = target_room_id
    and p.round_number = 1
    and r.current_phase = 'voting';

  if prompt_record.id is null then
    raise exception 'Room is not accepting votes';
  end if;

  select * into choice_record
  from public.published_choices
  where id = target_choice_id
    and prompt_id = prompt_record.id;

  if choice_record.id is null then
    raise exception 'Unknown choice';
  end if;

  if exists (
    select 1
    from public.definitions d
    where d.id = choice_record.source_definition_id
      and d.author_id = current_user_id
  ) then
    raise exception 'You cannot vote for your own definition';
  end if;

  insert into public.votes (
    room_id,
    prompt_id,
    voter_id,
    choice_id
  )
  values (
    target_room_id,
    prompt_record.id,
    current_user_id,
    target_choice_id
  )
  on conflict (prompt_id, voter_id)
  do update set choice_id = excluded.choice_id,
                updated_at = now();

  select count(*) into voter_count
  from public.room_members rm
  join public.rooms r on r.id = rm.room_id
  where rm.room_id = target_room_id
    and rm.user_id <> r.owner_id;

  select count(*) into voted_count
  from public.votes
  where prompt_id = prompt_record.id;

  if voted_count >= voter_count then
    update public.rooms
    set updated_at = now()
    where id = target_room_id;
  end if;
end;
$$;

create or replace function public.reveal_results(target_room_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  voter_count integer;
  voted_count integer;
  prompt_id_value uuid;
begin
  select p.id into prompt_id_value
  from public.prompts p
  join public.rooms r on r.id = p.room_id
  where p.room_id = target_room_id
    and p.round_number = 1
    and r.owner_id = current_user_id
    and r.current_phase = 'voting';

  if prompt_id_value is null then
    raise exception 'Only the room master can reveal results while voting';
  end if;

  select count(*) into voter_count
  from public.room_members rm
  join public.rooms r on r.id = rm.room_id
  where rm.room_id = target_room_id
    and rm.user_id <> r.owner_id;

  select count(*) into voted_count
  from public.votes
  where prompt_id = prompt_id_value;

  if voted_count < voter_count then
    raise exception 'Votes are not complete';
  end if;

  update public.rooms
  set current_phase = 'results',
      updated_at = now()
  where id = target_room_id;
end;
$$;

create or replace function public.get_room_game_state(target_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  current_user_id uuid := auth.uid();
  room_record public.rooms%rowtype;
  prompt_record public.prompts%rowtype;
  members_json jsonb := '[]'::jsonb;
  own_definition_json jsonb := null;
  draft_definitions_json jsonb := '[]'::jsonb;
  choices_json jsonb := '[]'::jsonb;
  results_json jsonb := '[]'::jsonb;
  scores_json jsonb := '[]'::jsonb;
  own_vote_choice_id uuid;
  include_secret boolean := false;
begin
  if current_user_id is null then
    raise exception 'Authentication is required';
  end if;

  if not public.is_room_member(target_room_id, current_user_id) then
    raise exception 'Only room members can view game state';
  end if;

  select * into room_record
  from public.rooms
  where id = target_room_id;

  if room_record.id is null then
    raise exception 'Room not found';
  end if;

  select * into prompt_record
  from public.prompts
  where room_id = target_room_id
    and round_number = 1;

  include_secret := room_record.owner_id = current_user_id
    or room_record.current_phase = 'results';

  select coalesce(jsonb_agg(jsonb_build_object(
    'userId', member_rows.user_id,
    'aiParticipantId', member_rows.ai_participant_id,
    'username', member_rows.username,
    'joinedAt', member_rows.joined_at,
    'isAi', member_rows.is_ai,
    'isMaster', member_rows.user_id = room_record.owner_id::text,
    'isWriter', member_rows.is_writer,
    'isVoter', member_rows.is_voter,
    'hasSubmitted', member_rows.definition_id is not null,
    'hasVoted', member_rows.vote_id is not null
  ) order by member_rows.participant_index), '[]'::jsonb)
  into members_json
  from (
    select
      rm.user_id::text as user_id,
      null::uuid as ai_participant_id,
      rm.joined_at,
      p.username,
      false as is_ai,
      row_number() over (order by rm.joined_at, rm.user_id) - 1 as participant_index,
      (room_record.include_master_as_player or rm.user_id <> room_record.owner_id) as is_writer,
      (rm.user_id <> room_record.owner_id) as is_voter,
      d.id as definition_id,
      v.choice_id as vote_id
    from public.room_members rm
    join public.profiles p on p.id = rm.user_id
    left join public.definitions d
      on d.prompt_id = prompt_record.id
     and d.author_id = rm.user_id
    left join public.votes v
      on v.prompt_id = prompt_record.id
     and v.voter_id = rm.user_id
    where rm.room_id = target_room_id
    union all
    select
      rai.id::text as user_id,
      rai.id as ai_participant_id,
      rai.joined_at,
      rai.display_name as username,
      true as is_ai,
      (
        select count(*)
        from public.room_members rm_count
        where rm_count.room_id = target_room_id
      ) + row_number() over (order by rai.slot, rai.id) - 1 as participant_index,
      true as is_writer,
      false as is_voter,
      d.id as definition_id,
      null::uuid as vote_id
    from public.room_ai_participants rai
    left join public.definitions d
      on d.prompt_id = prompt_record.id
     and d.ai_author_id = rai.id
    where rai.room_id = target_room_id
  ) member_rows;

  if prompt_record.id is not null then
    select jsonb_build_object('id', d.id, 'body', d.body)
    into own_definition_json
    from public.definitions d
    where d.prompt_id = prompt_record.id
      and d.author_id = current_user_id;

    if room_record.owner_id = current_user_id
      and room_record.current_phase = 'editing'
    then
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', d.id,
        'body', d.body
      ) order by d.created_at, d.id), '[]'::jsonb)
      into draft_definitions_json
      from public.definitions d
      where d.prompt_id = prompt_record.id;
    end if;

    if room_record.current_phase in ('voting', 'results') then
      select v.choice_id into own_vote_choice_id
      from public.votes v
      where v.prompt_id = prompt_record.id
        and v.voter_id = current_user_id;

      select coalesce(jsonb_agg(jsonb_build_object(
        'id', pc.id,
        'body', pc.body,
        'displayOrder', pc.display_order,
        'isOwn', exists (
          select 1
          from public.definitions d
          where d.id = pc.source_definition_id
            and d.author_id = current_user_id
        )
      ) order by pc.display_order), '[]'::jsonb)
      into choices_json
      from public.published_choices pc
      where pc.prompt_id = prompt_record.id;
    end if;

    if room_record.current_phase = 'results' then
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', result_rows.id,
        'body', result_rows.body,
        'displayOrder', result_rows.display_order,
        'isCorrect', result_rows.is_correct,
        'submittedByUsername', result_rows.submitted_by_username,
        'voteCount', result_rows.vote_count,
        'voters', result_rows.voters
      ) order by result_rows.display_order), '[]'::jsonb)
      into results_json
      from (
        select
          pc.id,
          pc.body,
          pc.display_order,
          pc.is_correct,
          coalesce(author_profile.username, ai_author.display_name) as submitted_by_username,
          count(v.voter_id)::integer as vote_count,
          coalesce(jsonb_agg(voter_profile.username order by voter_profile.username)
            filter (where voter_profile.username is not null), '[]'::jsonb) as voters
        from public.published_choices pc
        left join public.definitions d on d.id = pc.source_definition_id
        left join public.profiles author_profile on author_profile.id = d.author_id
        left join public.room_ai_participants ai_author on ai_author.id = d.ai_author_id
        left join public.votes v on v.choice_id = pc.id
        left join public.profiles voter_profile on voter_profile.id = v.voter_id
        where pc.prompt_id = prompt_record.id
        group by pc.id, author_profile.username, ai_author.display_name
      ) result_rows;

      select coalesce(jsonb_agg(jsonb_build_object(
        'userId', score_rows.user_id,
        'username', score_rows.username,
        'correctPoints', score_rows.correct_points,
        'bluffPoints', score_rows.bluff_points,
        'totalPoints', score_rows.correct_points + score_rows.bluff_points
      ) order by (score_rows.correct_points + score_rows.bluff_points) desc, score_rows.username), '[]'::jsonb)
      into scores_json
      from (
        select
          rm.user_id,
          p.username,
          count(distinct v_correct.choice_id)::integer as correct_points,
          count(v_bluff.voter_id)::integer as bluff_points
        from public.room_members rm
        join public.profiles p on p.id = rm.user_id
        left join public.votes v_correct
          on v_correct.prompt_id = prompt_record.id
         and v_correct.voter_id = rm.user_id
         and exists (
           select 1
           from public.published_choices pc
           where pc.id = v_correct.choice_id
             and pc.is_correct
         )
        left join public.definitions d
          on d.prompt_id = prompt_record.id
         and d.author_id = rm.user_id
        left join public.published_choices pc_bluff
          on pc_bluff.source_definition_id = d.id
        left join public.votes v_bluff
          on v_bluff.choice_id = pc_bluff.id
        where rm.room_id = target_room_id
        group by rm.user_id, p.username
      ) score_rows;
    end if;
  end if;

  return jsonb_build_object(
    'room', jsonb_build_object(
      'id', room_record.id,
      'ownerId', room_record.owner_id,
      'currentPhase', room_record.current_phase,
      'includeMasterAsPlayer', room_record.include_master_as_player,
      'currentRound', room_record.current_round
    ),
    'members', members_json,
    'prompt',
      case
        when prompt_record.id is null then null
        when include_secret then jsonb_build_object(
          'word', prompt_record.word,
          'correctDefinition', prompt_record.correct_definition
        )
        else jsonb_build_object('word', prompt_record.word)
      end,
    'ownDefinition', own_definition_json,
    'draftDefinitions', draft_definitions_json,
    'choices', choices_json,
    'ownVoteChoiceId', own_vote_choice_id,
    'results', results_json,
    'scores', scores_json
  );
end;
$$;

grant execute on function public.join_room(uuid) to authenticated;
grant execute on function public.set_room_include_master(uuid, boolean) to authenticated;
grant execute on function public.set_room_ai_participant_count(uuid, integer) to authenticated;
grant execute on function public.set_room_ai_participant_personality(uuid, uuid, text) to authenticated;
grant execute on function public.start_prompt(uuid, text, text) to authenticated;
grant execute on function public.submit_definition(uuid, text) to authenticated;
grant execute on function public.submit_ai_definition(uuid, uuid, text) to authenticated;
grant execute on function public.publish_choices(uuid, jsonb) to authenticated;
grant execute on function public.submit_vote(uuid, uuid) to authenticated;
grant execute on function public.reveal_results(uuid) to authenticated;
grant execute on function public.get_room_game_state(uuid) to authenticated;

alter table public.profiles enable row level security;
alter table public.rooms enable row level security;
alter table public.room_members enable row level security;
alter table public.room_ai_participants enable row level security;
alter table public.prompts enable row level security;
alter table public.definitions enable row level security;
alter table public.published_choices enable row level security;
alter table public.votes enable row level security;

drop policy if exists "Profiles are visible to signed-in users"
on public.profiles;
drop policy if exists "Users can insert their own profile"
on public.profiles;
drop policy if exists "Users can update their own profile"
on public.profiles;

create policy "Profiles are visible to signed-in users"
on public.profiles
for select
to authenticated
using (true);

create policy "Users can insert their own profile"
on public.profiles
for insert
to authenticated
with check (id = auth.uid());

create policy "Users can update their own profile"
on public.profiles
for update
to authenticated
using (id = auth.uid())
with check (id = auth.uid());

drop policy if exists "Members can view their rooms"
on public.rooms;
drop policy if exists "Users can create owned rooms"
on public.rooms;
drop policy if exists "Owners can update waiting rooms"
on public.rooms;

create policy "Members can view their rooms"
on public.rooms
for select
to authenticated
using (
  owner_id = auth.uid()
  or public.is_room_member(id, auth.uid())
);

create policy "Users can create owned rooms"
on public.rooms
for insert
to authenticated
with check (owner_id = auth.uid());

create policy "Owners can update waiting rooms"
on public.rooms
for update
to authenticated
using (owner_id = auth.uid())
with check (owner_id = auth.uid());

drop policy if exists "Room members can view each other"
on public.room_members;
drop policy if exists "Users can join waiting rooms"
on public.room_members;
drop policy if exists "Room members can view AI participants"
on public.room_ai_participants;

create policy "Room members can view each other"
on public.room_members
for select
to authenticated
using (public.is_room_member(room_id, auth.uid()));

create policy "Users can join waiting rooms"
on public.room_members
for insert
to authenticated
with check (
  user_id = auth.uid()
  and public.room_accepts_new_members(room_id)
);

create policy "Room members can view AI participants"
on public.room_ai_participants
for select
to authenticated
using (public.is_room_member(room_id, auth.uid()));

drop policy if exists "Owners can view prompt rows"
on public.prompts;
drop policy if exists "Members can view their own definitions"
on public.definitions;
drop policy if exists "Members can view published choices after voting"
on public.published_choices;
drop policy if exists "Members can view published choices after results"
on public.published_choices;
drop policy if exists "Members can view their own votes"
on public.votes;

create policy "Owners can view prompt rows"
on public.prompts
for select
to authenticated
using (
  exists (
    select 1
    from public.rooms r
    where r.id = room_id
      and r.owner_id = auth.uid()
  )
);

create policy "Members can view their own definitions"
on public.definitions
for select
to authenticated
using (
  author_id = auth.uid()
  or exists (
    select 1
    from public.rooms r
    where r.id = room_id
      and r.owner_id = auth.uid()
      and r.current_phase = 'editing'
  )
);

create policy "Members can view published choices after results"
on public.published_choices
for select
to authenticated
using (
  public.is_room_member(room_id, auth.uid())
  and exists (
    select 1
    from public.rooms r
    where r.id = room_id
      and r.current_phase = 'results'
  )
);

create policy "Members can view their own votes"
on public.votes
for select
to authenticated
using (voter_id = auth.uid());

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'rooms'
  ) then
    alter publication supabase_realtime add table public.rooms;
  end if;

  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'room_ai_participants'
  ) then
    alter publication supabase_realtime add table public.room_ai_participants;
  end if;

  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'room_members'
  ) then
    alter publication supabase_realtime add table public.room_members;
  end if;

  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'prompts'
  ) then
    alter publication supabase_realtime add table public.prompts;
  end if;

  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'definitions'
  ) then
    alter publication supabase_realtime add table public.definitions;
  end if;

  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'published_choices'
  ) then
    alter publication supabase_realtime add table public.published_choices;
  end if;

  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'votes'
  ) then
    alter publication supabase_realtime add table public.votes;
  end if;
end $$;
