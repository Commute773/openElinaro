export type CommunicationDirection = "inbound" | "outbound" | "unknown";

export type CallChannel = "phone" | "sip" | "app" | "websocket" | "vbc" | "unknown";
export type MessageChannel = "sms" | "mms" | "whatsapp" | "messenger" | "viber" | "unknown";

export type CallControlAction = "talk" | "stop_talk" | "stream" | "stop_stream" | "transfer";

export interface CommunicationEventRecord {
  id: string;
  receivedAt: string;
  provider: "vonage";
  source:
    | "voice.answer"
    | "voice.event"
    | "voice.fallback"
    | "messages.inbound"
    | "messages.status"
    | "api.call.create"
    | "api.call.control"
    | "api.message.send";
  eventType: string;
  verified: boolean;
  payload: Record<string, unknown>;
}

export interface CallRecord {
  id: string;
  provider: "vonage";
  direction: CommunicationDirection;
  channel: CallChannel;
  status: string;
  from: string | null;
  to: string | null;
  conversationUuid: string | null;
  regionUrl: string | null;
  startedAt: string | null;
  answeredAt: string | null;
  completedAt: string | null;
  durationSeconds: number | null;
  price: string | null;
  createdAt: string;
  updatedAt: string;
  events: CommunicationEventRecord[];
}

export interface MessageRecord {
  id: string;
  provider: "vonage";
  direction: CommunicationDirection;
  channel: MessageChannel;
  status: string;
  from: string | null;
  to: string | null;
  text: string | null;
  clientRef: string | null;
  createdAt: string;
  updatedAt: string;
  events: CommunicationEventRecord[];
}

export interface CommunicationsStoreShape {
  version: 1;
  calls: Record<string, CallRecord>;
  messages: Record<string, MessageRecord>;
}

export interface CommunicationsStatus {
  configured: boolean;
  missing: string[];
  warnings: string[];
  publicBaseUrl: string | null;
  httpHost: string;
  httpPort: number;
  webhookUrls: {
    voiceAnswer: string | null;
    voiceEvent: string | null;
    voiceFallback: string | null;
    messagesInbound: string | null;
    messagesStatus: string | null;
  };
  vonage: {
    applicationId: string | null;
    privateKeySecretRef: string;
    privateKeyConfigured: boolean;
    signatureSecretRef: string;
    signatureSecretConfigured: boolean;
    voiceRegion: string | null;
    defaultFromNumber: string | null;
    defaultMessageChannel: MessageChannel;
    defaultMessageFrom: string | null;
  };
}
