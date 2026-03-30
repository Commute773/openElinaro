import { OpenElinaroApp } from "./app/runtime";

const app = new OpenElinaroApp();

const immediateResponses = [
  await app.handleRequest({
    id: "req-chat",
    text: "What should I focus on tonight?",
  }),
];

await new Promise((resolve) => setTimeout(resolve, 10));

console.log(
  JSON.stringify(
    {
      name: "openelinaro",
      runtime: "bun",
      immediateResponses,
    },
    null,
    2,
  ),
);
