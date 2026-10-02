import { config } from '../../config';

export interface OtpEmailContent {
  subject: string;
  text: string;
  html: string;
}

/**
 * Builds the OTP email. The code is included here (that is the point of the
 * email) but must never be written to logs or returned by an API response.
 */
export const buildOtpEmail = (options: {
  code: string;
  collegeName?: string;
  expiresInMinutes: number;
}): OtpEmailContent => {
  const { code, collegeName, expiresInMinutes } = options;
  const audience = collegeName ? ` for ${collegeName}` : '';

  const subject = 'Your College Connect verification code';
  const text = [
    `Your verification code${audience} is: ${code}`,
    '',
    `The code expires in ${expiresInMinutes} minutes.`,
    'If you did not request this code, you can safely ignore this email.',
  ].join('\n');

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto;">
      <h2 style="color: #4F46E5; margin-bottom: 8px;">College Connect</h2>
      <p style="color: #374151;">Your verification code${audience} is:</p>
      <p style="font-size: 32px; letter-spacing: 8px; font-weight: 700; color: #111827; background: #F3F4F6; padding: 16px; text-align: center; border-radius: 8px;">
        ${code}
      </p>
      <p style="color: #6B7280; font-size: 14px;">
        The code expires in ${expiresInMinutes} minutes.<br/>
        If you did not request this code, you can safely ignore this email.
      </p>
      <p style="color: #9CA3AF; font-size: 12px;">Sent from ${config.email.from}</p>
    </div>
  `.trim();

  return { subject, text, html };
};
