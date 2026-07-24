import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  Bill,
  BillAction,
  BillTextVersion,
  BillType,
  Chamber,
  LegislativeStatus,
  Member,
  MemberVote,
  Party,
  Sponsor,
  Vote,
  VoteResult,
  VoteMemberRecord,
} from "../../readable-congress-web/src/types/domain";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type JsonRecord = Record<string, unknown>;
type FetchMode = "recent" | "smoke";

interface FetchConfig {
  mode: FetchMode;
  billCount: number;
  voteCount: number;
  memberCount: number;
  concurrency: number;
}

interface IndexEnvelope<T> {
  generatedAt: string;
  source: string;
  mode: FetchMode;
  items: T[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_BASE = "https://api.congress.gov/v3";
const PACKAGE_ROOT = resolve(process.cwd());
const DATA_ROOT = resolve(PACKAGE_ROOT, "data/congress/119");
const BILLS_DIR = resolve(DATA_ROOT, "bills");
const VOTES_DIR = resolve(DATA_ROOT, "votes");
const MEMBERS_DIR = resolve(DATA_ROOT, "members");
const INDEXES_DIR = resolve(PACKAGE_ROOT, "indexes");
const TARGET_CONGRESS = 119;
const DEFAULT_CONCURRENCY = 6;
const ALLOWED_BILL_TYPES: BillType[] = [
  "hr", "s", "hjres", "sjres", "hconres", "sconres", "hres", "sres",
];

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(): FetchConfig {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");

  function flag(name: string): string | undefined {
    const eq = args.find((a) => a.startsWith(`--${name}=`));
    if (eq) return eq.split("=").slice(1).join("=");
    const idx = args.indexOf(`--${name}`);
    if (idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith("--")) {
      return args[idx + 1];
    }
    return undefined;
  }

  function positional(index: number): string | undefined {
    const value = args[index];
    return value && !value.startsWith("-") ? value : undefined;
  }

  const mode = (flag("mode") ?? positional(0) ?? "smoke") as FetchMode;
  const defaults =
    mode === "recent"
      ? { bills: 25, votes: 25, members: 50 }
      : { bills: 10, votes: 10, members: 20 };

  return {
    mode,
    billCount: Number(flag("bills") ?? positional(1) ?? defaults.bills),
    voteCount: Number(flag("votes") ?? positional(2) ?? defaults.votes),
    memberCount: Number(flag("members") ?? positional(3) ?? defaults.members),
    concurrency: Math.max(1, Number(flag("concurrency") ?? positional(4) ?? DEFAULT_CONCURRENCY)),
  };
}

// ---------------------------------------------------------------------------
// API key resolution
// ---------------------------------------------------------------------------

function getApiKey(): string {
  try {
    const content = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
    for (const line of content.split("\n")) {
      const match = line.match(/^CONGRESS_GOV_API_KEY=(.+)$/);
      if (match && !process.env.CONGRESS_GOV_API_KEY) {
        process.env.CONGRESS_GOV_API_KEY = match[1].trim();
      }
    }
  } catch {
    // No .env.local — fall through to env / flag
  }

  const fromArg = process.argv.find((arg) => arg.startsWith("--api-key="));
  if (fromArg) return fromArg.split("=").slice(1).join("=");
  return process.env.CONGRESS_GOV_API_KEY ?? "";
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function pickArray<T = unknown>(obj: JsonRecord, keys: string[]): T[] {
  for (const key of keys) {
    const value = obj[key];
    if (Array.isArray(value)) return value as T[];
  }
  return [];
}

function toIsoDate(value: unknown, fallback = "1970-01-01"): string {
  if (typeof value !== "string" || value.trim() === "") return fallback;
  return value.slice(0, 10);
}

function toIsoTimestamp(value: unknown, fallback = "1970-01-01T00:00:00Z"): string {
  if (typeof value !== "string" || value.trim() === "") return fallback;
  if (value.includes("T")) return value;
  return `${value}T00:00:00Z`;
}

function optionalUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeHtml(value: string): boolean {
  return /<[a-z][\s\S]*>/i.test(value);
}

// ---------------------------------------------------------------------------
// Domain type normalizers
// ---------------------------------------------------------------------------

function normalizeBillType(rawType: unknown): BillType {
  const normalized = String(rawType ?? "").toLowerCase().replace(/\./g, "").trim();
  return ALLOWED_BILL_TYPES.includes(normalized as BillType)
    ? (normalized as BillType)
    : "hr";
}

function normalizeChamber(raw: unknown): Chamber {
  const value = String(raw ?? "").toLowerCase();
  return value.includes("senate") || value === "s" ? "Senate" : "House";
}

function normalizeParty(raw: unknown): Party {
  const value = String(raw ?? "").toUpperCase();
  if (value.startsWith("R")) return "R";
  if (value.startsWith("I")) return "I";
  return "D";
}

function inferStatus(latestActionText: string, chamber: Chamber): LegislativeStatus {
  const text = latestActionText.toLowerCase();
  if (text.includes("became public law") || text.includes("signed by president"))
    return "becameLaw";
  if (text.includes("passed house")) return "passedHouse";
  if (text.includes("passed senate")) return "passedSenate";
  if (text.includes("failed") || text.includes("rejected"))
    return chamber === "House" ? "failedHouse" : "failedSenate";
  if (text.includes("committee") || text.includes("referred")) return "inCommittee";
  return "introduced";
}

function normalizeVoteResult(raw: unknown): VoteResult {
  const text = String(raw ?? "").toLowerCase();
  if (text.includes("agreed")) return "Agreed To";
  if (text.includes("pass")) return "Passed";
  if (text.includes("reject")) return "Rejected";
  return "Failed";
}

function normalizeMemberVote(raw: unknown): MemberVote {
  const text = String(raw ?? "").toLowerCase().replace(/\s+/g, "");
  if (text === "yea" || text === "yes" || text === "aye") return "Yea";
  if (text === "nay" || text === "no") return "Nay";
  if (text === "present") return "Present";
  return "NotVoting";
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function apiGet(
  pathname: string,
  apiKey: string,
  query: Record<string, string | number | undefined> = {}
): Promise<JsonRecord> {
  const url = new URL(`${API_BASE}${pathname}`);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  url.searchParams.set("format", "json");
  url.searchParams.set("api_key", apiKey);

  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`API ${response.status} for ${pathname}: ${body.slice(0, 300)}`);
  }
  return (await response.json()) as JsonRecord;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  onProgress?: (completed: number, total: number) => void
): Promise<R[]> {
  if (items.length === 0) return [];

  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let completed = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await fn(items[index], index);
      completed += 1;
      onProgress?.(completed, items.length);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );
  return results;
}

function logProgress(label: string, completed: number, total: number): void {
  process.stdout.write(`\r  ${label}: ${completed}/${total}`);
  if (completed === total) process.stdout.write("\n");
}

// ---------------------------------------------------------------------------
// Record parsers
// ---------------------------------------------------------------------------

function parseSponsor(detail: JsonRecord, chamber: Chamber): Sponsor {
  const sponsors = pickArray<JsonRecord>(detail, ["sponsors", "sponsor"]);
  const first = asRecord(sponsors[0]);
  const memberId =
    String(first.bioguideId ?? first.bioguideID ?? first.memberId ?? first.id ?? "UNKNOWN_MEMBER") ||
    "UNKNOWN_MEMBER";
  return {
    memberId,
    name: String(first.fullName ?? first.name ?? first.invertedOrderName ?? "Unknown Member"),
    party: normalizeParty(first.party ?? first.partyName ?? first.partyAbbreviation),
    state: String(first.state ?? first.stateCode ?? "NA"),
    district:
      first.district !== undefined && first.district !== null
        ? String(first.district)
        : undefined,
    chamber,
  };
}

function parseBillActions(actionsPayload: JsonRecord, chamber: Chamber): BillAction[] {
  return pickArray<JsonRecord>(actionsPayload, ["actions", "item"])
    .map((entry) => {
      const item = asRecord(entry);
      return {
        date: toIsoDate(item.actionDate ?? item.date),
        text: String(item.text ?? item.description ?? "No action text available."),
        chamber: normalizeChamber(item.chamber ?? chamber),
        actionCode:
          item.actionCode !== undefined && item.actionCode !== null
            ? String(item.actionCode)
            : undefined,
      } as BillAction;
    })
    .filter((a) => a.text.length > 0);
}

function parseBillTextVersions(textPayload: JsonRecord): BillTextVersion[] {
  return pickArray<JsonRecord>(textPayload, ["textVersions", "item"]).map((entry) => {
    const item = asRecord(entry);
    const formats = pickArray<JsonRecord>(item, ["formats", "format"]);
    const firstFormat = asRecord(formats[0]);
    return {
      type: String(item.type ?? item.versionType ?? "Text Version"),
      date: toIsoDate(item.date ?? item.dateIssued),
      url: String(firstFormat.url ?? item.url ?? ""),
    };
  });
}

function parseBillSummary(
  summaryPayload: JsonRecord
): Pick<Bill, "summary" | "summaryHtml" | "summaryFormat" | "summarySource"> {
  const summaries = pickArray<JsonRecord>(summaryPayload, ["summaries", "item"]);
  const first = asRecord(summaries[0]);
  const rawSummary = first.text ?? first.summaryText ?? first.summary;
  if (typeof rawSummary !== "string" || !rawSummary.trim()) return {};

  const trimmed = rawSummary.trim();
  if (looksLikeHtml(trimmed)) {
    return {
      summaryHtml: trimmed,
      summaryFormat: "html",
      summary: stripHtml(trimmed),
      summarySource: "official",
    };
  }
  return { summary: trimmed, summaryFormat: "plain", summarySource: "official" };
}

function normalizeBill(
  detailPayload: JsonRecord,
  actionsPayload: JsonRecord,
  summariesPayload: JsonRecord,
  textPayload: JsonRecord
): Bill {
  const detail = asRecord(detailPayload.bill ?? detailPayload);
  const chamber = normalizeChamber(detail.originChamber ?? detail.originChamberCode);
  const sponsor = parseSponsor(detail, chamber);
  const latestActionRecord = asRecord(detail.latestAction);
  const latestActionText = String(latestActionRecord.text ?? "No latest action available.");

  const billType = normalizeBillType(detail.type);
  const billNumber = Number(detail.number ?? 0);
  const congress = Number(detail.congress ?? TARGET_CONGRESS);

  return {
    id: `${congress}-${billType}-${billNumber}`,
    billType,
    billNumber,
    congress,
    title: String(detail.title ?? detail.shortTitle ?? "Untitled Bill"),
    shortTitle: typeof detail.shortTitle === "string" ? detail.shortTitle : undefined,
    status: inferStatus(latestActionText, chamber),
    chamber,
    policyArea: String(asRecord(detail.policyArea).name ?? "") || undefined,
    sponsor,
    cosponsorCount: Number(asRecord(detail.cosponsors).count ?? 0),
    latestAction: {
      date: toIsoDate(latestActionRecord.actionDate ?? detail.updateDate),
      text: latestActionText,
      chamber,
      actionCode:
        latestActionRecord.actionCode !== undefined
          ? String(latestActionRecord.actionCode)
          : undefined,
    },
    actions: parseBillActions(actionsPayload, chamber),
    textVersions: parseBillTextVersions(textPayload),
    ...parseBillSummary(summariesPayload),
    officialUrl: optionalUrl(detail.legislationUrl ?? detail.url),
    updatedAt: toIsoTimestamp(
      detail.updateDateIncludingText ?? detail.updateDate ?? latestActionRecord.actionDate
    ),
    introducedAt: toIsoDate(detail.introducedDate ?? latestActionRecord.actionDate),
  };
}

function parseVotePartyTotals(detail: JsonRecord) {
  const partyTotals = pickArray<JsonRecord>(detail, ["votePartyTotal", "votePartyTotals"]);
  const totals = { yea: 0, nay: 0, present: 0, notVoting: 0 };
  for (const row of partyTotals) {
    totals.yea += Number(row.yeaTotal ?? row.yea ?? 0);
    totals.nay += Number(row.nayTotal ?? row.nay ?? 0);
    totals.present += Number(row.presentTotal ?? row.present ?? 0);
    totals.notVoting += Number(row.notVotingTotal ?? row.notVoting ?? 0);
  }
  return totals;
}

function selectCurrentTerm(terms: JsonRecord[], targetCongress = TARGET_CONGRESS): JsonRecord {
  if (terms.length === 0) return {};
  const match = terms.find((t) => Number(t.congress ?? 0) === targetCongress);
  if (match) return match;
  return terms.reduce((latest, t) =>
    Number(t.congress ?? 0) > Number(latest.congress ?? 0) ? t : latest
  );
}

function normalizeVote(
  voteDetailPayload: JsonRecord,
  voteMembersPayload: JsonRecord,
  billsById: Map<string, Bill>
): Vote {
  const detail = asRecord(
    voteDetailPayload.houseRollCallVote ?? voteDetailPayload.houseVote ?? voteDetailPayload
  );
  const membersRoot = asRecord(
    voteMembersPayload.houseRollCallVoteMemberVotes ??
      voteMembersPayload.houseVoteMembers ??
      voteMembersPayload
  );
  const results = pickArray<JsonRecord>(membersRoot, ["results"]);

  const congress = Number(detail.congress ?? TARGET_CONGRESS);
  const session = Number(detail.sessionNumber ?? 1);
  const rollNumber = Number(detail.rollCallNumber ?? detail.voteNumber ?? 0);
  const legislationType = normalizeBillType(detail.legislationType);
  const legislationNumber = Number(detail.legislationNumber ?? 0);
  const associatedBillId =
    legislationNumber > 0 ? `${congress}-${legislationType}-${legislationNumber}` : undefined;
  const associatedBillTitle = associatedBillId
    ? billsById.get(associatedBillId)?.title
    : undefined;

  const memberRecords: VoteMemberRecord[] = results.map((entry) => {
    const row = asRecord(entry);
    const firstName = String(row.firstName ?? "").trim();
    const lastName = String(row.lastName ?? "").trim();
    const name = [firstName, lastName].filter(Boolean).join(" ").trim();
    return {
      memberId: String(row.bioguideID ?? row.bioguideId ?? "UNKNOWN_MEMBER"),
      memberName: name || "Unknown Member",
      party: normalizeParty(row.voteParty),
      state: String(row.voteState ?? "NA"),
      vote: normalizeMemberVote(row.voteCast),
    };
  });

  const partyTotals = parseVotePartyTotals(detail);
  const hasPartyTotals =
    partyTotals.yea + partyTotals.nay + partyTotals.present + partyTotals.notVoting > 0;
  const memberCounts = memberRecords.reduce(
    (acc, r) => { acc[r.vote] += 1; return acc; },
    { Yea: 0, Nay: 0, Present: 0, NotVoting: 0 } as Record<MemberVote, number>
  );
  const counts = hasPartyTotals
    ? { yea: partyTotals.yea, nay: partyTotals.nay, present: partyTotals.present, notVoting: partyTotals.notVoting }
    : { yea: memberCounts.Yea, nay: memberCounts.Nay, present: memberCounts.Present, notVoting: memberCounts.NotVoting };

  return {
    id: `${congress}-house-${session}-${rollNumber}`,
    chamber: "House",
    congress,
    session,
    rollNumber,
    date: toIsoDate(detail.startDate ?? detail.updateDate),
    question: String(detail.voteQuestion ?? detail.voteType ?? "On Passage"),
    description:
      associatedBillId && associatedBillTitle
        ? `${associatedBillTitle} (${legislationType.toUpperCase()} ${legislationNumber})`
        : String(detail.voteQuestion ?? `House roll call vote ${rollNumber}`),
    result: normalizeVoteResult(detail.result),
    ...counts,
    associatedBillId,
    associatedBillTitle,
    memberRecords,
    officialUrl: optionalUrl(detail.sourceDataURL ?? detail.url),
    updatedAt: toIsoTimestamp(detail.updateDate ?? detail.startDate),
  };
}

function normalizeMember(
  memberPayload: JsonRecord,
  sponsoredBillIds: string[],
  cosponsoredBillIds: string[],
  recentVoteIds: string[]
): Member {
  const member = asRecord(memberPayload.member ?? memberPayload);
  const termsContainer = member.terms;
  const terms = Array.isArray(termsContainer)
    ? asArray<JsonRecord>(termsContainer)
    : pickArray<JsonRecord>(asRecord(termsContainer), ["item"]);
  const currentTermRaw = selectCurrentTerm(terms, TARGET_CONGRESS);

  const stateCode = String(currentTermRaw.stateCode ?? member.state ?? member.stateCode ?? "NA");
  const stateName = String(currentTermRaw.stateName ?? member.state ?? stateCode);
  const chamber = normalizeChamber(currentTermRaw.chamber ?? member.currentMemberType);
  const bioguideId = String(member.bioguideId ?? member.bioguideID ?? "UNKNOWN_MEMBER");
  const firstName = String(member.firstName ?? "").trim();
  const lastName = String(member.lastName ?? member.lastname ?? "").trim();
  const fullName =
    String(member.directOrderName ?? member.name ?? [firstName, lastName].join(" ").trim()) ||
    bioguideId;
  const partyHistory = asArray<JsonRecord>(member.partyHistory);
  const latestParty = asRecord(partyHistory[0] ?? {});
  const party = normalizeParty(
    latestParty.partyAbbreviation ?? latestParty.partyName ?? member.partyName
  );

  return {
    id: bioguideId,
    bioguideId,
    name: fullName,
    firstName: firstName || fullName.split(" ")[0] || "Unknown",
    lastName: lastName || fullName.split(" ").slice(-1)[0] || "Unknown",
    party,
    chamber,
    state: stateName,
    stateCode,
    district:
      currentTermRaw.district !== undefined && currentTermRaw.district !== null
        ? String(currentTermRaw.district)
        : undefined,
    currentTerm: {
      congress: Number(currentTermRaw.congress ?? TARGET_CONGRESS),
      chamber,
      state: stateName,
      district:
        currentTermRaw.district !== undefined && currentTermRaw.district !== null
          ? String(currentTermRaw.district)
          : undefined,
      startYear: Number(currentTermRaw.startYear ?? new Date().getFullYear()),
      endYear:
        currentTermRaw.endYear !== undefined && currentTermRaw.endYear !== null
          ? Number(currentTermRaw.endYear)
          : undefined,
    },
    sponsoredBillIds,
    cosponsoredBillIds,
    recentVoteIds,
    officialUrl: optionalUrl(member.officialWebsiteUrl ?? member.url),
  };
}

// ---------------------------------------------------------------------------
// Fetchers
// ---------------------------------------------------------------------------

type BillListRef = {
  congress: number;
  type: BillType;
  number: number;
  updateDate: string;
  latestActionDate: string;
};

type VoteListRef = {
  congress: number;
  session: number;
  voteNumber: number;
  startDate: string;
};

async function fetchBills(apiKey: string, config: FetchConfig): Promise<Bill[]> {
  const { billCount, mode, concurrency } = config;
  // Congress.gov expects a single sort value like "updateDate desc" (not sort + direction).
  const listQuery =
    mode === "recent"
      ? { limit: Math.min(250, Math.max(billCount * 4, 50)), sort: "updateDate desc" }
      : { limit: Math.min(250, Math.max(billCount * 2, 20)) };

  console.log(
    `  fetching up to ${billCount} bills${mode === "recent" ? " (sort=updateDate desc, ranked by latest action)" : ""}…`
  );

  const listPayload = await apiGet(`/bill/${TARGET_CONGRESS}`, apiKey, listQuery);
  const list = pickArray<JsonRecord>(listPayload, ["bills", "item"]);
  const refs: BillListRef[] = list
    .map((bill) => {
      const latestAction = asRecord(bill.latestAction);
      return {
        congress: Number(bill.congress ?? TARGET_CONGRESS),
        type: normalizeBillType(bill.type),
        number: Number(bill.number ?? 0),
        updateDate: toIsoDate(bill.updateDate ?? bill.updateDateIncludingText),
        latestActionDate: toIsoDate(latestAction.actionDate ?? bill.updateDate),
      };
    })
    .filter((b) => b.number > 0);

  // Prefer legislative activity date, then metadata update date, before truncating.
  refs.sort(
    (a, b) =>
      b.latestActionDate.localeCompare(a.latestActionDate) ||
      b.updateDate.localeCompare(a.updateDate) ||
      b.number - a.number
  );

  const selected = refs.slice(0, billCount);
  if (selected.length === 0) {
    throw new Error(`No bills returned from /bill/${TARGET_CONGRESS}.`);
  }

  return mapWithConcurrency(
    selected,
    concurrency,
    async (ref) => {
      const basePath = `/bill/${ref.congress}/${ref.type}/${ref.number}`;
      const [detail, actions, summaries, text] = await Promise.all([
        apiGet(basePath, apiKey),
        apiGet(`${basePath}/actions`, apiKey, { limit: 50 }),
        apiGet(`${basePath}/summaries`, apiKey, { limit: 5 }),
        apiGet(`${basePath}/text`, apiKey, { limit: 10 }),
      ]);
      return normalizeBill(detail, actions, summaries, text);
    },
    (completed, total) => logProgress("bills fetched", completed, total)
  );
}

async function fetchAllHouseVoteRefs(apiKey: string, session: number): Promise<VoteListRef[]> {
  const pageSize = 250;
  const refs: VoteListRef[] = [];
  let offset = 0;
  let total = Number.POSITIVE_INFINITY;

  while (offset < total) {
    const listPayload = await apiGet(`/house-vote/${TARGET_CONGRESS}/${session}`, apiKey, {
      limit: pageSize,
      offset,
    });
    const list = pickArray<JsonRecord>(listPayload, [
      "houseVotes",
      "houseRollCallVotes",
      "votes",
    ]);
    const pagination = asRecord(listPayload.pagination);
    total = Number(pagination.count ?? offset + list.length);

    for (const row of list) {
      const voteNumber = Number(row.rollCallNumber ?? row.voteNumber ?? row.rollNumber ?? 0);
      if (voteNumber <= 0) continue;
      refs.push({
        congress: TARGET_CONGRESS,
        session,
        voteNumber,
        startDate: toIsoDate(row.startDate ?? row.updateDate),
      });
    }

    if (list.length === 0) break;
    offset += list.length;
  }

  return refs;
}

async function fetchVotes(
  apiKey: string,
  billsById: Map<string, Bill>,
  config: FetchConfig
): Promise<Vote[]> {
  const { voteCount, mode, concurrency } = config;
  console.log(
    `  fetching up to ${voteCount} votes${mode === "recent" ? " (paginate sessions, sort by date/roll)" : ""}…`
  );

  // Prefer session 2 (current calendar year of a Congress), then fall back to session 1.
  const sessionOrder = [2, 1];
  const refs: VoteListRef[] = [];

  for (const session of sessionOrder) {
    try {
      console.log(`  listing house votes for session ${session}…`);
      const sessionRefs = await fetchAllHouseVoteRefs(apiKey, session);
      console.log(`  found ${sessionRefs.length} votes in session ${session}`);
      refs.push(...sessionRefs);
      // Recent mode: if session 2 has enough votes, skip session 1 to avoid
      // high session-1 roll numbers outranking current-session dates.
      if (mode === "recent" && session === 2 && sessionRefs.length >= voteCount) {
        break;
      }
    } catch {
      // Session may not exist yet.
    }
  }

  const seen = new Set<string>();
  const unique = refs.filter((r) => {
    const key = `${r.session}-${r.voteNumber}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  unique.sort(
    (a, b) =>
      b.startDate.localeCompare(a.startDate) ||
      b.session - a.session ||
      b.voteNumber - a.voteNumber
  );

  const selected = unique.slice(0, voteCount);
  if (selected.length === 0) {
    throw new Error("No House votes returned from /house-vote/119.");
  }

  return mapWithConcurrency(
    selected,
    concurrency,
    async (ref) => {
      const basePath = `/house-vote/${ref.congress}/${ref.session}/${ref.voteNumber}`;
      const [detail, members] = await Promise.all([
        apiGet(basePath, apiKey),
        apiGet(`${basePath}/members`, apiKey, { limit: 500 }),
      ]);
      return normalizeVote(detail, members, billsById);
    },
    (completed, total) => logProgress("votes fetched", completed, total)
  );
}

async function fetchMembers(
  apiKey: string,
  priorityIds: string[],
  bills: Bill[],
  votes: Vote[],
  config: FetchConfig
): Promise<Member[]> {
  const { memberCount, concurrency } = config;
  console.log(`  fetching up to ${memberCount} members (${priorityIds.length} from sponsor/vote context)…`);

  const billsBySponsor = new Map<string, string[]>();
  for (const bill of bills) {
    const list = billsBySponsor.get(bill.sponsor.memberId) ?? [];
    list.push(bill.id);
    billsBySponsor.set(bill.sponsor.memberId, list);
  }

  const votesByMember = new Map<string, string[]>();
  for (const vote of votes) {
    for (const row of vote.memberRecords) {
      const list = votesByMember.get(row.memberId) ?? [];
      list.push(vote.id);
      votesByMember.set(row.memberId, list);
    }
  }

  async function fetchOneMember(memberId: string): Promise<Member | undefined> {
    try {
      const payload = await apiGet(`/member/${memberId}`, apiKey);
      return normalizeMember(
        payload,
        billsBySponsor.get(memberId) ?? [],
        [],
        votesByMember.get(memberId) ?? []
      );
    } catch {
      return undefined;
    }
  }

  const members: Member[] = [];
  const seen = new Set<string>();
  const priorityTargets = priorityIds.slice(0, memberCount);

  const priorityMembers = await mapWithConcurrency(
    priorityTargets,
    concurrency,
    fetchOneMember,
    (completed, total) => logProgress("members fetched", completed, total)
  );

  for (const member of priorityMembers) {
    if (member && !seen.has(member.id)) {
      members.push(member);
      seen.add(member.id);
    }
  }

  // Pad with current-congress members if we didn't hit the target
  if (members.length < memberCount) {
    try {
      const remaining = memberCount - members.length;
      const listPayload = await apiGet(`/member/congress/${TARGET_CONGRESS}`, apiKey, {
        limit: Math.max(remaining * 2, 20),
      });
      const list = pickArray<JsonRecord>(listPayload, ["members", "item"]);
      const fallbackIds = list
        .map((row) => String(asRecord(row).bioguideId ?? asRecord(row).bioguideID ?? "").trim())
        .filter((id) => id && !seen.has(id))
        .slice(0, remaining);

      const fallbackMembers = await mapWithConcurrency(
        fallbackIds,
        concurrency,
        fetchOneMember,
        (completed, total) => logProgress("fallback members fetched", completed, total)
      );

      for (const member of fallbackMembers) {
        if (member && !seen.has(member.id)) {
          members.push(member);
          seen.add(member.id);
        }
      }
    } catch {
      // Keep partial member set.
    }
  }

  return members;
}

// ---------------------------------------------------------------------------
// Index writing
// ---------------------------------------------------------------------------

function writeRecord(dir: string, id: string, record: Bill | Vote | Member): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, `${id}.json`), JSON.stringify(record, null, 2));
}

function resetRecordDirs(): void {
  for (const dir of [BILLS_DIR, VOTES_DIR, MEMBERS_DIR]) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  }
}

function writeIndex<T>(
  filename: string,
  items: T[],
  config: FetchConfig,
  generatedAt: string
): void {
  const envelope: IndexEnvelope<T> = {
    generatedAt,
    source: "Congress.gov API",
    mode: config.mode,
    items,
  };
  mkdirSync(INDEXES_DIR, { recursive: true });
  writeFileSync(resolve(INDEXES_DIR, filename), JSON.stringify(envelope, null, 2));
  console.log(`  wrote ${filename} (${items.length} items)`);
}

function assertSampleFreshness(bills: Bill[], votes: Vote[], mode: FetchMode): void {
  if (mode !== "recent") return;

  const maxVoteMs = Math.max(0, ...votes.map((v) => new Date(v.date).getTime()));
  const maxActionMs = Math.max(0, ...bills.map((b) => new Date(b.latestAction.date).getTime()));
  const maxUpdateMs = Math.max(0, ...bills.map((b) => new Date(b.updatedAt).getTime()));
  const newestMs = Math.max(maxVoteMs, maxActionMs, maxUpdateMs);
  const cutoffMs = Date.now() - 60 * 24 * 60 * 60 * 1000; // 60 days

  if (newestMs < cutoffMs) {
    throw new Error(
      `Recent fetch looks stale (newest activity ${new Date(newestMs).toISOString().slice(0, 10)}). ` +
        "Check Congress.gov sort/pagination logic before publishing."
    );
  }
}

function writeDataset(bills: Bill[], votes: Vote[], members: Member[], config: FetchConfig): void {
  const generatedAt = new Date().toISOString();

  console.log("\nResetting record directories…");
  resetRecordDirs();

  for (const bill of bills) writeRecord(BILLS_DIR, bill.id, bill);
  for (const vote of votes) writeRecord(VOTES_DIR, vote.id, vote);
  for (const member of members) writeRecord(MEMBERS_DIR, member.id, member);

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

  console.log("\nWriting indexes:");
  writeIndex("bills-recent.json", billsRecent, config, generatedAt);
  writeIndex("bills-active.json", billsActive, config, generatedAt);
  writeIndex("votes-recent.json", votesRecent, config, generatedAt);
  writeIndex("members-current.json", membersCurrent, config, generatedAt);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const config = parseArgs();
  const apiKey = getApiKey();

  if (!apiKey) {
    throw new Error(
      "Missing Congress.gov API key. Set CONGRESS_GOV_API_KEY in .env.local or pass --api-key=KEY"
    );
  }

  console.log(`\nFetch mode: ${config.mode.toUpperCase()}`);
  console.log(
    `  bills: ${config.billCount}  votes: ${config.voteCount}  members: ${config.memberCount}  concurrency: ${config.concurrency}\n`
  );

  console.log("Bills:");
  const bills = await fetchBills(apiKey, config);
  const billsById = new Map(bills.map((b) => [b.id, b]));

  console.log("Votes:");
  const votes = await fetchVotes(apiKey, billsById, config);

  const priorityMemberIds = Array.from(
    new Set([
      ...bills.map((b) => b.sponsor.memberId),
      ...votes.flatMap((v) => v.memberRecords.map((r) => r.memberId)),
    ])
  );

  console.log("Members:");
  const members = await fetchMembers(apiKey, priorityMemberIds, bills, votes, config);

  assertSampleFreshness(bills, votes, config.mode);
  writeDataset(bills, votes, members, config);

  console.log(
    `\nDone. ${bills.length} bills, ${votes.length} votes, ${members.length} members.`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
