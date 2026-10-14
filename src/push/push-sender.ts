/** One phone to reach. */
export interface PushTarget {
  platform: 'ios' | 'android';
  token: string;
}

/** What is shown on the phone. Generic on purpose: a lock screen is public. */
export interface PushMessage {
  title: string;
  body: string;
}

/**
 * Sends a push to one phone. `invalid_token` means the phone is gone (app removed, token replaced), so
 * the caller forgets it. A real gateway (Firebase Cloud Messaging for Android and iPhone) plugs in behind
 * this; nothing else changes. Production refuses the development sender.
 */
export interface PushSender {
  send(target: PushTarget, message: PushMessage): Promise<'sent' | 'invalid_token'>;
}

/** Development only: prints each push in the backend terminal. */
export class ConsolePushSender implements PushSender {
  constructor(private readonly write: (line: string) => void) {}

  async send(target: PushTarget, message: PushMessage): Promise<'sent'> {
    this.write(
      `[dev push] ${target.platform} ${target.token.slice(0, 12)}…\n[dev push] ${message.title}\n[dev push] ${message.body}`,
    );
    return 'sent';
  }
}
