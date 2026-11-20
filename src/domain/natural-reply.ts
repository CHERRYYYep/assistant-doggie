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
  const result = candidateSelection(text, candidates, truncated);
  return result.kind === "selected" ? result.candidate : undefined;
}

export type CandidateSelection =
  | { readonly kind: "selected"; readonly candidate: SubjectCandidate }
  | { readonly kind: "conflict" }
  | { readonly kind: "none" };

/**
 * Resolve selection statements across the whole reply. Incidental mentions in
 * editing requirements are ignored; two separately stated selections are not.
 */
export function candidateSelection(
  text: string,
  candidates: readonly SubjectCandidate[],
  truncated: boolean,
): CandidateSelection {
  if (truncated || /[?？]|都(?:改|选|要)|两个|两份|以及|或者/u.test(text))
    return { kind: "none" };

  const choices: SubjectCandidate[] = [];
  const clauses = text.split(/[，,；;。\n]/u).map((part) => part.trim());
  for (const [index, clause] of clauses.entries()) {
    const normalizedClause = normalized(clause);
    if (!normalizedClause) continue;
    const negated = /^(?:不是|不要|别)\s*/u.exec(normalizedClause);
    const appendChoice = /(?:也要|还要|也改|也选|另外要|另一个)$/u.test(
      normalizedClause,
    );
    const explicitlySelected =
      /^(?:我选|选择|选|就是|是|我想(?:改|选)|改成|改为|换成)\s*/u.test(
        normalizedClause,
      ) || appendChoice;
    const firstBare = index === 0 && negated === null;
    if (!explicitlySelected && !firstBare) continue;

    const argument = normalizedClause
      .replace(/^(?:不对\s*)/u, "")
      .replace(/^(?:我选|选择|选|就是|是|我想(?:改|选)|改成|改为|换成)\s*/u, "")
      .replace(/(?:也要|还要|也改|也选|另外要|另一个)$/u, "")
      .replace(/^[「『“"]|[」』”"]$/gu, "")
      .trim();
    if (!argument || /^(?:不对|不是|不要|别)$/u.test(argument)) continue;
    const candidate = candidateForArgument(argument, candidates);
    if (candidate !== undefined) choices.push(candidate);
  }

  const unique = [...new Map(choices.map((item) => [item.id, item])).values()];
  if (unique.length > 1) return { kind: "conflict" };
  const candidate = unique[0];
  return candidate === undefined
    ? { kind: "none" }
    : { kind: "selected", candidate };
}

function candidateForArgument(
  arg: string,
  candidates: readonly SubjectCandidate[],
): SubjectCandidate | undefined {
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
      conflict?: true;
    }[] => {
      if (view.awaiting === null) return [];
      if (cancel) return [{ view, command: "cancel" }];
      if (view.awaiting === "subject") {
        if (none) return [{ view, command: "none" }];
        const selection = candidateSelection(
          text,
          view.candidates,
          view.truncated,
        );
        if (selection.kind === "conflict") return [{ view, conflict: true }];
        return selection.kind === "selected"
          ? [{ view, picked: selection.candidate }]
          : [];
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
