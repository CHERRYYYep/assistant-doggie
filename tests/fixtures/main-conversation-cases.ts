/** C0: synthetic product expectations for C1–C4, not claims about /api/chat. */
type UserInput = {
  readonly text: string;
  readonly replyTo?: string;
  readonly page?: string;
  readonly requestId?: string;
  readonly expectedRevision?: number;
};

type ProductStep = {
  readonly id: string;
  readonly input: UserInput | { readonly event: string };
  readonly expect: string;
};

type ProductCase = {
  readonly id: string;
  readonly stage: "C1" | "C2" | "C3";
  readonly setup: string;
  readonly steps: readonly ProductStep[];
};

export const networkLab = {
  bucket: "计算机网络实验",
  tcp: "TCP 抓包与三次握手",
  udp: "UDP 丢包与重传观察",
  request: "帮我修改那个计网实验",
  supplement: "抓三次握手那个，只改报告，SYN 和 SYN-ACK 写反了",
  question: "SYN-ACK 是什么？",
} as const;

export const mainConversationCases = [
  {
    id: "same-bucket-interruption-and-resume",
    stage: "C2",
    setup: "同一 Bucket 下有 TCP 与 UDP 两个工作目标。",
    steps: [
      {
        id: "ask",
        input: { text: networkLab.request },
        expect: "列 TCP 与 UDP 以及都不是；未绑定、未创建 Entry、未执行。",
      },
      {
        id: "interlude",
        input: { text: networkLab.question },
        expect: "直接答术语，不创建目标；原澄清仍等待。",
      },
      {
        id: "restore",
        input: { event: "刷新页面并重开临时数据库" },
        expect: "仍能读取原请求、候选和 revision。",
      },
      {
        id: "reply",
        input: { text: networkLab.supplement, replyTo: "ask" },
        expect:
          "绑定 TCP；接回原修改请求，仅限报告；补充不单独归档，不批准执行。",
      },
    ],
  },
  {
    id: "same-title",
    stage: "C2",
    setup: "两个全名均为「计网实验报告」的目标，验收要求不同。",
    steps: [
      {
        id: "ask",
        input: { text: "接着改计网实验报告" },
        expect: "按目标范围或验收要求澄清，不按最近活动猜测。",
      },
      {
        id: "reject",
        input: { text: "都不是", replyTo: "ask" },
        expect: "不绑定；允许补充描述或取消。",
      },
    ],
  },
  {
    id: "weak-candidate",
    stage: "C2",
    setup: "只有一个弱匹配目标「计算机网络课堂笔记」，没有实验报告。",
    steps: [
      {
        id: "ask",
        input: { text: networkLab.request },
        expect: "可建议唯一弱候选，保留都不是；不自动绑定。",
      },
      {
        id: "reject",
        input: { text: "不是这个，是实验报告", replyTo: "ask" },
        expect: "不绑定，询问可区分的报告信息。",
      },
    ],
  },
  {
    id: "no-candidate",
    stage: "C2",
    setup: "没有相关 WorkItem 或 Entry。",
    steps: [
      {
        id: "ask",
        input: { text: networkLab.request },
        expect: "只问缺少的实验名称、报告片段等，不编造候选或启动执行。",
      },
    ],
  },
  {
    id: "clear-input",
    stage: "C1",
    setup: "分别测试术语问答与自带原文的改写请求；不依赖已有目标。",
    steps: [
      {
        id: "question",
        input: { text: networkLab.question },
        expect: "直接回答，不要求选择目标，不进入归档。",
      },
      {
        id: "rewrite",
        input: {
          text: "把「服务现在已经恢复了」改成正式发布说明，不增加事实。",
        },
        expect: "直接改写，不追问，不创建工作目标。",
      },
    ],
  },
  {
    id: "explicit-title-and-closed-goal",
    stage: "C3",
    setup: "TCP 标题唯一，目标为 done，关联了可读报告。",
    steps: [
      {
        id: "ask",
        input: { text: `回顾「${networkLab.tcp}」的验收要求。` },
        expect: "按完整标题读目标和有效来源；不多问，不自动重开。",
      },
    ],
  },
  {
    id: "revision-replay-and-conflict",
    stage: "C2",
    setup: "两个页面看见同一张澄清卡 revision=1。",
    steps: [
      { id: "ask", input: { text: networkLab.request }, expect: "等待选择。" },
      {
        id: "select",
        input: {
          text: "选 TCP",
          replyTo: "ask",
          page: "A",
          requestId: "select-a",
          expectedRevision: 1,
        },
        expect: "绑定 TCP 一次。",
      },
      {
        id: "repeat",
        input: {
          text: "选 TCP",
          replyTo: "ask",
          page: "A",
          requestId: "select-a",
          expectedRevision: 1,
        },
        expect: "返回同一结果，无额外写入。",
      },
      {
        id: "changed-payload",
        input: {
          text: "选 UDP",
          replyTo: "ask",
          page: "A",
          requestId: "select-a",
          expectedRevision: 1,
        },
        expect: "同键不同载荷，冲突。",
      },
      {
        id: "stale",
        input: {
          text: "选 UDP",
          replyTo: "ask",
          page: "B",
          requestId: "select-b",
          expectedRevision: 1,
        },
        expect: "陈旧选择冲突；原绑定保持 TCP。",
      },
    ],
  },
  {
    id: "multiple-pending-and-cancellation",
    stage: "C2",
    setup: "计网和数据库各有两个目标。",
    steps: [
      {
        id: "network",
        input: { text: networkLab.request },
        expect: "计网卡等待。",
      },
      {
        id: "database",
        input: { text: "改那个数据库实验" },
        expect: "数据库卡也等待。",
      },
      {
        id: "cancel",
        input: { text: "取消这次修改", replyTo: "network" },
        expect: "只取消计网卡；数据库卡仍可处理。",
      },
    ],
  },
  {
    id: "evidence-without-a-goal-and-evidence-gap",
    stage: "C3",
    setup: "只有「发布审批」Entry，包含审批日期但没有电话号码。",
    steps: [
      {
        id: "read",
        input: { text: "上次发布审批是什么时候？" },
        expect: "引用有效 Entry；不伪造 WorkItem。",
      },
      {
        id: "gap",
        input: { text: "上次发布审批的联系人号码是多少？" },
        expect: "说明记录没写号码；主题命中不等于答案。",
      },
      {
        id: "revoke",
        input: { event: "撤销唯一 Entry" },
        expect: "保留审计；来源退出有效证据。",
      },
      {
        id: "read-again",
        input: { text: "上次发布审批是什么时候？" },
        expect: "说明没有有效来源；不复述已撤销日期。",
      },
    ],
  },
  {
    id: "archive-alongside-clarification",
    stage: "C2",
    setup: "任务澄清未决，服务端可推荐归档 Bucket。",
    steps: [
      {
        id: "ask",
        input: { text: networkLab.request },
        expect: "任务卡等待。",
      },
      {
        id: "record",
        input: { text: "记一下：接口 p99 从 62ms 降到 31ms" },
        expect: "独立记录仍走原归档规则。",
      },
      {
        id: "vague",
        input: { text: "修好了" },
        expect: "不静默归档；原确认保留四种选择。",
      },
      {
        id: "okay",
        input: { text: "好" },
        expect: "不消耗任务卡，不批准归档或执行。",
      },
      {
        id: "discard",
        input: { event: "通过归档确认接口不保存，再重复请求" },
        expect: "正式 Entry 不增加；重放冲突。",
      },
      {
        id: "move",
        input: { event: "把已归档记录移动到另一 Bucket" },
        expect: "走原纠错与审计；不改变任务卡归属。",
      },
    ],
  },
  {
    id: "approved-execution-and-stale-result",
    stage: "C3",
    setup: "选定 TCP，但报告未提供；工作区存在且明确指定。",
    steps: [
      {
        id: "request",
        input: { text: "只读检查 TCP 抓包报告里握手的两句描述" },
        expect: "核对目标、工作区及来源，先提案，不启动。",
      },
      {
        id: "scope",
        input: { event: "批准前更换工作区或修改目标范围" },
        expect: "旧提案不能执行；须重新确认。",
      },
      {
        id: "approve",
        input: { event: "重新提案并在既有批准入口确认；尝试再提交同目标执行" },
        expect: "只有一个有效只读尝试，禁止写文件。",
      },
      {
        id: "invalidate",
        input: { event: "执行中取消或撤销来源，然后注入迟到结果（分别复跑）" },
        expect: "迟到结果不回流，不串目标、不完成目标或 TODO。",
      },
    ],
  },
] as const satisfies readonly ProductCase[];
