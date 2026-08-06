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

- **Dashboard** (Admin+) — employee count, low-stock alerts for uniforms
  and linen, total stock value (uniforms + linen), write-offs for the
  selected year (broken uniforms, lost/damaged linen) with count and
  rand value, plus (HR Admin only) contracts expiring within 60 days.
- **Employees** (Admin+) — **one company-wide list**, not split by lodge —
  people work across all three properties, so there's a single record per
  person: name, position, department, start date, contact details, status.
  A **Today** column shows each person's live status at a glance (Working
  — with the lodge they're assigned to, Off, On leave, or "—" if they're
  not on the rotation), calculated from the Schedule tab. **Position**
  works the same way as Linen categories — pick from what's already in
  use, or "+ Add new position…" to type one on the spot (on both the Add
  employee form and the inline edit in the table); it also drives the
  grouping and headcount on the Schedule tab.
- **Schedule** (Admin+) — the work-cycle builder. See "Work schedule &
  leave" below.
- **Leave** (Admin+) — annual leave allowance, logging, and balances. See
  "Work schedule & leave" below.
- **Uniforms** (all roles) — a shared item catalog (add each size as its
  own item, e.g. "Polo Shirt" size M and size L as two rows) with a price
  per item, **one company-wide stock pool** (not per lodge — uniforms
  follow the employee, and employees aren't tied to one lodge), and three
  actions: **Issue** (assign to an employee, stock -1), **Broken —
  replace** (retires the old one, issues a fresh one, stock -1 again — the
  broken item does not return to available stock, and counts as a
  write-off valued at the item's price), and **Return** (employee leaves
  or hands it back in good condition, stock +1). Full history per
  employee, with a stock-value column (price × on hand) on the stock
  table. **HR Admin only** can also delete a row from an employee's
  history — for cleaning up a mistaken entry (wrong item clicked, etc.)
  rather than leaving it cluttering the list forever. Deleting a
  still-issued row puts that unit back into available stock (it was never
  really taken); deleting a closed broken/returned row is just a display
  cleanup and doesn't touch stock, since that row's stock effect already
  happened. Every delete needs a second click to confirm.
- **Linen** (all roles) — the one part of the app that still splits by
  lodge, since linen physically lives at each property. A shared item
  catalog (duvets, pillow covers, towels, serviettes, gowns, broken down
  by size where it applies) with a price per item, a lodge switcher at the
  top of the tab, per-lodge stock levels with a stock-value column, and a
  movement log (Received adds to stock; Lost and Damaged both subtract and
  count as write-offs; Other is a free adjustment). Categories aren't a
  fixed list — the Add linen item form comes with a starter set (Duvets,
  Pillow Covers, Towels, Serviettes, Gowns, Other) but has a "+ Add new
  category…" option in the dropdown so you can type any category you need
  on the spot; once used on a saved item, it shows up as a normal dropdown
  choice from then on.
- **Suppliers** (Admin+) — one shared list (not per-lodge), used for both
  uniforms and linen.
- **Orders** (Admin+) — low-stock uniforms and linen combined, grouped by
  supplier, each row priced (order qty × item price) with a per-supplier
  and grand order-value total, plus a Copy list button per supplier — same
  pattern as Beverage/Food.
- **Contracts** (HR Admin only) — full history per employee: contract
  type, start/end date, salary, medical aid, pension fund. "Current"
  contract is whichever has the latest start date, not a separate status
  field, so nothing needs to be kept in sync when a new one is added.

## Work schedule & leave

Your rotation: employees work 21 days straight, then get 7 days straight
off, on repeat. This is built as a genuine "rotation calculator," not a
manually-drawn calendar — you tell it one thing per employee (a **cycle
anchor date**: any date that fell on day 1 of a known working block, past
or present) and it works out on/off for every day going forward, and
backward, forever. Nothing needs re-entering as the year rolls on.

- **Schedule tab**, top to bottom:
  1. **Weekly schedule** — the main grid, one row per employee, one column
     per week, with a strip of 7 small squares (Mon → Sun) showing
     on/off/leave per day. Cycles don't have to line up with calendar
     weeks, so a square-by-square strip (rather than one color per whole
     week) means a transition mid-week shows correctly instead of being
     forced into a box it doesn't fit. Use ← Earlier / Today / Later → to
     move through the year, and the **Filter by position** dropdown to
     narrow the grid down to one position at a time.
  2. **Headcount by position** — a compact summary table (always showing
     every position, regardless of the filter above) so you can see at a
     glance how many Housekeepers, Waiters, etc. have at least one working
     day in a given week — useful for spotting a week where a position is
     short-staffed.
  3. The detailed employee grid, grouped under a heading per position (in
     the same order as Employees tab positions), each with a count.
  4. **Cycles**, at the bottom — set/change each employee's anchor date
     here (leave it blank for anyone not on the rotation, e.g. office
     staff), with a live "today" status per person.
- **Assigning a lodge, per week**: since which lodge someone works at
  depends on their role and how busy each property is, you pick it
  manually — a small ZC/EC/SC dropdown appears under any week that
  includes working days. Unlike the first version of this feature, the
  lodge is set **per calendar week**, not once for the whole 21-day block —
  so if someone splits a working stretch between two lodges, just pick a
  different one on the relevant week's dropdown.
- **Positions**: set on the Employees tab (see below) and drive the
  grouping/headcount on the Schedule tab.
- **Leave tab**: set each person's **annual allowance** (days per calendar
  year — this is an ongoing policy figure, not something you reset every
  January; the balance table always shows the count for whichever year
  you're viewing). **Log leave** by picking an employee and a date range —
  those dates immediately show as "On leave" on the Schedule tab and
  Employees tab, overriding whatever their cycle said. Only the days in
  that range that were already a scheduled **working** day count against
  the balance — a leave day that lands on a day they were off anyway is
  free, per how you wanted it to work. The days-used figure is locked in
  the moment you log the leave, so changing someone's cycle anchor later
  won't silently rewrite old balances. Delete a mistaken entry (two-click
  confirm) and the balance recalculates automatically.

## Three login tiers

Same shared-password pattern as the other apps, but three tiers this time
because of how sensitive contract data is:

- **Staff** — Uniforms (issue/replace/return) and Linen (log movements) only.
- **Admin** — all of Staff, plus Employees, Schedule, Leave, item catalogs,
  Suppliers, Orders.
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

**If this is a fresh install** (nothing deployed yet):

1. Open the Supabase SQL editor for the shared project
   (`https://arrendpmuwdhrfwvokhv.supabase.co`).
2. Run `supabase/schema.sql` — creates all `hr_*` tables with the same
   open `allow_all` RLS style the other apps use (`hr_access` is
   read-only from the client). This version already has the company-wide
   employee/uniform model, item prices, and the work-schedule/leave
   tables built in.
3. **Change the three default passwords** immediately: Table Editor →
   `hr_access` → edit the `password` cell for `staff`, `admin`, and
   `hradmin` (they start as `ChangeMe-Staff1`, `ChangeMe-Admin1`,
   `ChangeMe-HRAdmin1`).
4. There's no seed data this time — start by adding a few uniform/linen
   catalog items (with prices) and suppliers on their respective tabs,
   then add your employees.

**If you already deployed the earlier per-lodge version of this app**,
run `supabase/migration_v2.sql` once in the SQL editor instead of the
full schema. It: drops the lodge split from Employees and Uniforms,
consolidates any existing per-lodge uniform stock into one row per item
(summing quantities rather than discarding data), and adds a `price`
column to both the uniform and linen item catalogs (defaults to 0 — go
into Uniforms/Linen and fill in prices afterwards so the stock-value,
order-value, and write-off figures on the Dashboard and Orders tab are
accurate). It's safe to run on a live database with existing data.

**Already on v2 (company-wide employees/uniforms, item prices)?** Run
`supabase/migration_v3.sql` — adds the work-schedule builder: a
`cycle_anchor_date` and `annual_leave_days` column on `hr_employees`, plus
two new tables, `hr_schedule_locations` (which lodge each working block is
assigned to) and `hr_leave` (logged leave periods). Purely additive and
safe to run on a live database — every employee starts with no cycle
anchor set (so nobody shows up in the rotation until you set one on the
Schedule tab) and 0 annual leave days (set each person's real allowance on
the Leave tab afterwards).

**Already on v3 (schedule/leave tables exist)?** Run
`supabase/migration_v4.sql` — changes lodge assignment from "once per
21-day working block" to "once per calendar week," per your feedback.
Purely a rename + constraint change, safe to run on a live database; if
you'd already assigned a lodge to a block under the old system, just
re-pick it per week on the Schedule tab afterwards (it only takes a
second, and most people hadn't set many yet since this shipped right
alongside v3).

## 2. Run locally / deploy

Same as the other three apps:

```
npm install
npm run dev
```

Push to a new GitHub repo (e.g. `crossing-lodges-hr`), import into Vercel,
done — no environment variables needed since credentials are baked into
`src/sb.js`.

## Mobile navigation

Bottom nav is a single "Menu" button, not a row of tabs. HR Admin has 9
tabs; a horizontal-scroll bar either clipped tabs off the edge of the
screen or needed a swipe gesture nobody discovered on their own — on a
phone, several tabs were simply unreachable. Tapping the Menu button opens
a bottom sheet listing every tab for the current role (Staff/Admin/HR
Admin see different lists), current one highlighted; tap one to switch
and the sheet closes. Scales cleanly no matter how many tabs get added
later.

## Design notes worth knowing

- **Employees, Uniforms, Suppliers, and Contracts are all company-wide**
  — one list/pool, not split by lodge. People work across all three
  properties, and uniforms are issued to a person, not a lodge, so
  splitting them by location didn't reflect how the business actually
  runs. This was a deliberate change from the app's first version, which
  did split employees and uniform stock by lodge.
- **Linen is the one exception** — it's tracked per lodge, since bedding
  and towels physically live at each property and don't move around with
  people. The Linen tab has its own lodge switcher at the top; every other
  tab has none.
- **Prices live on both item catalogs** (Uniforms and Linen), feeding
  three budgeting figures: stock value (price × qty on hand, shown on
  both stock tables and totalled on the Dashboard), order value (price ×
  order qty, shown per line and totalled per supplier + grand total on
  Orders), and write-off value (broken uniforms + lost/damaged linen,
  valued at the item's price, filterable by year on the Dashboard).
- **No barcode scanning** in this app — there's no natural fit for
  scanning staff or bedding the way there is for bottles and cans, so it
  wasn't carried over from Beverage/Food.
- **Uniform "on hand" stock is edited directly** by Admin+ when new stock
  arrives — there's no separate purchases log, matching the "simpler
  running stock level" you asked for over the full Beverage/Food costing
  engine.
- **Cycles are calculated, not stored day-by-day.** An employee's on/off
  status for any date is worked out live from their anchor date — there's
  no table of "Monday: on, Tuesday: on, ..." rows to maintain, which is
  why nothing needs to be regenerated or re-entered as time passes. This
  also means changing an anchor date instantly recalculates that person's
  whole future (and past) schedule.
- **Leave year is calendar-based (Jan–Dec), shared by everyone** — matches
  what you asked for. A leave period that crosses a year boundary (e.g.
  27 Dec – 3 Jan) has its full days-used total attributed to the year it
  *starts* in, as a simplification.
- **Lodge assignment is manual, not automatic** — the app doesn't try to
  guess which property needs staff most; it just gives you a place to
  record the decision once per working block instead of once per week.
