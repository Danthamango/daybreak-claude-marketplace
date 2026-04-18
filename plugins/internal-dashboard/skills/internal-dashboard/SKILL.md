---
name: internal-dashboard
description: >
  Generate a Daybreak-branded INTERNAL daily dashboard (single self-contained HTML file)
  for the current user's partner accounts. Unlike /partner-report (external-facing,
  PHI-safe IDs) and /account-dashboard (single-account executive view), this is built
  for the Daybreak team to action first thing in the morning — shows full patient names
  linked to their Salesforce Contact record, period comparisons (Today / Yesterday / 7d / MTD
  vs goal), tabbed layout (Morning Briefing, Action Queue, Recent Activity, Accounts, All
  Patients), and client-side slider filters for days-stuck / days-since-activity. All
  patient tables sort newest-first. Use this skill when the user says "internal dashboard",
  "morning dashboard", "daily dashboard", "team dashboard", "run the internal dashboard",
  "run the daily briefing", or anything about producing an actionable internal worklist
  for the Daybreak team.
---

# Internal Daily Dashboard

Built for the Daybreak team to open first thing each morning and act on. Unlike the
partner-facing report, this dashboard:

- Shows **full patient names** (not PHI-safe IDs)
- Every patient links directly to their **Salesforce Contact** record
- Has **period comparisons**: Today / Yesterday / Last 7 days / Month-to-date vs monthly goal
- Uses **tabs** for morning workflow: Briefing → Action Queue → Recent → Accounts → Patients
- Includes **interactive sliders** for days-stuck, days-since-activity, etc.
- Sorts every patient table **newest-first**

## Tabs

1. **Morning Briefing** — KPI tiles (submissions, activations, conversions, deliveries) with Today / Yesterday / 7d / MTD columns and a goal progress bar. Alerts for fresh unactivated, aging holds, long-stuck patients.
2. **Action Queue** — Patients needing action, grouped by blocker (Awaiting activation, Holds to release, Rx needed, Conversions pending). Each group has its own days-range slider.
3. **Recent Activity** — Chronological feed (last 30 days by default) of submissions, activations, deliveries, conversions. Filter by event type and partner.
4. **Accounts** — Per-partner summary table (active count, new this week, stuck count, conversion rate). Click to drill into `/partner-report` location for deeper view.
5. **All Patients** — Searchable table of every active patient, sortable columns, filters for partner / stage / severity, sliders for days-stuck and days-since-activity.

## Salesforce link pattern

Each patient name renders as:
`https://daybreak.my.salesforce.com/<15-char Contact Id>`

Works from both Lightning and Classic (SF auto-routes).

## Monthly goals

Goals drive the MTD progress bars. Edit the `MONTHLY_GOALS` constant at the top of
`runner.js`, or pass via CLI flags:

```
--goal-submissions 200 --goal-activations 180
--goal-conversions 100 --goal-deliveries 120
```

When a goal is 0 (default), the MTD tile shows actuals without a progress bar.

## How to run

```bash
node .claude/skills/internal-dashboard/runner.js [options]
```

### Options

| Flag | Default | Notes |
|---|---|---|
| `--accounts` | all Location accounts owned by current user | Comma-separated Account IDs. When explicit, bypasses OwnerId filter. |
| `--out` | `output/internal-dashboard/dashboard.html` | Output path (single file) |
| `--goal-submissions` | 0 | Monthly submission goal |
| `--goal-activations` | 0 | Monthly activation goal |
| `--goal-conversions` | 0 | Monthly conversion (S2) goal — referral only |
| `--goal-deliveries` | 0 | Monthly device-delivery goal |
| `--dry-run` | false | Queries + logs counts, skips file write |

## Prerequisites

- Salesforce CLI (`sf`) authenticated
- Node.js on PATH

## PHI note

This dashboard embeds full patient names and Salesforce Contact IDs. **Do not share
externally.** For external partner sharing, use `/partner-report` (PHI-safe) instead.

## Execution steps (for Claude)

1. Run `sf org display user --json` to confirm auth.
2. Run `node .claude/skills/internal-dashboard/runner.js` with any user-supplied goal flags.
3. Report back: path to the HTML, active patient count, alert count.
4. Open in browser on request.

## Brand

Uses the Daybreak brand kit (Sunlight, Deep Sleep, Pillow, Sky, Linen) shared with
`/partner-report` and `/account-dashboard`.
