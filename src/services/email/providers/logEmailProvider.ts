import { EmailMessage, EmailProvider } from '../types';

/**
 * Development / fallback adapter. It accepts every message so the whole
 * verification flow can be exercised without SMTP credentials.
 *
 * The message body is NEVER logged - it contains the OTP.
 */
export const logEmailProvider: EmailProvider = {
  name: 'log',

  async send(message: EmailMessage): Promise<void> {
    console.log(`[email:log] provider=log to=${message.to} subject="${message.subject}"`);
  },
};
