import type { FastifyRequest } from 'fastify';
import { AppError } from '../exception/app-error.js';

/** The header the website sends the Turnstile answer in (no request body changes, so every schema stays strict). */
export const TURNSTILE_HEADER = 'x-turnstile-token';

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * Cloudflare Turnstile: proves a person (not a script) pressed a button that costs the agency a text message or an
 * email. Only the routes that send a code use it. Off when no secret is set (development, tests).
 */
export class TurnstileVerifier {
  constructor(
    private readonly secret: string,
    private readonly timeoutMs: number,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  /** Throws 400 CAPTCHA_FAILED unless Cloudflare says the token is good; 503 CAPTCHA_UNAVAILABLE when it cannot ask. */
  async verify(token: string | undefined, remoteIp: string | undefined): Promise<void> {
    if (!token || token.length > 2048) throw new AppError(400, 'CAPTCHA_FAILED');
    const body = new URLSearchParams({ secret: this.secret, response: token });
    if (remoteIp) body.set('remoteip', remoteIp);
    let outcome: { success?: boolean };
    try {
      const answer = await this.fetchFn(VERIFY_URL, {
        method: 'POST',
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      outcome = (await answer.json()) as { success?: boolean };
    } catch {
      throw new AppError(503, 'CAPTCHA_UNAVAILABLE');
    }
    if (outcome.success !== true) throw new AppError(400, 'CAPTCHA_FAILED');
  }
}

/** For a route that sends a code: checks the Turnstile header when a verifier is set up, else lets it through. */
export async function requireHuman(
  verifier: TurnstileVerifier | undefined,
  req: FastifyRequest,
): Promise<void> {
  if (!verifier) return;
  const header = req.headers[TURNSTILE_HEADER];
  await verifier.verify(typeof header === 'string' ? header : undefined, req.ip);
}
