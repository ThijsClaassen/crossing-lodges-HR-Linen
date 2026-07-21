# Crossing Lodges — HR & Housekeeping App

A standalone React + Vite app for employee records, uniform issuing,
linen stock, and staff contracts — the third department app, sharing the
same Supabase project as `crossing-lodges-ops`, `crossing-lodges-beverage`,
and `crossing-lodges-food` (this one uses the `hr_` table prefix).

Unlike the other three apps, this one tracks people and durable goods, not
consumable stock with monthly costing — there's no weighted-average cost
engine here, just current stock levels with reorder alerts, and a
per-employee issue/replace/return history for uniforms.

## What's here

- **Dashboard** (Admin+) — low-stock alerts for uniforms and linen, plus
  (HR Admin only) contracts expiring within 60 days.
- **Employees** (Admin+) — one list per lodge: name, position, department,
  start date, contact details, status.
- **Uniforms** (all roles) — a shared item catalog (add each size as its
  own item, e.g. "Polo Shirt" size M and size L as two rows), per-lodge
  stock levels, and three actions: **Issue** (assign to an employee, stock
  -1), **Broken — replace** (retires the old one, issues a fresh one,
  stock -1 again — the broken item does not return to available stock),
  and **Return** (employee leaves or hands it back in good condition,
  stock +1). Full history per employee.
- **Linen** (all roles) — a shared item catalog (duvets, pillow covers,
  towels, serviettes, gowns, broken down by size where it applies),
  per-lodge stock levels, and a movement log (Received adds to stock; Lost,
  Damaged, and Other all subtract).
- **Suppliers** (Admin+) — one shared list (not per-lodge), used for both
  uniforms and linen.
- **Orders** (Admin+) — low-stock uniforms and linen combined, grouped by
  supplier, each with a Copy list button — same pattern as Beverage/Food.
- **Contracts** (HR Admin only) — full history per employee: contract
  type, start/end date, salary, medical aid, pension fund. "Current"
  contract is whichever has the latest start date, not a separate status
  field, so nothing needs to be kept in sync when a new one is added.

## Three login tiers

Same shared-password pattern as the other apps, but three tiers this time
because of how sensitive contract data is:

- **Staff** — Uniforms (issue/replace/return) and Linen (log movements) only.
- **Admin** — all of Staff, plus Employees, item catalogs, Suppliers, Orders.
- **HR Admin** — all of Admin, plus Contracts (salary, medical aid, pension).

Contracts are only ever fetched from the database when logged in as HR
Admin — a Staff or Admin session never even requests that data, on top of
the tab being hidden. Same honest caveat as always, though: this is a
**client-side gate**, not database-enforced. All three roles share the
same anon key, so the split controls what the app *shows*, not what the
database technically *allows*. Worth knowing given the sensitivity of
salary data specifically — if that ever needs to be a hard boundary rather
than a client-side one, the fix is real per-user Supabase Auth logins
instead of shared passwords, which is a bigger change than this app makes
today.

## 1. Database setup

1. Open the Supabase SQL editor for the shared project
   (`https://arrendpmuwdhrfwvokhv.supabase.co`).
2. Run `supabase/schema.sql` — creates all `hr_*` tables with the same
   open `allow_all` RLS style the other apps use (`hr_access` is
   read-only from the client).
3. **Change the three default passwords** immediately: Table Editor →
   `hr_access` → edit the `password` cell for `staff`, `admin`, and
   `hradmin` (they start as `ChangeMe-Staff1`, `ChangeMe-Admin1`,
   `ChangeMe-HRAdmin1`).
4. There's no seed data this time — start by adding a few uniform/linen
   catalog items and suppliers on their respective tabs, then add your
   employees.

## 2. Run locally / deploy

Same as the other three apps:

```
npm install
npm run dev
```

Push to a new GitHub repo (e.g. `crossing-lodges-hr`), import into Vercel,
done — no environment variables needed since credentials are baked into
`src/sb.js`.

## Design notes worth knowing

- **Item catalogs are shared across all three lodges** (one "Polo Shirt —
  M" exists once), but **stock levels are tracked per lodge** — you
  confirmed this since sizes/types are the same everywhere, only
  quantities differ.
- **Suppliers are one shared list**, not per-lodge, same reasoning.
- **No barcode scanning** in this app — there's no natural fit for
  scanning staff or bedding the way there is for bottles and cans, so it
  wasn't carried over from Beverage/Food.
- **Uniform "on hand" stock is edited directly** by Admin+ when new stock
  arrives — there's no separate purchases log, matching the "simpler
  running stock level" you asked for over the full Beverage/Food costing
  engine.
