---
name: account-dashboard-ops
description: >
  Generate a Daybreak-branded operations dashboard (single self-contained HTML
  file) for any Billing partner account in Salesforce. Sibling to
  /account-dashboard, but action-focused rather than executive: surfaces the
  specific patients that need operational follow-up (collect out-of-pocket cost,
  release pre-auth, chase impression kits, etc.). Tab-based layout with newest
  patients highlighted first. Designed to be shared with ops-facing staff at
  partner organizations (billing coordinators, case managers) so they can work
  the list directly without Salesforce access. Use this skill when the user says
  "run the ops dashboard", "build an ops dashboard for [account]", "operations
  dashboard", "partner ops dashboard", "action dashboard for [account]", or
  anything about producing a partner-facing action/work-list view of the patient
  pipeline.
---

# Account Operations Dashboard

Produces a single self-contained HTML dashboard for any partner account that
surfaces **patients requiring action**, grouped into tabs by the type of
action. Complements `/account-dashboard` (executive / funnel view) by giving
the operations team at a partner org a clickable work-list.

## What it shows

**Backlog KPIs** (all-time, scope-filtered) — quick "how big is the pile"
counts across the top:

- Unactivated (>3d) — submitted, no Auth0 login
- Needs OOP call — activated, `Patient_Consent_Hold_Released__c == false`
- Pre-auth pending — consent released, `Pre_Authorization_Hold_Released__c == false`
- In manufacturing — `Days_Since_MAD_Manufacturing_Started__c != null` and not delivered
- Bad impressions — `Bad_Impression_Date__c != null`

**Tabs** (newest patients first within each tab; stuck rows highlighted red):

1. **Unactivated** — submitted, no Auth0 registration. Red if >3 days.
2. **Unordered / Needs OOP call** — the core billing-partner action list:
   activated but `Patient_Consent_Hold_Released__c == false`. Red if >7 days
   since activation.
3. **Pre-auth pending** — consent released but `Pre_Authorization_Hold_Released__c == false`.
   Red if >5 days since order.
4. **In manufacturing** — actively being built, not yet delivered. Red if >21 days.
5. **Dental letter required** — `Absence_TMJD_Perio__c == true`.
6. **Impression kit** — three-stage view:
   - Ordered, not yet delivered to patient
   - Delivered to patient, not yet returned to scanning facility (red if >14d)
   - Returned (completed)
7. **Bad impressions** *(pinned last, visually highlighted)* — patients whose
   molds were rejected and are receiving a replacement kit.

## Scope selector

Same as `/account-dashboard`:

- All `<account name>` / by State / by individual Location
- Generated from the resolved account hierarchy (Organization / Billing
  Location / Location)

No period selector — ops work is status-based, not time-based. The tabs
show the current backlog; sorting is newest-first throughout.

## Prerequisites

- Salesforce CLI (`sf`) authenticated as a user with read access to the target
  Accounts and Contacts.
- Node.js on PATH:
  ```
  export PATH="/c/Program Files/nodejs:/c/Users/PC/AppData/Roaming/npm:$PATH"
  ```

## PHI convention

Patient identifier on the dashboard follows the same precedence as
`/account-dashboard`:

1. `Patient_ID__c`
2. `Referral_MRN__c`
3. Constructed `<LastName>-<last 4 of Contact Id>` fallback

Never renders full names.

## How to run

```bash
node .claude/skills/account-dashboard-ops/generate.js --account "<name-or-id>"
```

### Options

| Flag | Default | Notes |
|---|---|---|
| `--account` | (required) | Account name (fuzzy) or 18-char Account Id. Accepts Organization, Billing Location, or Location record types. |
| `--out` | `output/account-dashboard-ops/<slug>.html` | Output file path. |
| `--help` | — | Show help. |

### Examples

```bash
# Organization-level (expands to all Billing Locations and their Locations)
node .claude/skills/account-dashboard-ops/generate.js --account "Advent Org"

# By Id, custom output path
node .claude/skills/account-dashboard-ops/generate.js --account 001TN00000LlMgvYAF --out /tmp/advent-ops.html
```

## Execution steps (for Claude)

When the user invokes this skill:

### Step 1: Verify prerequisites

```bash
sf org display user --json
```

If not authenticated, tell the user to run `sf org login web` first.

### Step 2: Confirm the target account

Ask the user which account unless one is already specified. Example:
"Which account should the ops dashboard cover? (name or Id)". If the
user-supplied name is ambiguous, the script will error with the list of
matches — re-prompt with the full name or an Id.

### Step 3: Run the generator

```bash
node .claude/skills/account-dashboard-ops/generate.js --account "<user input>"
```

### Step 4: Report back

- Path to the generated HTML
- Total patient count and backlog counts (unactivated, needs OOP call,
  pre-auth pending, in manufacturing, bad impressions)
- Optionally open the file in the default browser if the user asks

## Field references

Queried from `Contact`:

| Field | Used for |
|---|---|
| `CreatedDate` | Submission date |
| `Auth0_Registration_Date__c` | Activation date |
| `Patient_Consent_Hold_Released__c` | "Ordered" / deal closed boolean |
| `Patient_Consent_Hold_Released_Date__c` | Order date |
| `Pre_Authorization_Hold_Released__c` | Pre-auth released (second gate before manufacturing) |
| `Days_Since_MAD_Manufacturing_Started__c` | Manufacturing duration |
| `MAD_Delivered_Date__c` | Delivery date (exit from manufacturing) |
| `Absence_TMJD_Perio__c` | Dental letter required / on file |
| `Daybreak_Impression_Kit_Ordered__c` | Impression kit ordered |
| `IK_Delivered_Date__c` | Kit delivered to patient |
| `IK_Return_Delivered_Date__c` | Kit returned to scanning facility |
| `Bad_Impression_Date__c` | Molds rejected, replacement kit sent |
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
template mirrors those values. Stuck-row highlight uses a warm red accent
(`#D94F4F`) on the Linen background.

## Error handling

- No matches for `--account`: script errors — prompt user for exact name or Id.
- Ambiguous match: script errors with list — re-prompt.
- Root record type not Organization/Billing/Location: script errors with the
  type it found. Surface to user; do not retry.
- Zero contacts under the resolved locations: dashboard still renders with
  empty tabs and a note in the counts.
