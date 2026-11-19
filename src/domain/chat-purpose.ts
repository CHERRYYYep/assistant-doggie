/** Route a fresh main-chat message. The decision never grants authority. */
export type ChatPurpose =
  | { readonly kind: "answer" }
  | { readonly kind: "lookup" }
  | { readonly kind: "archive" }
  | { readonly kind: "propose_execution" }
  | {
      readonly kind: "clarify";
      readonly reason: "purpose" | "target" | "mixed" | "explicit_confirmation";
    };

const SAVE_PREFIX =
  /^(?:请\s*)?(?:记(?:录)?一下\s*[:：，,]?|(?:归档|工作记录|进度更新)\s*[:：]|(?:log|record)\s+(?:this\b\s*[:：,]?|:\s*))/iu;
const PLAIN_REPORT =
  /^[^，,。？！?!\r\n]{1,80}\b(?:p\d{2}|qps|tps)\b\s*(?:为|达到|降至|升至|[:：]|从\s*\d+(?:\.\d+)?\s*(?:ms|s)?\s*(?:降到|升到|变为))\s*\d+(?:\.\d+)?\s*(?:ms|s)?[。.]?$/iu;
const UNASSERTED_REPORT =
  /^(?:如果|假如|假设|若|预计|请|据说|听说|猜测)|可能|大概|是否|能否|不是/u;
// Inspect the user's wording outside quoted material; an embedded example
// isn't a new command. An unmatched quote isn't treated as a complete source.
const QUOTED_MATERIAL = /「[^」]+」|『[^』]+』|“[^”]+”|"[^"\r\n]+"/gu;
const PERSONAL_CONTEXT =
  /(?:上次|上回|之前的?记录|先前的?记录|(?:我|我们)(?:的|之前|曾经|最新).{0,200}?(?:记录|保存|归档|审批|报告)|我(?:记|存|写)过|我的(?:报告|项目|工作记忆)|\b(?:my|our)\s+(?:(?:last|previous|saved)\s+)?(?:notes?|records?|report|approval)\b|\bwhat did (?:i|we) (?:save|record|decide)\b)/iu;
const SEARCH_REQUEST =
  /^(?:请\s*)?(?:帮我\s*)?(?:查一下|查找|检索|搜索|翻一下|回顾|look up|find my|search (?:my|our))/iu;
const DEFINITION = /(?:是什么|什么意思(?:啊)?|有何区别)[?？。！!]?\s*$/u;
const QUESTION =
  /[?？]\s*$|(?:怎么回事|为什么|吗)[。！!]?\s*$|^(?:请\s*)?(?:帮我\s*)?(?:解释|说明|比较|翻译|what\b|why\b|how (?:does|do|can)\b|explain\b|translate\b)/iu;
const REWRITE =
  /(?:改写|润色|改成|改为|缩写|总结|译成|翻译|rewrite|rephrase|summari[sz]e|translate)/iu;
const DEICTIC_TARGET =
  /那个|这个(?:实验|任务|项目|报告|文件)|上一(?:个|份|次)|刚才(?:的|那个)|\b(?:that|this|the last) (?:lab|report|task|file)\b/iu;
const TARGET_CHANGE =
  /^(?:请\s*)?(?:帮我\s*)?(?:接着\s*|继续\s*)?(?:修改|更改|改|修复|修订|续做|完成|update\b|edit\b|fix\b|continue\b)/iu;
const WORKSPACE_CHECK =
  /^(?:请\s*)?(?:帮我\s*)?(?:只读\s*)?(?:检查|查看|核对|打开|读取|运行|执行|check\b|inspect\b|open\b|run\b).{0,160}(?:工作区|目录|文件|路径|仓库|命令|报告|脚本|测试|workspace\b|file\b|repo\b|report\b|script\b)/iu;
const BARE_APPROVAL =
  /^(?:好(?:的)?|行|可以|确认|批准|同意|就(?:这个|那个)|执行吧|保存吧|yes|ok(?:ay)?|approved|go ahead)[\s。！!.]*$/iu;
const SECOND_REQUEST =
  /(?:然后|接着|同时|并且|另外|顺便|[；;]|\band then\b)\s*(?:请\s*)?(?:帮我\s*)?(?:记(?:录)?一下|归档|保存|查|改|运行|执行|检查|打开|find\b|save\b|run\b|edit\b)/iu;

export function decideChatPurpose(text: string): ChatPurpose {
  const input = text.normalize("NFKC").trim();
  const wording = input.replace(QUOTED_MATERIAL, " ");
  if (BARE_APPROVAL.test(wording))
    return { kind: "clarify", reason: "explicit_confirmation" };
  if (SECOND_REQUEST.test(wording)) return { kind: "clarify", reason: "mixed" };

  const saves = SAVE_PREFIX.exec(wording);
  const definition = DEFINITION.test(wording);
  const asks = QUESTION.test(wording) || definition;
  if (saves !== null) {
    if (asks) return { kind: "clarify", reason: "mixed" };
    return input.slice(saves[0].length).trim() !== ""
      ? { kind: "archive" }
      : { kind: "clarify", reason: "purpose" };
  }
  if (wording !== input && REWRITE.test(wording)) return { kind: "answer" };
  const personal = PERSONAL_CONTEXT.test(wording);
  if (definition && !personal) return { kind: "answer" };
  if (SEARCH_REQUEST.test(wording) || (asks && personal))
    return { kind: "lookup" };
  if (asks && !TARGET_CHANGE.test(wording) && !WORKSPACE_CHECK.test(wording))
    return { kind: "answer" };
  if (TARGET_CHANGE.test(wording) || WORKSPACE_CHECK.test(wording)) {
    return DEICTIC_TARGET.test(wording) || DEICTIC_TARGET.test(input)
      ? { kind: "clarify", reason: "target" }
      : { kind: "propose_execution" };
  }
  if (!UNASSERTED_REPORT.test(wording) && PLAIN_REPORT.test(wording))
    return { kind: "archive" };
  return { kind: "clarify", reason: "purpose" };
}
