import { chatMaterialText, decideChatPurpose } from "./chat-purpose.ts";
import {
  distinguishingFragment,
  normalized,
  type Interaction,
  type SubjectCandidate,
} from "./main-conversation.ts";

export function materialText(text: string): string | undefined {
  return /(?:^|[，,。；;\n])\s*(?:原文|正文|材料|报告片段)\s*[:：]\s*(\S[\s\S]*)$/u
    .exec(text)?.[1]
    ?.trim();
}
export function hasRequirements(text: string): boolean {
  return /改(?:写|成|为|得)|润色|缩写|精简|更(?:简洁|正式)|写反|纠正|不(?:增加|新增)事实|不要.{0,15}(?:改变|新增)|调整.{1,30}(?:顺序|格式)|翻译|rewrite|rephrase/iu.test(
    text,
  );
}

export function matchesCandidate(
  text: string,
  candidates: readonly SubjectCandidate[],
  truncated: boolean,
): SubjectCandidate | undefined {
  if (
    truncated ||
    /[?？]|都(?:改|选|要)|两个|两份|以及|或者|(?:同时|并且|然后|另外)\s*(?:也|再)?(?:改|选|检查)/u.test(
      text,
    )
  )
    return undefined;
  const clauses = text.split(/[，,；;。\n]/u).map(normalized);
  const first = clauses[0] ?? "";
  const selected = /^(?:不是|不要|别)/u.test(first)
    ? clauses[1]?.match(/^是\s*(.+)$/u)?.[1]
    : first.replace(/^(?:我选|选择|就是|选|是)\s*/u, "");
  if (!selected) return undefined;
  const arg = selected.replace(/^[「『“"]|[」』”"]$/gu, "");
  const fragment =
    distinguishingFragment(arg) ??
    /^([a-z][a-z\d-]{1,31})(?:那个|这个)?$/iu.exec(arg)?.[1];
  const hits = candidates.filter((candidate) => {
    const title = normalized(candidate.title);
    const hint = normalized(candidate.hint);
    return (
      arg === candidate.id ||
      arg === title ||
      (arg.length >= 4 && hint.includes(arg)) ||
      (candidates.length > 1 &&
        fragment !== undefined &&
        (/[a-z]/iu.test(fragment)
          ? Array.from(
              title.matchAll(/[a-z][a-z\d-]*/gu),
              (m) => m[0],
            ).includes(fragment)
          : title.includes(fragment) ||
            normalized(candidate.hint).includes(fragment) ||
            (fragment === "三次握手" &&
              candidate.kind === "entry" &&
              /\bsyn\b[\s，,。；;]*服务端[\s，,。；;]*回复[\s，,。；;]*syn-ack\b/iu.test(
                candidate.hint,
              ))))
    );
  });
  return hits.length === 1 ? hits[0] : undefined;
}

export function resolveNaturalReply(
  text: string,
  views: readonly Interaction[],
) {
  const purpose = decideChatPurpose(text);
  const material = materialText(text);
  const none = /^都不是[。！!]?$/u.test(text);
  const cancel = /^取消(?:这次澄清)?[。！!]?$/u.test(text);
  if (
    purpose.kind === "archive" ||
    purpose.kind === "lookup" ||
    (purpose.kind === "clarify" &&
      (purpose.reason === "explicit_confirmation" ||
        purpose.reason === "archive_content")) ||
    (purpose.kind === "answer" &&
      (material === undefined || hasRequirements(text))) ||
    /[？?]$/u.test(text)
  )
    return [];
  return views.flatMap(
    (
      view,
    ): {
      view: Interaction;
      picked?: SubjectCandidate;
      command?: "none" | "cancel";
    }[] => {
      if (view.awaiting === null) return [];
      if (cancel) return [{ view, command: "cancel" }];
      if (view.awaiting === "subject") {
        if (none) return [{ view, command: "none" }];
        const picked = matchesCandidate(text, view.candidates, view.truncated);
        return picked === undefined ? [] : [{ view, picked }];
      }
      const first = normalized(text.split(/[，,；;。\n]/u)[0] ?? "");
      const mentions =
        view.selected !== null &&
        (first.includes(normalized(view.selected.title)) ||
          (
            normalized(view.selected.title).match(/[a-z][a-z\d-]*/gu) ?? []
          ).some((term) => first.startsWith(term)));
      if (
        material !== undefined &&
        (text.startsWith("原文") ||
          mentions ||
          /^(?:正文|材料|报告片段)\s*[:：]/u.test(text))
      )
        return [{ view }];
      if (
        view.awaiting === "requirements" &&
        hasRequirements(text) &&
        (mentions ||
          /^(?:只改报告[，,；;]?\s*)?(?:改成|改为|润色|精简|缩写)/u.test(text))
      )
        return [{ view }];
      return [];
    },
  );
}
