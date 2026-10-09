-- Rodina – upratanie oprávnení na funkcie (ZATIAĽ NEAPLIKOVANÉ – vyžaduje potvrdenie v Supabase)
-- Funkcie sú bezpečné aj bez tohto kroku (bez prihlásenia vracajú false alebo chybu),
-- toto len odstráni upozornenia bezpečnostného poradcu.

revoke execute on function handle_new_user() from public, anon, authenticated;
revoke execute on function is_member(uuid), is_admin(uuid), shares_household(uuid), can_see_health(uuid),
  person_in(uuid, uuid), vehicle_in(uuid, uuid),
  create_household(text, text), accept_invitation(text, text),
  set_health_visibility(uuid, health_visibility, uuid[]), invitation_info(text)
  from public, anon;
grant execute on function is_member(uuid), is_admin(uuid), shares_household(uuid), can_see_health(uuid),
  person_in(uuid, uuid), vehicle_in(uuid, uuid),
  create_household(text, text), accept_invitation(text, text),
  set_health_visibility(uuid, health_visibility, uuid[]), invitation_info(text)
  to authenticated;
grant execute on function invitation_info(text) to anon;
