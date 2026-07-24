import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  Bill,
  ChangeEvent,
  ChangeType,
  Member,
  Vote,
} from "../../readable-congress-web/src/types/domain";

const PACKAGE_ROOT = resolve(process.cwd());
const DATA_ROOT = resolve(PACKAGE_ROOT, "data/congress/119");
const INDEXES_DIR = resolve(PACKAGE_ROOT, "indexes");
const CHANGES_DIR = resolve(PACKAGE_ROOT, "changes");
const SNAPSHOTS_DIR = resolve(PACKAGE_ROOT, "snapshots");

const CHANGE_TYPES = new Set<ChangeType>([
  "bill.added",
  "bill.status_changed",
  "bill.action_added",
  "bill.summary_changed",
  "bill.title_changed",
  "vote.added",
  "vote.corrected",
  "member.added",
]);

const errors: string[] = [];

function err(message: string): void {
  errors.push(message);
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function readIndexItems<T>(path: string): T[] {
  const raw = readJson<unknown>(path);
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const envelope = raw as { items?: T[] };
    if (Array.isArray(envelope.items)) return envelope.items;
  }
  return Array.isArray(raw) ? (raw as T[]) : [];
}

function readRecords<T>(dir: string): T[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((name) => name.endsWith(".json"));
  return files.map((name) => readJson<T>(resolve(dir, name)));
}

function validateBill(bill: Bill, path: string): void {
  if (!bill.id || !bill.title) err(`${path}: missing id or title`);
  if (bill.officialUrl === "") err(`${path}: officialUrl must be omitted, not empty string`);
  if (bill.summaryFormat === "html" && !bill.summaryHtml) {
    err(`${path}: summaryFormat html requires summaryHtml`);
  }
}

function validateVote(vote: Vote, path: string): void {
  if (vote.rollNumber <= 0) err(`${path}: rollNumber must be positive`);
  if (vote.yea + vote.nay + vote.present + vote.notVoting <= 0) {
    err(`${path}: vote totals must be non-zero`);
  }
  if (vote.officialUrl === "") err(`${path}: officialUrl must be omitted, not empty string`);
}

function validateMember(member: Member, path: string): void {
  if (member.currentTerm.congress !== 119) {
    err(`${path}: currentTerm.congress must be 119 for this sample`);
  }
  if (member.officialUrl === "") err(`${path}: officialUrl must be omitted, not empty string`);
}

function validateChangeEvent(event: ChangeEvent, path: string): void {
  if (!event.id) err(`${path}: missing id`);
  if (!event.observedAt) err(`${path}: missing observedAt`);
  if (!event.entityId) err(`${path}: missing entityId`);
  if (!event.syncId) err(`${path}: missing syncId`);
  if (!event.summary) err(`${path}: missing summary`);
  if (!["bill", "vote", "member"].includes(event.entityType)) {
    err(`${path}: invalid entityType ${event.entityType}`);
  }
  if (!CHANGE_TYPES.has(event.changeType)) {
    err(`${path}: invalid changeType ${event.changeType}`);
  }
  if (event.officialUrl === "") {
    err(`${path}: officialUrl must be omitted, not empty string`);
  }
}

function validateIndexArray<T>(
  filename: string,
  records: T[],
  validate: (record: T, path: string) => void
): void {
  if (!Array.isArray(records)) {
    err(`${filename}: expected array`);
    return;
  }
  records.forEach((record, index) => validate(record, `${filename}[${index}]`));
}

function validateUniqueIds(records: Array<{ id: string }>, label: string): void {
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.id)) err(`${label}: duplicate id ${record.id}`);
    seen.add(record.id);
  }
}

function loadAllChangeEvents(): ChangeEvent[] {
  const eventsRoot = resolve(CHANGES_DIR, "events");
  if (!existsSync(eventsRoot)) return [];
  const events: ChangeEvent[] = [];
  for (const year of readdirSync(eventsRoot)) {
    const yearDir = join(eventsRoot, year);
    for (const month of readdirSync(yearDir)) {
      const monthDir = join(yearDir, month);
      for (const name of readdirSync(monthDir)) {
        if (!name.endsWith(".json")) continue;
        const daily = readJson<{ items?: ChangeEvent[] }>(join(monthDir, name));
        if (daily.items) events.push(...daily.items);
      }
    }
  }
  return events;
}

function main(): void {
  const bills = readRecords<Bill>(resolve(DATA_ROOT, "bills"));
  const votes = readRecords<Vote>(resolve(DATA_ROOT, "votes"));
  const members = readRecords<Member>(resolve(DATA_ROOT, "members"));

  bills.forEach((bill) => validateBill(bill, `bills/${bill.id}.json`));
  votes.forEach((vote) => validateVote(vote, `votes/${vote.id}.json`));
  members.forEach((member) => validateMember(member, `members/${member.id}.json`));

  validateUniqueIds(bills, "bills");
  validateUniqueIds(votes, "votes");
  validateUniqueIds(members, "members");

  validateIndexArray(
    "indexes/bills-recent.json",
    readIndexItems<Bill>(resolve(INDEXES_DIR, "bills-recent.json")),
    validateBill
  );
  validateIndexArray(
    "indexes/bills-active.json",
    readIndexItems<Bill>(resolve(INDEXES_DIR, "bills-active.json")),
    validateBill
  );
  validateIndexArray(
    "indexes/votes-recent.json",
    readIndexItems<Vote>(resolve(INDEXES_DIR, "votes-recent.json")),
    validateVote
  );
  validateIndexArray(
    "indexes/members-current.json",
    readIndexItems<Member>(resolve(INDEXES_DIR, "members-current.json")),
    validateMember
  );

  const changesRecentPath = resolve(INDEXES_DIR, "changes-recent.json");
  if (existsSync(changesRecentPath)) {
    validateIndexArray(
      "indexes/changes-recent.json",
      readIndexItems<ChangeEvent>(changesRecentPath),
      validateChangeEvent
    );
  }

  const allEvents = loadAllChangeEvents();
  allEvents.forEach((event, index) => validateChangeEvent(event, `changes/events[${index}]`));
  validateUniqueIds(allEvents, "change events");

  const snapshotPath = resolve(SNAPSHOTS_DIR, "latest.json");
  if (existsSync(snapshotPath)) {
    const snapshot = readJson<{ syncId?: string; baseline?: boolean }>(snapshotPath);
    if (!snapshot.syncId) err("snapshots/latest.json: missing syncId");
  }

  // Guard against the historical bug where "recent" mode published opening-day 2025 data.
  const recentVotes = readIndexItems<Vote>(resolve(INDEXES_DIR, "votes-recent.json"));
  const recentBills = readIndexItems<Bill>(resolve(INDEXES_DIR, "bills-recent.json"));
  const newestVoteMs = Math.max(0, ...recentVotes.map((v) => new Date(v.date).getTime()));
  const newestActionMs = Math.max(
    0,
    ...recentBills.map((b) => new Date(b.latestAction.date).getTime())
  );
  const newestUpdateMs = Math.max(
    0,
    ...recentBills.map((b) => new Date(b.updatedAt).getTime())
  );
  const newestMs = Math.max(newestVoteMs, newestActionMs, newestUpdateMs);
  const cutoffMs = Date.now() - 90 * 24 * 60 * 60 * 1000;
  if (recentVotes.length > 0 && newestMs < cutoffMs) {
    err(
      `indexes look stale: newest activity is ${new Date(newestMs).toISOString().slice(0, 10)} ` +
        "(expected activity within ~90 days for a recent sample)"
    );
  }

  if (errors.length > 0) {
    console.error(`Validation failed with ${errors.length} error(s):`);
    for (const message of errors) console.error(`- ${message}`);
    process.exit(1);
  }

  console.log(
    `Validated ${bills.length} bills, ${votes.length} votes, ${members.length} members, ` +
      `${allEvents.length} change events, and indexes.`
  );
}

main();
