import { config } from '../../../config';
import { EmailMessage, EmailProvider } from '../types';

/**
 * Global `fetch` exists at runtime (Node >= 18) but is not declared by
 * @types/node@20, so it is typed here instead of adding a dependency.
 */
type FetchResponse = { ok: boolean; status: number; text(): Promise<string> };
type FetchFn = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }
) => Promise<FetchResponse>;

const fetchImpl = (globalThis as unknown as { fetch: FetchFn }).fetch;

/**
 * Mailgun over the HTTP API (no SDK).
 * Configure with MAILGUN_API_KEY, MAILGUN_DOMAIN, MAILGUN_FROM and
 * optionally MAILGUN_REGION=EU / MAILGUN_API_BASE.
 */
export const mailgunProvider: EmailProvider = {
  name: 'mailgun',

  async send(message: EmailMessage): Promise<void> {
    const { apiKey, domain, apiBase } = config.email.mailgun;

    if (!apiKey || !domain) {
      throw new Error('Mailgun is not configured (MAILGUN_API_KEY, MAILGUN_DOMAIN)');
    }
    if (typeof fetchImpl !== 'function') {
      throw new Error('Global fetch is unavailable in this Node runtime');
    }

    const body = new URLSearchParams();
    body.set('from', config.email.from);
    body.set('to', message.to);
    body.set('subject', message.subject);
    body.set('text', message.text);
    if (message.html) body.set('html', message.html);

    let response: FetchResponse;
    try {
      response = await fetchImpl(`${apiBase}/v3/${domain}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`api:${apiKey}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      });
    } catch (error) {
      // Deliberately logs no request content - the body contains the OTP.
      throw new Error(
        `Mailgun request failed: ${error instanceof Error ? error.message : 'unknown error'}`
      );
    }

    if (!response.ok) {
      // Status only: never log the OTP or the full payload.
      throw new Error(`Mailgun responded with status ${response.status}`);
    }
  },
};
