/** Route a fresh main-chat message. The decision never grants authority. */
export type ChatPurpose =
  | { readonly kind: "answer" }
  | { readonly kind: "lookup" }
  | { readonly kind: "archive" }
  | { readonly kind: "propose_execution" }
  | {
      readonly kind: "clarify";
      readonly reason:
        | "purpose"
        | "target"
        | "mixed"
        | "explicit_confirmation"
        | "archive_content"
        | "rewrite_material";
    };

const SAVE_PREFIX =
  /^(?:请\s*)?(?:记(?:录)?一下\s*[:：，,]?|(?:归档|工作记录|进度更新)\s*[:：]|(?:log|record)\s+(?:this\b\s*[:：,]?|:\s*))/iu;
const PLAIN_REPORT =
  /^[^，,。？！?!\r\n]{1,80}\b(?:p\d{2}|qps|tps)\b\s*(?:为|达到|降至|升至|[:：]|从\s*\d+(?:\.\d+)?\s*(?:ms|s)?\s*(?:降到|升到|变为))\s*\d+(?:\.\d+)?\s*(?:ms|s)?[。.]?$/iu;
const UNASSERTED_REPORT =
  /^(?:如果|假如|假设|若|预计|请|据说|听说|猜测)|可能|大概|是否|能否|不是/u;
// An incomplete fence is still data, but cannot satisfy a request for source text.
const DELIMITED_MATERIAL =
  /\x60{3}[^\r\n\x60]*\r?\n(?<code>[\s\S]*?)\x60{3}|\x60{3}[\s\S]*|「(?<corner>[^」]*)」|『(?<doubleCorner>[^』]*)』|“(?<curly>[^”]*)”|‘(?<single>[^’]*)’|"(?<straight>[^"\r\n]*)"/gu;
const PERSONAL_CONTEXT =
  /(?:上次|上回|之前的?记录|先前的?记录|(?:我|我们)(?:的|之前|曾经|最新).{0,200}?(?:记录|保存|归档|审批|报告)|我(?:记|存|写)过|我的(?:报告|项目|工作记忆)|\b(?:my|our)\s+(?:(?:last|previous|saved)\s+)?(?:notes?|records?|report|approval)\b|\bwhat did (?:i|we) (?:save|record|decide)\b)/iu;
const SEARCH_REQUEST =
  /^(?:请\s*)?(?:帮我\s*)?(?:查一下|查找|检索|搜索|翻一下|回顾|look up|find my|search (?:my|our))/iu;
const DEFINITION = /(?:是什么|什么意思(?:啊)?|有何区别)[?？。！!]?\s*$/u;
const QUESTION =
  /[?？]\s*$|(?:怎么回事|为什么|吗)[。！!]?\s*$|^(?:请\s*)?(?:帮我\s*)?(?:解释|说明|比较|翻译|what\b|why\b|how (?:does|do|can)\b|explain\b|translate\b)/iu;
const TRANSFORM =
  /(?:改写|润色|改成|改为|缩写|总结|译成|翻译|rewrite\b|rephrase\b|summari[sz]e\b|translate\b)/iu;
const REWRITE_COMMAND = new RegExp(
  String.raw`^(?:请\s*)?(?:帮我\s*)?` + TRANSFORM.source,
  "iu",
);
const MATERIAL_LABEL =
  /(?:^|[\s：:。！？!?；;，,])(?:原文|正文|材料|报告片段|以下内容|如下内容|这段内容)[ \t]*[:：]/u;
const MATERIAL_TRAILING_INSTRUCTION = new RegExp(
  String.raw`[。！？!?；;\r\n]\s*(?=(?:请\s*)?(?:帮我\s*)?` +
    TRANSFORM.source +
    ")",
  "iu",
);
const MATERIAL_COLON_INSTRUCTION = new RegExp(
  String.raw`^(?:请\s*)?(?:帮我\s*)?(?:把\s*[^：:\r\n。！？!?；;]*?)?` +
    TRANSFORM.source +
    String.raw`[^：:\r\n。！？!?；;]*[:：]`,
  "iu",
);
const SAVE_WITHOUT_TARGET =
  /^(?:请\s*)?(?:帮我\s*)?(?:把它|这个|这段|刚才的内容)?\s*(?:存下来|保存下来|记下来|归档一下)[\s。！!.]*$/iu;
const DEICTIC_TARGET =
  /那个|这个(?:实验|任务|项目|报告|文件)|上一(?:个|份|次)|刚才(?:的|那个)|\b(?:that|this|the last) (?:lab|report|task|file)\b/iu;
const TARGET_CHANGE =
  /^(?:请\s*)?(?:帮我\s*)?(?:接着\s*|继续\s*)?(?:修改|更改|改|修复|修订|续做|完成|update\b|edit\b|fix\b|continue\b)/iu;
const WORKSPACE_CHECK =
  /^(?:请\s*)?(?:帮我\s*)?(?:只读\s*)?(?:检查|查看|核对|打开|读取|运行|执行|check\b|inspect\b|open\b|run\b).{0,160}(?:工作区|目录|文件|路径|仓库|命令|报告|脚本|测试|workspace\b|file\b|repo\b|report\b|script\b)/iu;
const BARE_APPROVAL =
  /^(?:好(?:的)?|行|可以|确认|批准|同意|就(?:这个|那个)|执行吧|保存吧|yes|ok(?:ay)?|approved|go ahead)[\s。！!.]*$/iu;
const SECOND_REQUEST =
  /(?:然后|接着|同时|并且|另外|顺便|[；;]|\band then\b)\s*(?:请\s*)?(?:帮我\s*)?(?:记(?:录)?一下|归档|保存|存下来|查|改|运行|执行|检查|打开|find\b|save\b|run\b|edit\b)/iu;

function nonemptyMaterial(text: string): string | null {
  const trimmed = text.trim();
  return /[\p{L}\p{N}\p{S}]/u.test(trimmed) ? trimmed : null;
}

function splitMaterial(text: string): {
  readonly wording: string;
  readonly material: string | null;
} {
  const delimited = [...text.matchAll(DELIMITED_MATERIAL)].map((match) => ({
    start: match.index,
    text: nonemptyMaterial(
      match.groups?.["code"] ??
        match.groups?.["corner"] ??
        match.groups?.["doubleCorner"] ??
        match.groups?.["curly"] ??
        match.groups?.["single"] ??
        match.groups?.["straight"] ??
        "",
    ),
  }));
  // Preserve character offsets while separating instructions from material.
  const masked = text.replace(DELIMITED_MATERIAL, (data) =>
    " ".repeat(data.length),
  );
  const labelled = MATERIAL_LABEL.exec(masked);
  const marker = labelled ?? MATERIAL_COLON_INSTRUCTION.exec(masked);
  if (marker !== null) {
    const start = marker.index + marker[0].length;
    const instructionEnd = labelled === null ? start : marker.index;
    const first = delimited.find(({ start: at }) => at >= start);
    if (first !== undefined && text.slice(start, first.start).trim() === "")
      return {
        wording: (
          masked.slice(0, instructionEnd) +
          " " +
          masked.slice(start)
        ).trim(),
        material: first.text,
      };
    const trailing = MATERIAL_TRAILING_INSTRUCTION.exec(masked.slice(start));
    const end = trailing === null ? text.length : start + trailing.index + 1;
    return {
      wording: (
        masked.slice(0, instructionEnd) +
        " " +
        masked.slice(end)
      ).trim(),
      material: nonemptyMaterial(text.slice(start, end)),
    };
  }
  return {
    wording: masked.trim(),
    material: delimited.find(({ text: value }) => value !== null)?.text ?? null,
  };
}

/** Read explicitly provided source text without normalizing its characters. */
export function chatMaterialText(text: string): string | null {
  return splitMaterial(text.trim()).material;
}

export function decideChatPurpose(text: string): ChatPurpose {
  const input = text.trim();
  const { wording: instruction, material } = splitMaterial(input);
  const wording = instruction.normalize("NFKC");
  if (BARE_APPROVAL.test(wording))
    return { kind: "clarify", reason: "explicit_confirmation" };
  if (SAVE_WITHOUT_TARGET.test(wording))
    return { kind: "clarify", reason: "archive_content" };
  if (SECOND_REQUEST.test(wording)) return { kind: "clarify", reason: "mixed" };

  const saves = SAVE_PREFIX.exec(wording);
  const definition = DEFINITION.test(wording);
  const asks = QUESTION.test(wording) || definition;
  if (saves !== null) {
    if (asks) return { kind: "clarify", reason: "mixed" };
    return input.normalize("NFKC").slice(saves[0].length).trim() !== ""
      ? { kind: "archive" }
      : { kind: "clarify", reason: "purpose" };
  }
  if (material !== null && TRANSFORM.test(wording)) return { kind: "answer" };
  const personal = PERSONAL_CONTEXT.test(wording);
  if (definition && !personal) return { kind: "answer" };
  if (SEARCH_REQUEST.test(wording) || (asks && personal))
    return { kind: "lookup" };
  if (REWRITE_COMMAND.test(wording))
    return {
      kind: "clarify",
      reason: DEICTIC_TARGET.test(wording) ? "target" : "rewrite_material",
    };
  if (asks && !TARGET_CHANGE.test(wording) && !WORKSPACE_CHECK.test(wording))
    return { kind: "answer" };
  if (TARGET_CHANGE.test(wording) || WORKSPACE_CHECK.test(wording)) {
    return DEICTIC_TARGET.test(wording) ||
      (!TRANSFORM.test(wording) && DEICTIC_TARGET.test(input))
      ? { kind: "clarify", reason: "target" }
      : { kind: "propose_execution" };
  }
  if (!UNASSERTED_REPORT.test(wording) && PLAIN_REPORT.test(wording))
    return { kind: "archive" };
  return { kind: "clarify", reason: "purpose" };
}
