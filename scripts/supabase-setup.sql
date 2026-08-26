-- SeasonalityTool — run this once in the Supabase SQL Editor
-- (Project → SQL Editor → New query → paste → Run).
--
-- Creates a `profiles` table that tracks whether each signed-up user has an
-- active subscription (`is_pro`). New rows are created automatically when
-- someone signs up. Users can read their own row but cannot write `is_pro`
-- themselves — that flag is only ever flipped server-side later, once
-- Stripe webhooks are wired up, using the service_role key (never the
-- publishable key the app itself uses).

create table if not exists public.profiles (
  id uuid references auth.users on delete cascade primary key,
  email text,
  is_pro boolean not null default false,
  stripe_customer_id text,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Users may read only their own profile row.
create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = id);

-- Automatically create a profile row (is_pro = false) whenever someone signs up.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
