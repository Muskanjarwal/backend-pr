import type { FastifyBaseLogger } from "fastify";

export interface Notification {
  userId: string;
  template: string;
  data: Record<string, unknown>;
}

/** Port for email/SMS/push. The default adapter only logs; swap in SES/Twilio/FCM without touching callers. */
export interface Notifier {
  send(n: Notification): Promise<void>;
}

export class LogNotifier implements Notifier {
  readonly sent: Notification[] = [];
  constructor(private readonly log?: Pick<FastifyBaseLogger, "info">) {}
  async send(n: Notification): Promise<void> {
    this.sent.push(n);
    this.log?.info({ userId: n.userId, template: n.template }, "notification sent"); // template only — no message body/PII in logs
  }
}
