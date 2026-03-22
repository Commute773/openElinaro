import { OpenElinaroApp } from "./app/runtime";

const app = new OpenElinaroApp();

const immediateResponses = [
  await app.handleRequest({
    id: "req-chat",
    kind: "chat",
    text: "What should I focus on tonight?",
  }),
  await app.handleRequest({
    id: "req-todo",
    kind: "todo",
    text: "Remember to refill meds on Friday",
    todoTitle: "Refill meds on Friday",
  }),
  await app.handleRequest({
    id: "req-med",
    kind: "medication",
    text: "Ibuprofen due at 21:00",
    medicationName: "Ibuprofen",
    medicationDueAt: "2026-03-11T21:00:00-04:00",
  }),
];

await new Promise((resolve) => setTimeout(resolve, 10));

console.log(
  JSON.stringify(
    {
      name: "openelinaro",
      runtime: "bun",
      orchestration: "tmux-subagent",
      immediateResponses,
      agentRuns: app.listAgentRuns(),
    },
    null,
    2,
  ),
);
