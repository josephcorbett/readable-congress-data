import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Bill, Member, Vote } from "../../readable-congress-web/src/types/domain";

const PACKAGE_ROOT = resolve(process.cwd());
const DATA_ROOT = resolve(PACKAGE_ROOT, "data/congress/119");
const INDEXES_DIR = resolve(PACKAGE_ROOT, "indexes");

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
    `Validated ${bills.length} bills, ${votes.length} votes, ${members.length} members, and 4 indexes.`
  );
}

main();
