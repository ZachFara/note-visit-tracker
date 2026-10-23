# Note Visit Tracker

Obsidian plugin that tracks how often notes get opened and how long they stay actively
in view, so trending/popular notes can be found and cleaned up or summarized.

## Features

- **Opens tracking** with a per-note cooldown (default 5 minutes) so rapid
  back-and-forth clicking doesn't inflate the count.
- **Active-duration tracking**: ticks every 15s while there's been mouse, keyboard,
  scroll, or touch activity within an idle threshold (default 3 minutes). No special
  sleep-detection needed — no activity events fire during sleep, so the gap since the
  last activity reads as idle the moment the machine wakes, however long it slept.
- **Freeform date ranges** in the view (not fixed 30/60/90-day buckets), with
  7d/30d/90d/365d/All-time as presets that just fill the date pickers.
- **Rename/move-safe**: listens for the vault's rename event and migrates stats to the
  new path instead of losing history when a note moves or gets renamed.
- **Survives moves made outside Obsidian** (scripts, Finder, sync). Obsidian reports those
  as a delete plus a create, which used to wipe the note's history. Now a deleted note's
  entry is parked as "pending" for 30 days and re-attached when a matching file appears.
  Matching, in order of confidence: the same path is back; exactly one file has the same
  creation time (`ctime`, recorded per note; survives moves and renames); exactly one
  untracked file has the same name. Ambiguous matches are left pending, never guessed.
  Also runs at startup, so moves made while Obsidian was closed are caught too.
- **Daily backups**: a snapshot named `data_YYYY-MM-DD.json` is written next to `data.json`
  at startup and when the date rolls over; only the newest 2 are kept. The command
  "Back up tracker data now" forces one. Empty data is never backed up, so a wiped
  `data.json` can't overwrite a good snapshot.
- **Tags tab**: aggregates opens and active time by each note's current tags, alongside
  the per-note Notes tab.
- Data lives in the plugin's own `data.json`, not written into the vault as a note. It holds
  `settings`, `notes` and `pending` (entries waiting to be re-attached).

## Files

- `manifest.json`, `main.js`, `styles.css` — the plugin itself.
- `deploy.sh` — copies those three files into the vault's
  `.obsidian/plugins/note-visit-tracker/` folder. Run after any change here.

## Deploying

```bash
./deploy.sh                  # deploys to the default (MaghzDovom) vault
./deploy.sh /path/to/vault   # or deploy to a different vault
```

Then in Obsidian: Cmd+P -> "Reload app without saving" to pick up the change.

`deploy.sh` never touches `data.json` in the vault — that's the plugin's runtime data
(visit counts, active time) and isn't part of this repo.

## Settings

Configurable from Obsidian's Settings -> Note Visit Tracker:

- Track non-markdown files
- Default range (days) for the view
- Visit cooldown (minutes)
- Idle threshold (minutes)
- Minimum visits to display
- Excluded folders
- One-time import from the old Note Open Tracker Plus plugin's event log
