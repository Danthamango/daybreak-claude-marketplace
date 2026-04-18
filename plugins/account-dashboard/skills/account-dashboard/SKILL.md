---
name: account-dashboard
description: >
  Generate a Daybreak-branded executive dashboard (single self-contained HTML file)
  for any Billing partner account in Salesforce. Auto-resolves the account hierarchy
  (Organization / Billing Location / Location), pulls patient funnel data, and
  produces a shareable dashboard with KPIs (submitted, ordered, not ordered,
  delivered), SLA averages per step, a submissions-vs-deliveries trend chart, and
  per-patient tables scoped by time window (today / 7d / 30d / last month / 90d)
  and by location or state. Designed to be shared with external executives who do
  not have Salesforce access. Use this skill when the user says "run the account
  dashboard", "build an executive dashboard for [account]", "partner dashboard",
  "billing account dashboard", "executive dashboard for [account]", "external
  dashboard for [account]", or anything about producing a shareable executive
  view of a partner's patient pipeline.
---

# Account Executive Dashboard

Produces a single self-contained HTML dashboard for any partner account. The
output file embeds all patient data as JSON and filters client-side, so it works
fully offline and can be hosted statically (e.g., Netlify) with no backend.

## What it shows

- **KPI tiles** (period-scoped, except "Not Ordered" which is all-time):
  - Submitted — new patients in window
  - Ordered — devices ordered in window
  - Not Ordered — activated patients awaiting consent hold release
  - Delivered — devices delivered in window
- **Avg time per step** (all-time, scope-filtered):
  - Submit → Activate
  - Activate → Order
  - Order → Deliver
- **Trend chart** — daily submissions vs deliveries across the selected window
- **Patient tables** (top 50 each, sorted newest-first, PHI-safe IDs).
  Each table shows ~3 rows at a time with a vertical scroll bar and a sticky
  header row.
  - Recently submitted
  - Unactivated (submitted >3d ago, no Auth0 login)
  - Not ordered (activated but `Patient_Consent_Hold_Released__c` is false)
  - Recently delivered

## Scope and period selectors (client-side)

The generated HTML includes two selectors in the header:

- **Scope**: All `<account name>` / by State / by individual Location.
  The "All" label is generated from the resolved root account name.
  Locations or states with an unknown state are surfaced without the
  "(Unknown)" suffix and are excluded from the State list.
- **Period**: Today / 7 days / 30 days / Last month / 90 days

All filtering is done in the browser against the embedded JSON — no re-run
required to switch scope or period.

## Prerequisites

- Salesforce CLI (`sf`) authenticated as a user with read access to the target
  Accounts and Contacts.
- Node.js on PATH:
  ```
  export PATH="/c/Program Files/nodejs:/c/Users/PC/AppData/Roaming/npm:$PATH"
  ```

## PHI convention

Patient identifier on the dashboard follows this precedence:

1. `Patient_ID__c`
2. `Referral_MRN__c`
3. Constructed `<LastName>-<last 4 of Contact Id>` fallback

Never renders full names.

## How to run

```bash
node .claude/skills/account-dashboard/generate.js --account "<name-or-id>"
```

### Options

| Flag | Default | Notes |
|---|---|---|
| `--account` | (required) | Account name (fuzzy) or 18-char Account Id. Accepts Organization, Billing Location, or Location record types. |
| `--out` | `output/account-dashboard/<slug>.html` | Output file path. |
| `--help` | — | Show help. |

### Examples

```bash
# Organization-level (expands to all Billing Locations and their Locations)
node .claude/skills/account-dashboard/generate.js --account "Advent Org"

# Fuzzy match on a well-known name
node .claude/skills/account-dashboard/generate.js --account "Advent"

# By Id, custom output path
node .claude/skills/account-dashboard/generate.js --account 001TN00000LlMgvYAF --out /tmp/advent.html
```

## Execution steps (for Claude)

When the user invokes this skill:

### Step 1: Verify prerequisites

```bash
sf org display user --json
```

If not authenticated, tell the user to run `sf org login web` first.

### Step 2: Confirm the target account

Ask the user which account, unless one is already specified. Example:
"Which account should the dashboard cover? (name or Id)". If the user-supplied
name is ambiguous, the script will error with the list of matches — re-prompt
with the full name or an Id.

### Step 3: Run the generator

```bash
node .claude/skills/account-dashboard/generate.js --account "<user input>"
```

### Step 4: Report back

- Path to the generated HTML
- Count of locations and patients
- Optionally open the file in the default browser if the user asks

### Step 5 (optional): Host on Netlify

If the user wants a shareable URL that updates daily, set up Netlify once:

```bash
# One-time (per site)
npx netlify-cli sites:create --name <account-slug>-dashboard

# Deploy
npx netlify-cli deploy --prod --dir output/account-dashboard --site <site-id>
```

Then schedule a daily regeneration + deploy via Windows Task Scheduler (or cron
on Mac/Linux). See the `daily-refresh` section below.

## Daily refresh (Windows Task Scheduler)

Create a `.bat` file at `scripts/refresh-account-dashboard.bat`:

```bat
@echo off
cd /d "%~dp0..\"
"C:\Program Files\nodejs\node.exe" .claude\skills\account-dashboard\generate.js --account "Advent Org"
npx netlify-cli deploy --prod --dir output\account-dashboard --site <site-id>
```

Register with Task Scheduler:

```
schtasks /Create /SC DAILY /TN "AccountDashboard_Advent" /TR "C:\path\to\scripts\refresh-account-dashboard.bat" /ST 06:00
```

## Error handling

- No matches for `--account`: script errors — prompt user for exact name or Id.
- Ambiguous match: script errors with list — re-prompt.
- Root record type not Organization/Billing/Location: script errors with the
  type it found. Surface to user; do not retry.
- Zero contacts under the resolved locations: dashboard still renders with
  empty tables and a note in the counts.

## Field references

Queried from `Contact`:

| Field | Used for |
|---|---|
| `CreatedDate` | Submission date |
| `Auth0_Registration_Date__c` | Activation date |
| `Patient_Consent_Hold_Released__c` | "Ordered" boolean |
| `Patient_Consent_Hold_Released_Date__c` | Order date |
| `MAD_Shipped_Date__c` | Ship date (reserved for future) |
| `MAD_Delivered_Date__c` | Delivery date |
| `Patient_ID__c`, `Referral_MRN__c`, `LastName`, `Id` | PHI-safe identifier |

Queried from `Account` for scope/state:

| Field | Used for |
|---|---|
| `RecordType.Name` | Hierarchy routing (Organization / Billing Location / Location) |
| `ParentId` | Tree traversal |
| `BillingState`, `ShippingState` | State rollup for the scope selector |

## Brand

Uses the Daybreak brand kit (Sunlight, Deep Sleep, Pillow, Sky, Linen) defined
in `.claude/skills/partner-report/references/brand.md`. Inline CSS in the
template mirrors those values.
