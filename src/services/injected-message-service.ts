export type InjectedMessageSource =
  | "alarm"
  | "autonomous_time"
  | "background_exec"
  | "heartbeat"
  | "memory_recall"
  | "recent_context"
  | "subagent_completion";

export function wrapInjectedMessage(generatedBy: InjectedMessageSource, content: string) {
  const body = content.trim();
  return `<INJECTED_MESSAGE generated_by="${generatedBy}">\n${body}\n</INJECTED_MESSAGE>`;
}
