// SUPERSEDED — do not deploy this file.
//
// User creation moved to a single centralized Edge Function in the Finance
// Dashboard repo (Thijs, 2026-08-09), so there's one Users screen for every
// app instead of a separate one per app. Deploy this instead:
//
//   crossing-lodges-budget/supabase/admin-create-user.ts
//
// (crossing-lodges-budget is the Finance Dashboard app's repo, inside your
// CL Dashboard folder.) Edge Functions live at the Supabase project level,
// not per app repo, so deploying it once there makes it callable from
// every app — nothing app-specific needs to be deployed here.
