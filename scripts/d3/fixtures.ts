/** Fixed synthetic corpus for D3 comparison. */
export type SyntheticEntry = {
  readonly id: string;
  readonly bucket: "payments" | "search" | "release";
  readonly session: string;
  readonly text: string;
  readonly status:
    "active" | "revoked" | "pending" | "not_saved" | "assistant_output";
};

const bucketTitles = ["payments", "search", "release"] as const;
const contents = [
  "order-latency is 120ms on build 701",
  "retry-limit is 4 attempts after build 702",
  "owner-tag is synthetic-team on build 703",
  "error-rate is 0.8-percent on build 704",
  "cache-ttl is 90-seconds after build 705",
  "rollback-id is deploy-706 when incident occurs",
  "test-count is 36 cases on build 707",
  "region-tag is test-zone on build 708",
  "quota-cap is 240 requests for build 709",
  "review-date is 2026-11-18 for build 710",
] as const;

export const SYNTHETIC_ENTRIES: readonly SyntheticEntry[] =
  bucketTitles.flatMap((bucket, bucketIndex) =>
    contents.map((text, contentIndex) => {
      const ordinal = bucketIndex * contents.length + contentIndex + 1;
      const status: SyntheticEntry["status"] =
        ordinal === 29 ? "revoked" : "active";
      return {
        id: "synthetic-entry-" + String(ordinal).padStart(2, "0"),
        bucket,
        session: "synthetic-session-" + String(ordinal).padStart(2, "0"),
        text: bucket + " " + text,
        status,
      };
    }),
  );

export const NON_SOURCES = [
  { status: "not_saved", text: "payments rejected-archive seed" },
  {
    status: "assistant_output",
    text: "Assistant suggestion is not a durable source",
  },
  { status: "pending", text: "search pending-user-confirmation" },
] as const;

export type SyntheticQuery = {
  readonly id: string;
  readonly query: string;
  readonly expected: readonly string[];
};
export const SYNTHETIC_QUERIES: readonly SyntheticQuery[] = [
  ...SYNTHETIC_ENTRIES.filter((entry) => entry.status === "active")
    .slice(0, 15)
    .map((entry) => ({
      id: "query-" + entry.id,
      query: entry.text.split(" ").slice(0, 2).join(" "),
      expected: [entry.id],
    })),
  ...[
    "qzvnovar991",
    "qzvnovar992",
    "qzvnovar993",
    "qzvnovar994",
    "qzvnovar995",
  ].map((suffix, index) => ({
    id: "query-missing-" + index,
    query: suffix,
    expected: [],
  })),
];

export const WORK_ITEM_CASES = [
  {
    id: "w01",
    titles: ["payment audit"],
    input: { title: "payment audit" },
    expected: "resolved",
  },
  {
    id: "w02",
    titles: ["release plan"],
    input: { title: "release plan" },
    expected: "resolved",
  },
  {
    id: "w03",
    titles: ["payment audit", "release plan"],
    input: {},
    expected: "clarify",
  },
  { id: "w04", titles: ["search incident"], input: {}, expected: "clarify" },
  {
    id: "w05",
    titles: ["payment audit"],
    input: { title: "new target" },
    expected: "unassigned",
  },
  {
    id: "w06",
    titles: ["search incident"],
    input: { title: "search incident" },
    expected: "resolved",
  },
  { id: "w07", titles: ["release plan"], input: {}, expected: "clarify" },
  {
    id: "w08",
    titles: ["payment audit", "payment audit"],
    input: { title: "payment audit" },
    expected: "clarify",
  },
] as const;
