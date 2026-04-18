# DaybreakMD Claude Code Marketplace

Internal Claude Code plugin marketplace for DaybreakMD. Hosts skills,
slash commands, and agents the team uses against Salesforce.

## Plugins

| Plugin | Status | What it does |
|---|---|---|
| [account-dashboard](plugins/account-dashboard) | ✅ Ready | Generates a single-file HTML executive dashboard for any Billing partner account in Salesforce. |
| [pre-d-prospecting](plugins/pre-d-prospecting) | 🚧 WIP — Dan only | Daily physician prospecting from today's Salesforce sleep test results. Contains hardcoded paths to Dan's machine; not yet portable. Do not install. |

## Install (for teammates)

Once this repo is pushed to GitHub (private is fine), teammates run:

```
/plugin marketplace add DaybreakMD/daybreak-claude-marketplace
/plugin install account-dashboard@DaybreakMD
```

To get updates later:

```
/plugin marketplace update DaybreakMD
/plugin update account-dashboard@DaybreakMD
```

## Per-plugin prerequisites

Plugins ship code, not credentials. Each teammate needs to set up the plugin's
prereqs themselves the first time:

### account-dashboard

- Salesforce CLI (`sf`) installed and authenticated against the DaybreakMD org:
  ```
  sf org login web
  ```
- Node.js on PATH.

### pre-d-prospecting

🚧 **Not yet ready for general install.** The SKILL.md still contains paths
hardcoded to Dan's machine (Poppler binary location under `C:\Users\PC\...`,
npm global path, etc.). Needs portability cleanup before teammates can run it.
Tracked as a follow-up.

## Repository layout

```
.
├── .claude-plugin/
│   └── marketplace.json           # the marketplace manifest
├── plugins/
│   └── account-dashboard/
│       ├── .claude-plugin/
│       │   └── plugin.json        # this plugin's manifest
│       └── skills/
│           └── account-dashboard/ # the skill itself
│               ├── SKILL.md
│               ├── generate.js
│               └── template.html
└── README.md
```

## Adding a new plugin

1. Create `plugins/<plugin-name>/.claude-plugin/plugin.json`.
2. Add the skill / command / agent files under that folder
   (e.g. `plugins/<plugin-name>/skills/<skill-name>/SKILL.md`).
3. Add an entry to `.claude-plugin/marketplace.json`.
4. Bump the plugin's `version` in both files.
5. Commit + push. Teammates pick it up via `/plugin marketplace update`.

## Source-of-truth note

The `account-dashboard` skill currently lives in two places on disk:

- `..\ClaudeBrad\.claude\skills\account-dashboard\` — Dan's working copy
- `plugins/account-dashboard/skills/account-dashboard/` — what teammates install

When editing the skill, update the marketplace copy too (or, better, decide
on a single source of truth and junction the other path to it). The simplest
path forward: make the marketplace copy canonical and replace the ClaudeBrad
copy with a junction:

```
rmdir "...\ClaudeBrad\.claude\skills\account-dashboard"
mklink /J "...\ClaudeBrad\.claude\skills\account-dashboard" ^
          "...\daybreak-claude-marketplace\plugins\account-dashboard\skills\account-dashboard"
```

(The user-global junction at `~/.claude/skills/account-dashboard` already
points to the ClaudeBrad path, so it picks up the new target transparently.)
