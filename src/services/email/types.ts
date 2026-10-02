/** Minimal contract every email provider adapter must implement. */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailProvider {
  /** Stable identifier, used for logging which adapter handled a send. */
  readonly name: string;
  send(message: EmailMessage): Promise<void>;
}
