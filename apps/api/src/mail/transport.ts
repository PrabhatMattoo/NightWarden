import { createTransport } from "nodemailer";
import { mailServer, type MailServer } from "./store.js";

// Bounds the connect, the greeting and each silent stretch, so a black-holed host answers.
const MAIL_TIMEOUT_MS = 10_000;

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

// Its message is a sentence a person can act on, shown on the settings page as it stands.
export class MailServerError extends Error {}

function transportFor(server: MailServer) {
  const { host, port, security, username, password } = server;
  return createTransport({
    host,
    port,
    secure: security === "tls",
    requireTLS: security === "starttls",
    ignoreTLS: security === "none",
    ...(username !== null && {
      auth: { user: username, pass: password ?? "" },
    }),
    connectionTimeout: MAIL_TIMEOUT_MS,
    greetingTimeout: MAIL_TIMEOUT_MS,
    socketTimeout: MAIL_TIMEOUT_MS,
  });
}

function describeFailure(err: unknown, server: MailServer): string {
  const address = `${server.host}:${server.port}`;
  const field = (name: string): unknown =>
    typeof err === "object" && err !== null
      ? Reflect.get(err, name)
      : undefined;
  const detail = err instanceof Error ? err.message : String(err);
  switch (field("code")) {
    case "EAUTH":
      return "The mail server refused the username or password.";
    case "EDNS":
      return `The host name ${server.host} could not be found.`;
    case "ETIMEDOUT":
      return `The mail server at ${address} did not answer within ${MAIL_TIMEOUT_MS / 1000} seconds.`;
    case "ECONNECTION":
      return field("originalCode") === "ECONNREFUSED"
        ? `Nothing is accepting connections at ${address}.`
        : `The mail server at ${address} closed the connection. The port may expect a different security setting.`;
    case "ETLS":
    case "ESOCKET":
    case "EREQUIRETLS":
      return `A secure connection to ${address} could not be made (${detail}). Check the security setting against the port.`;
    default:
      return `The mail server at ${address} could not be checked: ${detail}`;
  }
}

// Connects, secures and logs in without sending a message.
export async function verifyMailServer(server: MailServer): Promise<void> {
  try {
    await transportFor(server).verify();
  } catch (err) {
    throw new MailServerError(describeFailure(err, server));
  }
}

export async function sendMail(message: MailMessage): Promise<void> {
  const server = mailServer();
  if (server === null) {
    throw new Error(
      "mail is not configured: set the host, port and from address under Settings, Mail",
    );
  }
  await transportFor(server).sendMail({ from: server.from, ...message });
}
