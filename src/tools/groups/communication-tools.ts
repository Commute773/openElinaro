import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import { PHONE_CALL_BACKENDS } from "../../services/phone-call-backends";
import { createTraceSpan } from "../../utils/telemetry-helpers";
import { telemetry } from "../../services/telemetry";
import type { ToolBuildContext } from "./tool-group-types";

const toolTelemetry = telemetry.child({ component: "tool" });
const traceSpan = createTraceSpan(toolTelemetry);

const responseFormatSchema = z.enum(["text", "json"]);
const communicationDirectionSchema = z.enum(["inbound", "outbound", "unknown"]);
const messageChannelSchema = z.enum(["sms", "mms", "whatsapp", "messenger", "viber", "unknown"]);
const emailActionSchema = z.enum(["status", "count", "list_unread", "list_recent", "read", "mark_read", "mark_all_read", "send"]);
const emailMailboxSchema = z.enum(["unread", "recent"]);
const callControlActionSchema = z.enum(["talk", "stop_talk", "stream", "stop_stream", "transfer"]);

/** Coerce a bare string into a single-element array so the model can pass either form. */
const coerceStringArray = (maxItems: number) =>
  z.preprocess(
    (val) => (typeof val === "string" ? [val] : val),
    z.array(z.string().min(1)).min(1).max(maxItems),
  );

const emailSchema = z.object({
  action: emailActionSchema,
  mailbox: emailMailboxSchema.optional(),
  index: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  to: coerceStringArray(50).optional(),
  cc: coerceStringArray(50).optional(),
  bcc: coerceStringArray(50).optional(),
  replyTo: coerceStringArray(10).optional(),
  subject: z.string().min(1).optional(),
  body: z.string().min(1).optional(),
  format: responseFormatSchema.optional(),
}).superRefine((value, ctx) => {
  if ((value.action === "read" || value.action === "mark_read") && value.index === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "index is required for read and mark_read.",
      path: ["index"],
    });
  }
  if (value.action === "send") {
    if (!value.to?.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "to is required for send.",
        path: ["to"],
      });
    }
    if (!value.subject?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "subject is required for send.",
        path: ["subject"],
      });
    }
    if (!value.body?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "body is required for send.",
        path: ["body"],
      });
    }
  }
});

const communicationsStatusSchema = z.object({
  format: responseFormatSchema.optional(),
});

const makePhoneCallSchema = z.object({
  to: z.string().min(1),
  from: z.string().min(1).optional(),
  instructions: z.string().min(8),
  backend: z.enum(PHONE_CALL_BACKENDS).optional(),
});

const callListSchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  status: z.string().min(1).optional(),
  direction: communicationDirectionSchema.optional(),
  format: responseFormatSchema.optional(),
});

const idSchema = z.object({
  id: z.string().min(1),
});

const callControlSchema = z.object({
  uuid: z.string().min(1),
  action: callControlActionSchema,
  text: z.string().min(1).optional(),
  streamUrl: z.string().url().optional(),
  loop: z.number().int().min(1).max(100).optional(),
  language: z.string().min(1).optional(),
  destinationNumber: z.string().min(1).optional(),
}).superRefine((value, ctx) => {
  if (value.action === "talk" && !value.text?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "text is required for talk.",
      path: ["text"],
    });
  }
  if (value.action === "stream" && !value.streamUrl?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "streamUrl is required for stream.",
      path: ["streamUrl"],
    });
  }
  if (value.action === "transfer" && !value.destinationNumber?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "destinationNumber is required for transfer.",
      path: ["destinationNumber"],
    });
  }
});

const messageSendSchema = z.object({
  to: z.string().min(1),
  from: z.string().min(1).optional(),
  channel: messageChannelSchema.optional(),
  text: z.string().min(1),
  clientRef: z.string().min(1).optional(),
});

const messageListSchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  status: z.string().min(1).optional(),
  direction: communicationDirectionSchema.optional(),
  channel: messageChannelSchema.optional(),
  format: responseFormatSchema.optional(),
});

export function buildCommunicationTools(ctx: ToolBuildContext): StructuredToolInterface[] {
  const tools: StructuredToolInterface[] = [];

  if (ctx.featureConfig.isActive("email")) {
    tools.push(
      tool(
        async (input) =>
          traceSpan(
            "tool.email",
            async () => ctx.email.invoke({
              action: input.action,
              mailbox: input.mailbox,
              index: input.index,
              limit: input.limit,
              to: input.to,
              cc: input.cc,
              bcc: input.bcc,
              replyTo: input.replyTo,
              subject: input.subject,
              body: input.body,
              format: input.format,
            }),
            { attributes: input },
          ),
        {
          name: "email",
          description:
            "Send and receive mail through the configured mailbox account: count unread mail, list unread or recent messages, read one message, mark unread messages as read, and send outbound email.",
          schema: emailSchema,
        },
      ),
    );
  }

  if (ctx.featureConfig.isActive("communications")) {
    tools.push(
      tool(
        async (input) =>
          traceSpan(
            "tool.communications_status",
            async () => {
              const status = ctx.vonage.getStatus();
              if (input.format === "json") {
                return status;
              }
              return ctx.vonage.formatStatus(status);
            },
            { attributes: input },
          ),
        {
          name: "communications_status",
          description:
            "Show whether Vonage calls and messages are configured, including the exact webhook URLs and HTTP methods to enter in the Vonage dashboard.",
          schema: communicationsStatusSchema,
        },
      ),
      tool(
        async (input) =>
          traceSpan(
            "tool.make_phone_call",
            async () => {
              ctx.resolvePhoneCallBackend(input.backend);
              return ctx.geminiLivePhone.formatSession(await ctx.geminiLivePhone.makePhoneCall({
                to: input.to,
                from: input.from,
                instructions: input.instructions,
              }));
            },
            { attributes: input },
          ),
        {
          name: "make_phone_call",
          description:
            "Place an outbound Vonage phone call through the Gemini Live native-audio backend. The runtime writes a live transcript log to disk while the call is running.",
          schema: makePhoneCallSchema,
        },
      ),
      tool(
        async (input) =>
          traceSpan(
            "tool.call_list",
            async () => {
              const calls = await ctx.vonage.listCalls({
                limit: input.limit,
                status: input.status,
                direction: input.direction,
              });
              if (input.format === "json") {
                return calls;
              }
              return ctx.vonage.formatCallList(calls);
            },
            { attributes: input },
          ),
        {
          name: "call_list",
          description:
            "List recent Vonage call records, combining fetched call history with the runtime's locally persisted webhook events.",
          schema: callListSchema,
        },
      ),
      tool(
        async (input) =>
          traceSpan(
            "tool.call_get",
            async () => ctx.vonage.formatCall(await ctx.vonage.getCall(input.id)),
            { attributes: input },
          ),
        {
          name: "call_get",
          description:
            "Fetch one Vonage call by UUID and persist the latest remote details into the local communications store.",
          schema: idSchema,
        },
      ),
      tool(
        async (input) =>
          traceSpan(
            "tool.call_control",
            async () => ctx.vonage.formatCall(await ctx.vonage.controlCall({
              uuid: input.uuid,
              action: input.action,
              text: input.text,
              streamUrl: input.streamUrl,
              loop: input.loop,
              language: input.language,
              destinationNumber: input.destinationNumber,
            })),
            { attributes: input },
          ),
        {
          name: "call_control",
          description:
            "Control a live Vonage call by speaking TTS into it, stopping TTS, streaming audio, stopping audio, or transferring it to another phone number.",
          schema: callControlSchema,
        },
      ),
      tool(
        async (input) =>
          traceSpan(
            "tool.message_send",
            async () => ctx.vonage.formatMessage(await ctx.vonage.sendMessage({
              to: input.to,
              from: input.from,
              channel: input.channel,
              text: input.text,
              clientRef: input.clientRef,
            })),
            { attributes: input },
          ),
        {
          name: "message_send",
          description:
            "Send a Vonage text message over SMS, MMS, WhatsApp, Messenger, or Viber using the configured application keypair.",
          schema: messageSendSchema,
        },
      ),
      tool(
        async (input) =>
          traceSpan(
            "tool.message_list",
            async () => {
              const messages = ctx.vonage.listMessages({
                limit: input.limit,
                status: input.status,
                direction: input.direction,
                channel: input.channel,
              });
              if (input.format === "json") {
                return messages;
              }
              return ctx.vonage.formatMessageList(messages);
            },
            { attributes: input },
          ),
        {
          name: "message_list",
          description:
            "List locally persisted Vonage message records from outbound sends plus inbound and status webhooks.",
          schema: messageListSchema,
        },
      ),
      tool(
        async (input) =>
          traceSpan(
            "tool.message_get",
            async () => {
              const message = ctx.vonage.getMessage(input.id);
              if (!message) {
                return `No message record was found for ${input.id}.`;
              }
              return ctx.vonage.formatMessage(message);
            },
            { attributes: input },
          ),
        {
          name: "message_get",
          description:
            "Show one locally persisted Vonage message record by id or message UUID.",
          schema: idSchema,
        },
      ),
    );
  }

  return tools;
}
