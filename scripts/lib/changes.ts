/**
 * Change-tracking helpers for Phase 4A.
 * Compares previous on-disk records to newly fetched records and emits events.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
  Bill,
  BillAction,
  ChangeEvent,
  ChangeType,
  Member,
  Vote,
} from "../../readable-congress-web/src/types/domain";

export interface SyncSnapshot {
  syncId: string;
  generatedAt: string;
  source: string;
  /** Epoch marker: first snapshot after Phase 4A lands emits no change events. */
  baseline: boolean;
  billIds: string[];
  voteIds: string[];
  memberIds: string[];
  fingerprints: Record<string, string>;
}

export interface IndexEnvelope<T> {
  generatedAt: string;
  source: string;
  mode: string;
  items: T[];
}

const CHANGES_RECENT_LIMIT = 100;

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 16);
}

function actionKey(action: BillAction): string {
  return `${action.date}|${action.actionCode ?? ""}|${action.text}`;
}

function billFingerprint(bill: Bill): string {
  return fingerprint({
    status: bill.status,
    title: bill.title,
    shortTitle: bill.shortTitle ?? null,
    summary: bill.summary ?? null,
    summaryHtml: bill.summaryHtml ?? null,
    latestAction: bill.latestAction,
    actions: bill.actions.map(actionKey),
    cosponsorCount: bill.cosponsorCount,
  });
}

function voteFingerprint(vote: Vote): string {
  return fingerprint({
    result: vote.result,
    yea: vote.yea,
    nay: vote.nay,
    present: vote.present,
    notVoting: vote.notVoting,
    question: vote.question,
    description: vote.description,
    date: vote.date,
    associatedBillId: vote.associatedBillId ?? null,
  });
}

function memberFingerprint(member: Member): string {
  return fingerprint({
    name: member.name,
    party: member.party,
    chamber: member.chamber,
    state: member.state,
    stateCode: member.stateCode,
    district: member.district ?? null,
    currentTerm: member.currentTerm,
  });
}

function eventId(
  syncId: string,
  entityId: string,
  changeType: ChangeType,
  disambiguator = ""
): string {
  const safeSync = syncId.replace(/[:.]/g, "");
  const suffix = disambiguator ? `_${fingerprint(disambiguator)}` : "";
  return `evt_${safeSync}_${entityId}_${changeType}${suffix}`;
}

function readJsonFile<T>(filePath: string): T | undefined {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export function readRecordIfExists<T>(dir: string, id: string): T | undefined {
  return readJsonFile<T>(resolve(dir, `${id}.json`));
}

export function loadLatestSnapshot(snapshotsDir: string): SyncSnapshot | undefined {
  return readJsonFile<SyncSnapshot>(resolve(snapshotsDir, "latest.json"));
}

export function diffBill(
  previous: Bill | undefined,
  next: Bill,
  syncId: string,
  observedAt: string
): ChangeEvent[] {
  const events: ChangeEvent[] = [];

  if (!previous) {
    events.push({
      id: eventId(syncId, next.id, "bill.added"),
      observedAt,
      entityType: "bill",
      entityId: next.id,
      changeType: "bill.added",
      summary: `Started tracking ${next.id}: ${next.title}`,
      after: { title: next.title, status: next.status },
      officialUrl: next.officialUrl,
      syncId,
    });
    return events;
  }

  if (previous.status !== next.status) {
    events.push({
      id: eventId(syncId, next.id, "bill.status_changed"),
      observedAt,
      entityType: "bill",
      entityId: next.id,
      changeType: "bill.status_changed",
      summary: `Status changed from ${previous.status} to ${next.status}`,
      before: { status: previous.status },
      after: { status: next.status },
      officialUrl: next.officialUrl,
      syncId,
    });
  }

  if (previous.title !== next.title) {
    events.push({
      id: eventId(syncId, next.id, "bill.title_changed"),
      observedAt,
      entityType: "bill",
      entityId: next.id,
      changeType: "bill.title_changed",
      summary: `Title updated`,
      before: { title: previous.title },
      after: { title: next.title },
      officialUrl: next.officialUrl,
      syncId,
    });
  }

  const prevSummary = previous.summaryHtml ?? previous.summary ?? "";
  const nextSummary = next.summaryHtml ?? next.summary ?? "";
  if (prevSummary !== nextSummary) {
    events.push({
      id: eventId(syncId, next.id, "bill.summary_changed"),
      observedAt,
      entityType: "bill",
      entityId: next.id,
      changeType: "bill.summary_changed",
      summary: previous.summary || previous.summaryHtml ? "Official summary updated" : "Official summary added",
      before: {
        summary: previous.summary ?? null,
        summaryFormat: previous.summaryFormat ?? null,
      },
      after: {
        summary: next.summary ?? null,
        summaryFormat: next.summaryFormat ?? null,
      },
      officialUrl: next.officialUrl,
      syncId,
    });
  }

  const prevActions = new Set(previous.actions.map(actionKey));
  for (const action of next.actions) {
    const key = actionKey(action);
    if (prevActions.has(key)) continue;
    events.push({
      id: eventId(syncId, next.id, "bill.action_added", key),
      observedAt,
      entityType: "bill",
      entityId: next.id,
      changeType: "bill.action_added",
      summary: `New action: ${action.text}`,
      after: {
        date: action.date,
        text: action.text,
        chamber: action.chamber,
        actionCode: action.actionCode ?? null,
      },
      officialUrl: next.officialUrl,
      syncId,
    });
  }

  return events;
}

export function diffVote(
  previous: Vote | undefined,
  next: Vote,
  syncId: string,
  observedAt: string
): ChangeEvent[] {
  if (!previous) {
    return [
      {
        id: eventId(syncId, next.id, "vote.added"),
        observedAt,
        entityType: "vote",
        entityId: next.id,
        changeType: "vote.added",
        summary: `New ${next.chamber} vote: ${next.question} (${next.result})`,
        after: {
          date: next.date,
          question: next.question,
          result: next.result,
          yea: next.yea,
          nay: next.nay,
        },
        officialUrl: next.officialUrl,
        syncId,
      },
    ];
  }

  const before = {
    result: previous.result,
    yea: previous.yea,
    nay: previous.nay,
    present: previous.present,
    notVoting: previous.notVoting,
    question: previous.question,
    description: previous.description,
    date: previous.date,
    associatedBillId: previous.associatedBillId ?? null,
  };
  const after = {
    result: next.result,
    yea: next.yea,
    nay: next.nay,
    present: next.present,
    notVoting: next.notVoting,
    question: next.question,
    description: next.description,
    date: next.date,
    associatedBillId: next.associatedBillId ?? null,
  };

  if (fingerprint(before) === fingerprint(after)) return [];

  return [
    {
      id: eventId(syncId, next.id, "vote.corrected"),
      observedAt,
      entityType: "vote",
      entityId: next.id,
      changeType: "vote.corrected",
      summary: `Vote record corrected: ${next.question}`,
      before,
      after,
      officialUrl: next.officialUrl,
      syncId,
    },
  ];
}

export function diffMember(
  previous: Member | undefined,
  next: Member,
  syncId: string,
  observedAt: string
): ChangeEvent[] {
  if (previous) return [];
  return [
    {
      id: eventId(syncId, next.id, "member.added"),
      observedAt,
      entityType: "member",
      entityId: next.id,
      changeType: "member.added",
      summary: `Started tracking ${next.name}`,
      after: {
        name: next.name,
        party: next.party,
        chamber: next.chamber,
        state: next.stateCode,
      },
      officialUrl: next.officialUrl,
      syncId,
    },
  ];
}

export function collectSyncEvents(args: {
  syncId: string;
  observedAt: string;
  baseline: boolean;
  bills: Bill[];
  votes: Vote[];
  members: Member[];
  previousBills: Map<string, Bill>;
  previousVotes: Map<string, Vote>;
  previousMembers: Map<string, Member>;
}): ChangeEvent[] {
  if (args.baseline) return [];

  const events: ChangeEvent[] = [];
  for (const bill of args.bills) {
    events.push(
      ...diffBill(args.previousBills.get(bill.id), bill, args.syncId, args.observedAt)
    );
  }
  for (const vote of args.votes) {
    events.push(
      ...diffVote(args.previousVotes.get(vote.id), vote, args.syncId, args.observedAt)
    );
  }
  for (const member of args.members) {
    events.push(
      ...diffMember(args.previousMembers.get(member.id), member, args.syncId, args.observedAt)
    );
  }
  return events;
}

export function buildSnapshot(args: {
  syncId: string;
  generatedAt: string;
  baseline: boolean;
  bills: Bill[];
  votes: Vote[];
  members: Member[];
}): SyncSnapshot {
  const fingerprints: Record<string, string> = {};
  for (const bill of args.bills) fingerprints[`bill:${bill.id}`] = billFingerprint(bill);
  for (const vote of args.votes) fingerprints[`vote:${vote.id}`] = voteFingerprint(vote);
  for (const member of args.members) {
    fingerprints[`member:${member.id}`] = memberFingerprint(member);
  }

  return {
    syncId: args.syncId,
    generatedAt: args.generatedAt,
    source: "Congress.gov API",
    baseline: args.baseline,
    billIds: args.bills.map((b) => b.id),
    voteIds: args.votes.map((v) => v.id),
    memberIds: args.members.map((m) => m.id),
    fingerprints,
  };
}

export function writeSnapshot(snapshotsDir: string, snapshot: SyncSnapshot): void {
  mkdirSync(snapshotsDir, { recursive: true });
  writeFileSync(resolve(snapshotsDir, "latest.json"), JSON.stringify(snapshot, null, 2));
  writeFileSync(
    resolve(snapshotsDir, `${snapshot.syncId.replace(/[:.]/g, "-")}.json`),
    JSON.stringify(snapshot, null, 2)
  );
}

/** Merge events into the daily file for observedAt's UTC date. */
export function appendDailyEvents(
  changesRoot: string,
  events: ChangeEvent[],
  observedAt: string
): string | undefined {
  if (events.length === 0) return undefined;

  const day = observedAt.slice(0, 10); // YYYY-MM-DD
  const [year, month] = day.split("-");
  const filePath = resolve(changesRoot, "events", year, month, `${day}.json`);
  mkdirSync(dirname(filePath), { recursive: true });

  const existing = readJsonFile<{ date: string; items: ChangeEvent[] }>(filePath);
  const byId = new Map<string, ChangeEvent>();
  for (const event of existing?.items ?? []) byId.set(event.id, event);
  for (const event of events) byId.set(event.id, event);

  const items = Array.from(byId.values()).sort((a, b) =>
    b.observedAt.localeCompare(a.observedAt) || a.id.localeCompare(b.id)
  );

  writeFileSync(
    filePath,
    JSON.stringify({ date: day, generatedAt: observedAt, items }, null, 2)
  );
  return filePath;
}

function walkEventFiles(changesRoot: string): string[] {
  const eventsRoot = resolve(changesRoot, "events");
  if (!existsSync(eventsRoot)) return [];

  const files: string[] = [];
  for (const year of readdirSync(eventsRoot)) {
    const yearDir = join(eventsRoot, year);
    for (const month of readdirSync(yearDir)) {
      const monthDir = join(yearDir, month);
      for (const name of readdirSync(monthDir)) {
        if (name.endsWith(".json")) files.push(join(monthDir, name));
      }
    }
  }
  return files.sort();
}

export function loadAllChangeEvents(changesRoot: string): ChangeEvent[] {
  const events: ChangeEvent[] = [];
  for (const filePath of walkEventFiles(changesRoot)) {
    const daily = readJsonFile<{ items?: ChangeEvent[] }>(filePath);
    if (daily?.items) events.push(...daily.items);
  }
  return events;
}

export function buildChangesRecentIndex(
  changesRoot: string,
  generatedAt: string,
  limit = CHANGES_RECENT_LIMIT
): IndexEnvelope<ChangeEvent> {
  const items = loadAllChangeEvents(changesRoot)
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt) || a.id.localeCompare(b.id))
    .slice(0, limit);

  return {
    generatedAt,
    source: "Readable Congress change tracking",
    mode: "changes",
    items,
  };
}

export function writeChangesRecentIndex(
  indexesDir: string,
  envelope: IndexEnvelope<ChangeEvent>
): void {
  mkdirSync(indexesDir, { recursive: true });
  writeFileSync(
    resolve(indexesDir, "changes-recent.json"),
    JSON.stringify(envelope, null, 2)
  );
}
