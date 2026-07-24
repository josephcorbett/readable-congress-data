# readable-congress-data

Normalized, versioned legislative data for [Readable Congress](https://github.com/josephcorbett/readable-congress-data).

## Layout

```text
data/
  congress/119/
    bills/          one JSON file per bill ({id}.json) — accumulates over syncs
    votes/          one JSON file per vote ({id}.json)
    members/        one JSON file per member ({bioguideId}.json)
indexes/
  bills-recent.json
  bills-active.json
  votes-recent.json
  members-current.json
  changes-recent.json   derived change feed for the web app
changes/
  events/YYYY/MM/DD.json   daily change-event files
snapshots/
  latest.json              last sync fingerprint/baseline marker
  {syncId}.json            retained sync manifests
schemas/
  bill.schema.json
  vote.schema.json
  member.schema.json
  change-event.schema.json
scripts/
  fetch-sample-data.ts
  build-indexes.ts
  validate-data.ts
  lib/changes.ts
```

## Scripts

From this repository root:

```bash
npm install
# Set CONGRESS_GOV_API_KEY in .env.local
npm run fetch -- --mode recent --bills 25 --votes 25 --members 50
npm run fetch -- --mode smoke --bills 10 --votes 10 --members 20
npm run build-indexes
npm run validate
```

From the web repo, pass args after `--`:

```bash
npm run data:fetch -- --mode recent --bills 25 --votes 25 --members 50
```

## Change tracking (Phase 4A)

- Fetches **accumulate** into `data/` (records are upserted; older tracked IDs are kept).
- The first sync after Phase 4A establishes a **baseline** snapshot and emits **no** change events (clean epoch).
- Later syncs diff against on-disk previous records and write:
  - daily files under `changes/events/`
  - derived `indexes/changes-recent.json`
- Supported event types include `bill.*`, `vote.added`, `vote.corrected`, and `member.added`.

## Data contract

Record shapes match the TypeScript domain types in `../readable-congress-web/src/types/domain.ts`. JSON Schema copies live in `schemas/` for validation and external consumers.
