/** Versioned before running either baseline. Text, labels and expected IDs are synthetic. */
export const RETRIEVAL_FIXTURE = "l0-language-v1";

export const RETRIEVAL_SOURCES = [
  {
    id: "r01",
    bucket: "青禾支付",
    text: "青禾支付 webhook 回调时验签失败，原因是轮换后仍使用旧密钥。",
    active: true,
  },
  {
    id: "r02",
    bucket: "青禾支付",
    text: "青禾支付内部灰度改到 12 月 3 日，正式发布未获批。",
    active: true,
  },
  {
    id: "r03",
    bucket: "蓝杉搜索",
    text: "蓝杉搜索索引迁移任务在批量提交后发生超时，错误码 E731。",
    active: true,
  },
  {
    id: "r04",
    bucket: "蓝杉搜索",
    text: "蓝杉搜索 Atlas 是索引迁移工具，负责搬运旧索引和校验条数。",
    active: true,
  },
  {
    id: "r05",
    bucket: "青禾支付",
    text: "青禾支付 Atlas 是只读报表服务，不能执行写入。",
    active: true,
  },
  {
    id: "r06",
    bucket: "山岚缓存",
    text: "山岚缓存保留 90 秒。过期后必须回源读取，不能继续使用旧数据。",
    active: true,
  },
  {
    id: "r07",
    bucket: "山岚缓存",
    text: "山岚缓存出现热点键击穿，临时开启请求合并。",
    active: true,
  },
  {
    id: "r08",
    bucket: "灰塔构建",
    text: "灰塔构建流水线没有产物，因为测试失败阻止了打包。",
    active: true,
  },
  {
    id: "r09",
    bucket: "灰塔构建",
    text: "灰塔保留 build-701 作为回滚版本，暂不推广到生产。",
    active: true,
  },
  {
    id: "r10",
    bucket: "青禾支付",
    text: "青禾支付曾记录错误发布暗号 revokedjasper。",
    active: false,
  },
  {
    id: "r11",
    bucket: "蓝杉搜索",
    text: "蓝杉搜索周四先恢复只读查询，不恢复后台写入。",
    active: true,
  },
  {
    id: "r12",
    bucket: "灰塔构建",
    text: "灰塔生产发布由值班负责人确认后才可执行。",
    active: true,
  },
] as const;

type Label = "literal" | "paraphrase" | "disambiguation" | "negative";
type SourceId = (typeof RETRIEVAL_SOURCES)[number]["id"];
export type RetrievalCase = {
  readonly id: string;
  readonly group: Label;
  readonly query: string;
  readonly expected: readonly SourceId[];
};
export const RETRIEVAL_CASES: readonly RetrievalCase[] = [
  { id: "q01", group: "literal", query: "webhook", expected: ["r01"] },
  { id: "q02", group: "literal", query: "E731", expected: ["r03"] },
  { id: "q03", group: "literal", query: "build-701", expected: ["r09"] },
  { id: "q04", group: "literal", query: "热点键", expected: ["r07"] },
  {
    id: "q05",
    group: "paraphrase",
    query: "换了秘钥之后为何校验不过？",
    expected: ["r01"],
  },
  {
    id: "q06",
    group: "paraphrase",
    query: "存下来的值失效后应该从哪里取？",
    expected: ["r06"],
  },
  {
    id: "q07",
    group: "paraphrase",
    query: "为什么自动打包没有生成交付文件？",
    expected: ["r08"],
  },
  {
    id: "q08",
    group: "paraphrase",
    query: "内部试运行推迟到哪天？",
    expected: ["r02"],
  },
  {
    id: "q09",
    group: "paraphrase",
    query: "正式上线前需要谁点头？",
    expected: ["r12"],
  },
  {
    id: "q10",
    group: "disambiguation",
    query: "Atlas",
    expected: ["r04", "r05"],
  },
  {
    id: "q11",
    group: "disambiguation",
    query: "蓝杉搜索 Atlas 索引迁移工具",
    expected: ["r04"],
  },
  {
    id: "q12",
    group: "disambiguation",
    query: "青禾支付 Atlas 只读报表服务",
    expected: ["r05"],
  },
  { id: "q13", group: "negative", query: "revokedjasper", expected: [] },
  { id: "q14", group: "negative", query: "nebulapassport", expected: [] },
  {
    id: "q15",
    group: "negative",
    query: "支付系统的供应商合同编号是什么？",
    expected: [],
  },
  {
    id: "q16",
    group: "negative",
    query: "生产发布批准人的手机号是什么？",
    expected: [],
  },
];
