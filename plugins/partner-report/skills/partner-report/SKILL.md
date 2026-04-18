---
name: partner-report
description: >
  Generate Daybreak-branded HTML patient-progress reports for the current user's partner accounts
  (both Billing and Referral partners) from Salesforce data. Produces one styled report per Location
  account with an Executive rollup section and an Operations stuck-patient section, saved locally
  for review before manual send. Use this skill when the user says "partner report", "run partner
  reports", "generate partner reports", "weekly partner update", "monthly partner update",
  "billing partner report", "referral partner report", "external partner reporting", or anything
  about producing branded progress reports for their partner accounts.
---

# Partner Report Generator

This skill produces polished, Daybreak-branded HTML progress reports for each of the current user's
partner accounts, pulling live data from Salesforce. It's designed as a high-influence partner
touch point — the user reviews the generated reports and sends them manually.

Each report is a single HTML file organized for action:
1. **Executive summary** — headline metrics + period deltas
2. **Full funnel** — stage-by-stage all-time conversion bars
3. **Operations · Awaiting activation** — patients submitted >1 day ago who haven't activated. Sorted newest-first. Shown before Recent submissions because downstream progress is impossible until activation.
4. **Recent submissions** — every patient new in the window, newest-first, with current stage, days-at-stage, last activity, next step, and sales notes
5. **Operations · Activated but stuck in workflow** — downstream-stage blockers (holds, Rx, conversion, etc.), newest-first
6. **Long-inactive** (collapsible) — stuck > 90 days

Per-patient tables include columns: Patient ID, Current stage (+ days-at-stage), Last activity, Reason/Next step, Recommended action, **Sales notes** (from `Sales_Notes__c`), Age, Severity.

### Parent-level rollups

When a run covers ≥2 Location accounts under the same Parent, a single `_rollup-<parent>-<variant>.html` file is also produced. It aggregates metrics/funnel/recent/stuck across all locations and includes a per-location breakdown table with links into each detail report. The rollup is listed first on the index.

## Prerequisites

- Salesforce CLI (`sf`) authenticated as the user whose accounts should be reported on
- Node.js on PATH:
  ```
  export PATH="/c/Program Files/nodejs:/c/Users/PC/AppData/Roaming/npm:$PATH"
  ```
- No other external dependencies (no npm install needed — uses only Node built-ins)

## Two partner variants

Routed automatically by reading `Parent.Billing_Model__c` on each Location account:

| Variant | Billing Model values | Funnel focus |
|---|---|---|
| **Billing** | `Billing Model`, `MD Model` | Submission → activation → impression kit → dentist review → holds released → manufacturing → delivery |
| **Referral** | `Refer Model` | Submission → activation → sleep test interpreted → Rx written → S2 conversion → therapy started |

Both `Billing Model` and `MD Model` parents route to the Billing variant (both bill for the device themselves). Only `Refer Model` goes through the D2C referral funnel.

## PHI convention

- **Primary ID**: `Patient_ID__c`
- **Fallback 1**: `Referral_MRN__c` (if partner-provided)
- **Fallback 2**: constructed `<first3>-<last3>-<DOB>` (e.g., `ABC-DEF-1985-03-12`) — only used if both IDs blank
- **Never**: full patient names on reports

## How to run

From the working directory:

```bash
node .claude/skills/partner-report/runner.js [options]
```

### Options

| Flag | Default | Notes |
|---|---|---|
| `--window` | `last-7-days` | See window formats below |
| `--accounts` | (all owned by current user) | Comma-separated Location Account IDs. **When explicit, the OwnerId filter is bypassed** so you can run partner reports for accounts owned by teammates. |
| `--out` | `output/partner-reports/<today>/` | Output directory |
| `--abandoned-days` | 90 | Stuck > N days moves to collapsible long-inactive section |
| `--no-compare` | false | Disable period-over-period delta in cards |
| `--dry-run` | false | Runs queries and logs counts but does not write files |

### Window formats

The `--window` flag accepts:

- Relative: `last-7-days`, `last-14-days`, `last-30-days`, `last-90-days`
- Month: `this-month`, `last-month`, or specific like `2026-03` (March 2026)
- Quarter: `this-quarter`, `last-quarter`
- Absolute: `2026-03-01:2026-03-31` (start:end, inclusive)

The window controls which patients are shown in the "New in this period" rollups. Stuck-patient
and overall funnel sections always reflect current state regardless of window.

## Execution steps (for Claude)

When the user invokes this skill, execute these steps:

### Step 1: Verify prerequisites

```bash
sf org display user --json
```

Confirm this returns a valid user. If not, tell the user to run `sf org login web` first.

### Step 2: Run the script

Run the runner with the user's requested window (or default). Example:

```bash
node .claude/skills/partner-report/runner.js --window last-7-days
```

The script handles:
- Resolving current user
- Querying Location accounts
- Routing billing vs referral
- Querying Contacts per account
- Computing metrics
- Rendering HTML files
- Generating an index page

### Step 3: Report back

Once the script finishes, summarize for the user:
- Number of accounts processed (split by billing / referral)
- Path to the output directory
- Path to the index page (for one-click review of all reports)
- Any accounts skipped (e.g., no Contacts, missing Billing Model on parent)

Open the index page in the default browser if the user asks.

## Stuck-patient thresholds

Default thresholds used by the runner (see `runner.js` for constants):

| Stuck reason | Condition | Section |
|---|---|---|
| Not activated | Submitted >1 day ago AND `Auth0_Registration_Date__c` is null | Awaiting activation |
| Epworth incomplete | Activated >3 days ago AND `Health_Questionnaire__c` is null | Workflow stuck |
| Consent Hold not released | Activated >7 days ago AND `Patient_Consent_Hold_Released__c` is false | Workflow stuck |
| Pre-Auth Hold not released | Activated >7 days ago AND `Pre_Authorization_Hold_Released__c` is false | Workflow stuck |
| No Rx (referral) | Activated >7 days ago AND `Most_Recent_Patient_RX__c` is null | Workflow stuck |
| No conversion (referral) | Has Rx >14 days ago AND `S2_Purchase_Date__c` is null | Workflow stuck |

To adjust thresholds, edit `STUCK_THRESHOLDS` at the top of `runner.js`. All stuck lists are sorted **newest-first** (shortest daysStuck first) so fresh cases surface before long-running ones.

## Brand

See `references/brand.md` for the full Daybreak brand kit used in the HTML template
(colors, typography, tone). Embedded CSS in the template mirrors those values.

## Error handling

- No Location accounts owned by current user: report "No accounts owned by current user" and stop
- Parent Billing Model is null: skip account, log to summary
- Account has zero Contacts: render a sparse report with "No patients in funnel yet" note
- SF query fails on a field: surface the error — do not retry or silently continue
