/**
 * Rebuilds discovery + changes indexes from on-disk records and daily event files.
 *
 * Usage: npm run build-indexes
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Bill, Member, Vote } from "../../readable-congress-web/src/types/domain";
import {
  buildChangesRecentIndex,
  writeChangesRecentIndex,
} from "./lib/changes";

interface IndexEnvelope<T> {
  generatedAt: string;
  source: string;
  mode: string;
  items: T[];
}

const PACKAGE_ROOT = resolve(process.cwd());
const DATA_119 = resolve(PACKAGE_ROOT, "data/congress/119");
const INDEXES_DIR = resolve(PACKAGE_ROOT, "indexes");
const CHANGES_DIR = resolve(PACKAGE_ROOT, "changes");

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

function readRecordsFromDir<T>(dir: string): T[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => readJsonFile<T>(resolve(dir, f)));
  } catch {
    return [];
  }
}

function writeIndex<T>(filename: string, items: T[], generatedAt: string): void {
  const envelope: IndexEnvelope<T> = {
    generatedAt,
    source: "manual rebuild",
    mode: "rebuild",
    items,
  };
  const filePath = resolve(INDEXES_DIR, filename);
  writeFileSync(filePath, JSON.stringify(envelope, null, 2));
  console.log(`  wrote ${filename} (${items.length} items)`);
}

function main(): void {
  mkdirSync(INDEXES_DIR, { recursive: true });

  const bills = readRecordsFromDir<Bill>(resolve(DATA_119, "bills"));
  const votes = readRecordsFromDir<Vote>(resolve(DATA_119, "votes"));
  const members = readRecordsFromDir<Member>(resolve(DATA_119, "members"));

  console.log(
    `Building indexes from ${bills.length} bills, ${votes.length} votes, ${members.length} members…`
  );

  const generatedAt = new Date().toISOString();

  const billsRecent = [...bills].sort(
    (a, b) =>
      new Date(b.latestAction.date).getTime() - new Date(a.latestAction.date).getTime() ||
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
  const billsActive = bills.filter((b) => b.status !== "inactive");
  const votesRecent = [...votes].sort(
    (a, b) =>
      new Date(b.date).getTime() - new Date(a.date).getTime() || b.rollNumber - a.rollNumber
  );
  const membersCurrent = [...members].sort((a, b) => a.lastName.localeCompare(b.lastName));

  writeIndex("bills-recent.json", billsRecent.slice(0, 50), generatedAt);
  writeIndex("bills-active.json", billsActive, generatedAt);
  writeIndex("votes-recent.json", votesRecent.slice(0, 50), generatedAt);
  writeIndex("members-current.json", membersCurrent, generatedAt);

  const changesRecent = buildChangesRecentIndex(CHANGES_DIR, generatedAt);
  writeChangesRecentIndex(INDEXES_DIR, changesRecent);
  console.log(`  wrote changes-recent.json (${changesRecent.items.length} items)`);

  console.log("Done.");
}

main();
