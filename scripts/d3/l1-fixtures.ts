/** Frozen before the first live request; never uses personal/project data. */
export type L1Source = {
  readonly id: string;
  readonly text: string;
  readonly state:
    "active" | "revoked" | "pending" | "not_saved" | "assistant_output";
};
export type ContentCheck = {
  readonly id: string;
  readonly sourceIds: readonly string[];
  /** Every group must have at least one literal present in one memory. */
  readonly terms: readonly (readonly string[])[];
};
export type L1Case = {
  readonly id: string;
  readonly sources: readonly L1Source[];
  readonly checks: readonly ContentCheck[];
};
const source = (
  ordinal: number,
  text: string,
  state: L1Source["state"] = "active",
): L1Source => ({
  id: `synthetic-l1-source-${String(ordinal).padStart(2, "0")}`,
  text,
  state,
});
const check = (
  id: string,
  ordinals: readonly number[],
  terms: ContentCheck["terms"],
): ContentCheck => ({
  id,
  sourceIds: ordinals.map(
    (n) => `synthetic-l1-source-${String(n).padStart(2, "0")}`,
  ),
  terms,
});
export const L1_CASES: readonly L1Case[] = [
  {
    id: "l1-case-01",
    sources: [
      source(
        1,
        "合成项目青禾支付在2026年11月15日完成压测，订单接口P95延迟为120毫秒。",
      ),
      source(2, "青禾支付在同次压测中，错误率为0.8%，使用构建701。"),
      source(
        3,
        "我决定为青禾支付保留构建701作为回滚版本；这不是批准生产发布。",
      ),
    ],
    checks: [
      check("latency", [1], [["青禾"], ["120"], ["P95", "p95"]]),
      check("error-rate", [2], [["0.8"], ["701"]]),
      check("rollback", [3], [["701"], ["回滚"]]),
    ],
  },
  {
    id: "l1-case-02",
    sources: [
      source(
        4,
        "合成项目蓝杉搜索在2026年11月15日仍有超时，错误码为E731，目前不能标记故障解决。",
      ),
      source(
        5,
        "同一天，青禾支付已经恢复；这是支付服务的状态，不代表蓝杉搜索恢复。",
      ),
      source(
        6,
        "我决定蓝杉搜索超时原因未查明之前，保留故障状态并阻止该搜索服务发布。",
      ),
    ],
    checks: [
      check("search-outage", [4], [["蓝杉"], ["E731"]]),
      check("payment-recovered", [5], [["青禾"], ["恢复"]]),
      check(
        "search-release-block",
        [6],
        [["蓝杉"], ["发布"], ["阻止", "禁止", "不得", "暂缓", "不"]],
      ),
    ],
  },
  {
    id: "l1-case-03",
    sources: [
      source(
        7,
        "2026年11月15日上午，我为合成项目青禾决定先在11月20日进行内部灰度发布。",
      ),
      source(
        8,
        "2026年11月15日下午，我更正青禾的内部灰度日期为11月23日，替代上午的11月20日计划。",
      ),
      source(9, "青禾正式对外发布尚未批准，内部灰度获批不代表对外发布也获批。"),
    ],
    checks: [
      check("updated-date", [8], [["青禾"], ["23"], ["灰度"]]),
      check(
        "approval-boundary",
        [9],
        [["对外", "正式"], ["未", "不"], ["批准"]],
      ),
    ],
  },
  {
    id: "l1-case-04",
    sources: [
      source(
        10,
        "合成支付项目青禾的负责人是林澈，支付项目中的Atlas指的是只读报表服务。",
      ),
      source(
        11,
        "合成搜索项目蓝杉的负责人是宋禾，搜索项目中的Atlas指的是索引迁移工具。",
      ),
      source(
        12,
        "两个Atlas是不同项目的不同对象，我决定在交接文档中始终写清项目名。",
      ),
    ],
    checks: [
      check("payment-atlas", [10], [["青禾", "支付"], ["Atlas"], ["报表"]]),
      check("search-atlas", [11], [["蓝杉", "搜索"], ["Atlas"], ["索引"]]),
      check(
        "disambiguation",
        [12],
        [
          ["项目名", "项目名称", "项目"],
          ["交接", "写清", "标明"],
        ],
      ),
    ],
  },
  {
    id: "l1-case-05",
    sources: [
      source(
        13,
        "合成项目山岚的缓存保留时间是90秒；这是2026年11月15日已确认的配置事实。",
      ),
      source(
        14,
        "合成项目山岚的缓存保留时间是90秒；这是2026年11月15日已确认的配置事实。",
      ),
      source(
        15,
        "我决定山岚缓存过期后必须回源读取，不能把过期数据当作当前事实。",
      ),
    ],
    checks: [
      check("duplicate-fact", [13, 14], [["山岚"], ["90"]]),
      check("cache-boundary", [15], [["过期"], ["回源"]]),
    ],
  },
  {
    id: "l1-case-06",
    sources: [
      source(
        16,
        "我长期负责合成项目的故障排查，习惯先核对日志和时间线，再判断根因。",
      ),
      source(
        17,
        "以后请始终用简体中文回答我的工作问题，并明确区分事实与推测。",
      ),
      source(
        18,
        "我偏好每天上午先整理待办，再处理低优先级消息，这是一项长期习惯。",
      ),
    ],
    checks: [
      check("investigation-preference", [16], [["日志"], ["时间线"]]),
      check("language", [17], [["简体中文"], ["事实"], ["推测"]]),
      check("todo-preference", [18], [["上午"], ["待办"]]),
    ],
  },
  {
    id: "l1-case-07",
    sources: [
      source(
        19,
        "2026年11月15日，我已确认合成项目松溪的备份需要保留30天，这是有效的长期配置。",
      ),
      source(20, "合成项目松溪的备份需要保留900天。", "pending"),
      source(21, "合成项目松溪的备份需要保留800天。", "not_saved"),
    ],
    checks: [check("accepted-only", [19], [["松溪"], ["30"]])],
  },
  {
    id: "l1-case-08",
    sources: [
      source(
        22,
        "我在2026年11月15日确认合成项目棠梨当前使用构建812，旧构建已退出有效状态。",
      ),
      source(23, "合成项目棠梨当前使用构建811。", "revoked"),
      source(24, "助手猜测合成项目棠梨已经使用构建999。", "assistant_output"),
    ],
    checks: [check("active-build", [22], [["棠梨"], ["812"]])],
  },
  {
    id: "l1-case-09",
    sources: [
      source(
        25,
        "合成项目远川的升级需要先备份数据库，这是我批准的长期操作规程。",
      ),
      source(
        26,
        "我要求远川备份校验失败时停止升级，不能因为升级任务紧急而绕过校验。",
      ),
      source(
        27,
        "我决定远川升级完成后保留备份和回滚记录至少30天，以便故障复盘。",
      ),
    ],
    checks: [
      check("backup-first", [25], [["远川"], ["备份"]]),
      check(
        "validation-stop",
        [26],
        [["校验"], ["失败"], ["停止", "中止", "不得"]],
      ),
      check("retention", [27], [["30"], ["回滚", "备份"]]),
    ],
  },
  {
    id: "l1-case-10",
    sources: [
      source(
        28,
        "Synthetic project Cedar uses region test-west; I confirmed this deployment configuration on November 15, 2026.",
      ),
      source(
        29,
        "Synthetic project Birch uses region test-east; its deployment configuration is independent of Cedar.",
      ),
      source(
        30,
        "I decided that Cedar and Birch must each retain their own rollback records for 14 days after deployment.",
      ),
    ],
    checks: [
      check("cedar-region", [28], [["Cedar"], ["test-west"]]),
      check("birch-region", [29], [["Birch"], ["test-east"]]),
      check("english-retention", [30], [["14"], ["rollback"]]),
    ],
  },
];
export const L1_FIXTURE_VERSION = "l1-core-v1";
