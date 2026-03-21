import { describe, expect, test } from "bun:test";
import { EmailService } from "./email-service";

describe("EmailService", () => {
  test("renders status, list, read, mark-read, and send actions from the configured backend", async () => {
    const service = new EmailService({
      backend: {
        getStatusSummary: async () => ({
          unreadCount: 3,
          apiAvailable: true,
        }),
        countUnread: async () => 3,
        listMailbox: async () => ({
          ok: true,
          action: "list_unread",
          mailbox: "unread",
          total: 3,
          messages: [
            {
              index: 1,
              uid: 7001,
              state: "unread",
              headers: {
                from: "Alice <alice@example.com>",
                to: "operator@example.com",
                cc: null,
                subject: "Need an answer",
                date: "2026-03-18T13:00:00.000Z",
                replyTo: null,
                messageId: "<abc@example.com>",
              },
            },
          ],
        }),
        readMessage: async () => ({
          ok: true,
          action: "read",
          message: {
            index: 1,
            uid: 7001,
            mailbox: "unread",
            state: "unread",
            headers: {
              from: "Alice <alice@example.com>",
              to: "operator@example.com",
              cc: null,
              subject: "Need an answer",
              date: "2026-03-18T13:00:00.000Z",
              replyTo: null,
              messageId: "<abc@example.com>",
            },
            body: "Can you reply today?",
            bodyTruncated: false,
          },
        }),
        markRead: async () => ({
          ok: true,
          action: "mark_read",
          marked: {
            index: 1,
            uid: 7001,
          },
          unreadCount: 2,
        }),
        markAllRead: async () => ({
          ok: true,
          action: "mark_all_read",
          markedCount: 3,
          unreadCount: 0,
        }),
        sendMessage: async () => ({
          ok: true,
          action: "send",
          messageId: "<sent@example.com>",
          accepted: ["recipient@example.com"],
          rejected: [],
          response: "250 Message queued",
        }),
      },
    }, {
      username: "operator@example.com",
    });

    const status = await service.invoke({ action: "status" });
    const list = await service.invoke({ action: "list_unread", limit: 5 });
    const read = await service.invoke({ action: "read", index: 1 });
    const markRead = await service.invoke({ action: "mark_read", index: 1 });
    const send = await service.invoke({
      action: "send",
      to: ["recipient@example.com"],
      subject: "Email test",
      body: "Hello from OpenElinaro.",
    });

    expect(status).toContain("Email source: IMAP/SMTP operator@example.com");
    expect(status).toContain("Unread messages: 3");
    expect(status).toContain("API:  (configured)");
    expect(list).toContain("3 unread messages total.");
    expect(list).toContain("Alice <alice@example.com>");
    expect(read).toContain("Uid: 7001");
    expect(read).toContain("Subject: Need an answer");
    expect(read).toContain("Can you reply today?");
    expect(markRead).toContain("Marked unread message #1 as read.");
    expect(markRead).toContain("Uid: 7001");
    expect(markRead).toContain("Unread remaining: 2");
    expect(send).toContain("Sent email to recipient@example.com.");
    expect(send).toContain("Subject: Email test");
  });

  test("throws when the backend fails", async () => {
    const service = new EmailService({
      backend: {
        getStatusSummary: async () => ({ unreadCount: 0, apiAvailable: true }),
        countUnread: async () => {
          throw new Error("permission denied");
        },
        listMailbox: async () => {
          throw new Error("not implemented");
        },
        readMessage: async () => {
          throw new Error("not implemented");
        },
        markRead: async () => {
          throw new Error("not implemented");
        },
        markAllRead: async () => {
          throw new Error("not implemented");
        },
        sendMessage: async () => {
          throw new Error("not implemented");
        },
      },
    }, {
      username: "operator@example.com",
    });

    await expect(service.invoke({ action: "count" })).rejects.toThrow("permission denied");
  });
});
