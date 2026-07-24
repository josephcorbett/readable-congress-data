# readable-congress-data

Normalized, versioned legislative data for [Readable Congress](https://github.com/josephcorbett/readable-congress-data).

## Layout

```text
data/
  congress/119/
    bills/          one JSON file per bill ({id}.json)
    votes/          one JSON file per vote ({id}.json)
    members/        one JSON file per member ({bioguideId}.json)
indexes/
  bills-recent.json
  bills-active.json
  votes-recent.json
  members-current.json
schemas/
  bill.schema.json
  vote.schema.json
  member.schema.json
scripts/
  fetch-sample-data.ts
  validate-data.ts
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

The private web app reads from `indexes/` in this repo during local development.

## Data contract

Record shapes match the TypeScript domain types in `../readable-congress-web/src/types/domain.ts`. JSON Schema copies live in `schemas/` for validation and external consumers.
