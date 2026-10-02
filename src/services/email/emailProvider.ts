import { config } from '../../config';
import { EmailMessage, EmailProvider } from './types';
import { mailgunProvider } from './providers/mailgunProvider';
import { logEmailProvider } from './providers/logEmailProvider';

/**
 * Provider registry. Switching email providers is a pure env change
 * (EMAIL_PROVIDER=mailgun|log); adding a provider means adding one adapter
 * here and no changes to the verification code.
 */
const providers: Record<string, EmailProvider> = {
  mailgun: mailgunProvider,
  log: logEmailProvider,
};

let overrideProvider: EmailProvider | null = null;

/** Swap the active provider at runtime (tests, or future dynamic config). */
export const setEmailProvider = (provider: EmailProvider | null): void => {
  overrideProvider = provider;
};

export const listEmailProviders = (): string[] => Object.keys(providers);

export const getEmailProvider = (): EmailProvider => {
  if (overrideProvider) return overrideProvider;

  const name = (config.email.provider || '').trim().toLowerCase();
  const provider = providers[name];

  if (!provider) {
    throw new Error(
      `Unknown EMAIL_PROVIDER "${config.email.provider}". Available: ${listEmailProviders().join(', ')}`
    );
  }
  return provider;
};

/**
 * Send an email through the configured provider.
 * Failures are logged without the message body (it contains the OTP).
 */
export const sendEmail = async (message: EmailMessage): Promise<void> => {
  const provider = getEmailProvider();
  try {
    await provider.send(message);
  } catch (error) {
    console.error(
      `[email] send failed provider=${provider.name} to=${message.to}:`,
      error instanceof Error ? error.message : 'unknown error'
    );
    throw error;
  }
};
