import { config } from '../../../config';
import { EmailMessage, EmailProvider } from '../types';

/**
 * Mailgun over the HTTP API (no SDK).
 * Configure with MAILGUN_API_KEY, MAILGUN_DOMAIN, EMAIL_FROM and
 * optionally MAILGUN_REGION=EU / MAILGUN_API_BASE.
 */
export const mailgunProvider: EmailProvider = {
  name: 'mailgun',

  async send(message: EmailMessage): Promise<void> {
    const { apiKey, domain, apiBase } = config.email.mailgun;
    if (!apiKey || !domain) {
      throw new Error('Mailgun is not configured (MAILGUN_API_KEY, MAILGUN_DOMAIN)');
    }

    const body = new URLSearchParams({
      from: config.email.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
    if (message.html) body.set('html', message.html);

    let response: Response;
    try {
      console.log('Mailgun request:', `${apiBase}/v3/${domain}/messages`);
      response = await fetch(`${apiBase}/v3/${domain}/messages`, {
        method: 'POST',
        headers: { Authorization: `Basic ${Buffer.from(`api:${apiKey}`).toString('base64')}` },
        body,
      });
    } catch (error) {
      console.error('Mailgun request failed:', error);
      // Deliberately logs no request content - the body contains the OTP.
      throw new Error(`Mailgun request failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }

    if (!response.ok) {
      // Status only: never log the OTP or the full payload.
      console.error('Mailgun responded with status:', JSON.stringify(response));
      throw new Error(`Mailgun responded with status ${response.status}`);
    }
  },
};
