/**
 * Static OpenAPI 3.1 specification for the G2 API.
 * Built at module load time — no dynamic route introspection.
 */

const spec = {
  openapi: "3.1.0",
  info: {
    title: "OpenElinaro G2 API",
    version: "1.0.0",
    description:
      "HTTP API for the OpenElinaro agent platform. Provides access to agents, routines, todos, notifications, and a conversational ask endpoint.",
  },
  servers: [{ url: "http://localhost:3000" }],
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
      },
    },
    schemas: {
      Error: {
        type: "object",
        properties: {
          error: { type: "string" },
        },
        required: ["error"],
      },
      OkResponse: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
        },
        required: ["ok"],
      },
      HomeResponse: {
        type: "object",
        properties: {
          timeContext: { type: "string" },
          activeAgentCount: { type: "integer" },
          streak: { type: "integer" },
          nextRoutine: {
            type: ["object", "null"],
            properties: {
              name: { type: "string" },
              time: { type: "string" },
              type: { type: "string" },
            },
          },
          pendingNotificationCount: { type: "integer" },
        },
      },
      Agent: {
        type: "object",
        properties: {
          id: { type: "string" },
          status: { type: "string" },
          host: { type: "string" },
          uptime: { type: "string" },
          goal_truncated: { type: "string" },
        },
      },
      AgentOutput: {
        type: "object",
        properties: {
          runId: { type: "string" },
          output: {
            type: "array",
            items: { type: "string" },
          },
        },
      },
      Routine: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          time: { type: "string" },
          status: {
            type: "string",
            enum: ["done", "pending", "missed"],
          },
        },
      },
      Todo: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          status: { type: "string" },
          priority: { type: "string" },
        },
      },
      Notification: {
        type: "object",
        properties: {
          id: { type: "string" },
          type: { type: "string" },
          title: { type: "string" },
          body: { type: "string" },
          actions: {
            type: "array",
            items: { type: "string" },
          },
        },
      },
      AskRequest: {
        type: "object",
        properties: {
          text: { type: "string" },
        },
        required: ["text"],
      },
      AskResponse: {
        type: "object",
        properties: {
          response: { type: "string" },
        },
      },
      SendRequest: {
        type: "object",
        properties: {
          input: { type: "string" },
        },
        required: ["input"],
      },
      NotificationActionRequest: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["done", "snooze", "dismiss"],
          },
        },
      },
    },
  },
  paths: {
    "/api/g2/home": {
      get: {
        summary: "Dashboard home",
        description:
          "Returns a summary of active agents, routine streaks, next upcoming routine, and pending notification count.",
        operationId: "getHome",
        security: [{ bearerAuth: [] }],
        responses: {
          "200": {
            description: "Dashboard summary",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/HomeResponse" },
              },
            },
          },
        },
      },
    },
    "/api/g2/agents": {
      get: {
        summary: "List active agents",
        description: "Returns all currently running or starting agent runs.",
        operationId: "listAgents",
        security: [{ bearerAuth: [] }],
        responses: {
          "200": {
            description: "Array of active agents",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: { $ref: "#/components/schemas/Agent" },
                },
              },
            },
          },
        },
      },
    },
    "/api/g2/agents/{id}/output": {
      get: {
        summary: "Get agent output",
        description:
          "Captures recent terminal output from the agent's tmux session.",
        operationId: "getAgentOutput",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "Agent run ID",
          },
          {
            name: "lines",
            in: "query",
            required: false,
            schema: { type: "integer", default: 20 },
            description: "Number of output lines to return",
          },
        ],
        responses: {
          "200": {
            description: "Agent terminal output",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/AgentOutput" },
              },
            },
          },
        },
      },
    },
    "/api/g2/agents/{id}/send": {
      post: {
        summary: "Send input to agent",
        description: "Sends a text message to a running agent's tmux session.",
        operationId: "sendToAgent",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "Agent run ID",
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/SendRequest" },
            },
          },
        },
        responses: {
          "200": {
            description: "Input sent successfully",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/OkResponse" },
              },
            },
          },
          "400": {
            description: "Missing input",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          },
          "500": {
            description: "Failed to send",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          },
        },
      },
    },
    "/api/g2/routines": {
      get: {
        summary: "List routines",
        description:
          "Returns all active scheduled routine items with their current status (done, pending, or missed).",
        operationId: "listRoutines",
        security: [{ bearerAuth: [] }],
        responses: {
          "200": {
            description: "Array of routines sorted by time",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: { $ref: "#/components/schemas/Routine" },
                },
              },
            },
          },
        },
      },
    },
    "/api/g2/routines/{id}/done": {
      post: {
        summary: "Mark routine done",
        description: "Marks a routine item as completed for the current period.",
        operationId: "markRoutineDone",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "Routine item ID",
          },
        ],
        responses: {
          "200": {
            description: "Routine marked done",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/OkResponse" },
              },
            },
          },
          "500": {
            description: "Failed to mark done",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          },
        },
      },
    },
    "/api/g2/todos": {
      get: {
        summary: "List todos",
        description: "Returns all active todo items with their priority and status.",
        operationId: "listTodos",
        security: [{ bearerAuth: [] }],
        responses: {
          "200": {
            description: "Array of todo items",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: { $ref: "#/components/schemas/Todo" },
                },
              },
            },
          },
        },
      },
    },
    "/api/g2/todos/{id}/done": {
      post: {
        summary: "Mark todo done",
        description: "Marks a todo item as completed.",
        operationId: "markTodoDone",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "Todo item ID",
          },
        ],
        responses: {
          "200": {
            description: "Todo marked done",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/OkResponse" },
              },
            },
          },
          "500": {
            description: "Failed to mark done",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          },
        },
      },
    },
    "/api/g2/ask": {
      post: {
        summary: "Ask the agent",
        description:
          "Sends a natural-language query to the agent and returns its response.",
        operationId: "ask",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AskRequest" },
            },
          },
        },
        responses: {
          "200": {
            description: "Agent response",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/AskResponse" },
              },
            },
          },
          "400": {
            description: "Missing text",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          },
          "500": {
            description: "Processing failure",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          },
        },
      },
    },
    "/api/g2/notifications": {
      get: {
        summary: "List notifications",
        description:
          "Returns pending notifications including overdue routine reminders and due alarms.",
        operationId: "listNotifications",
        security: [{ bearerAuth: [] }],
        responses: {
          "200": {
            description: "Array of notifications",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: { $ref: "#/components/schemas/Notification" },
                },
              },
            },
          },
        },
      },
    },
    "/api/g2/notifications/{id}/action": {
      post: {
        summary: "Act on notification",
        description:
          'Performs an action on a notification (done, snooze, or dismiss). The notification ID has the format "type:itemId" (e.g. "routine:abc123" or "alarm:xyz789").',
        operationId: "notificationAction",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
            description:
              'Notification ID in "type:itemId" format (e.g. "routine:abc123")',
          },
        ],
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/NotificationActionRequest",
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Action performed",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/OkResponse" },
              },
            },
          },
          "500": {
            description: "Action failed",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          },
        },
      },
    },
    "/api/g2/openapi.json": {
      get: {
        summary: "OpenAPI specification",
        description:
          "Returns this OpenAPI 3.1 specification as JSON. No authentication required.",
        operationId: "getOpenApiSpec",
        security: [],
        responses: {
          "200": {
            description: "OpenAPI 3.1 specification",
            content: {
              "application/json": {
                schema: { type: "object" },
              },
            },
          },
        },
      },
    },
  },
};

export function getOpenApiSpec() {
  return spec;
}
