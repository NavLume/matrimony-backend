import type { SmsMessage, SmsSender } from './sender.js';

const SEND_URL = 'https://api.sms.net.bd/sendsms';

/**
 * sms.net.bd (Alpha SMS), Bangladesh: one message per request, as documented at https://www.alpha.net.bd/SMS/api/.
 * POST `api_key`, `msg`, `to` (and `sender_id` when the agency has an approved masking name) as a form body; the
 * answer is `{ error: 0, msg, data: { request_id } }` on success and a non-zero `error` code otherwise (417 means the
 * balance is used up). The number is sent as 8801XXXXXXXXX (no +), the form the gateway documents.
 *
 * It throws on any failure, so the caller can tell the visitor and keep the lead; it never logs the number, the text
 * (it carries a code) or the key. The error message is only the gateway's numeric code.
 */
export class SmsNetBdSender implements SmsSender {
  constructor(
    private readonly apiKey: string,
    private readonly timeoutMs: number,
    private readonly senderId?: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async send(message: SmsMessage): Promise<void> {
    const body = new URLSearchParams({
      api_key: this.apiKey,
      msg: message.text,
      to: message.to.replace(/^\+/, ''),
    });
    if (this.senderId) body.set('sender_id', this.senderId);

    const answer = await this.fetchFn(SEND_URL, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    let result: { error?: unknown } = {};
    try {
      result = (await answer.json()) as { error?: unknown };
    } catch {
      throw new SmsGatewayError(`http-${answer.status}`);
    }
    // The documented samples show the code as a number, others compare it as text: read both.
    const code = Number(result.error);
    if (!answer.ok || code !== 0) throw new SmsGatewayError(String(result.error ?? answer.status));
  }
}

/** The gateway refused or failed a message. `code` is the gateway's own number (for example 417, no balance). */
export class SmsGatewayError extends Error {
  constructor(readonly code: string) {
    super(`SMS gateway error ${code}`);
    this.name = 'SmsGatewayError';
  }
}
