// Envío por SMTP (Gmail) sin dependencias.
//
// Provisional hasta tener dominio propio y Resend (decidido el 2026-09-15):
// los códigos salen de la cuenta de soporte con una contraseña de aplicación.
//
// Por qué a mano y no una librería: son seis órdenes (EHLO, AUTH, MAIL, RCPT,
// DATA, QUIT) y así no entra código de terceros en la función que maneja los
// correos institucionales. Todo lo que no toca la red es puro y lo prueban los
// tests de vitest (src/test/smtp.test.ts) con una conexión falsa.
//
// Puerto 465 (TLS directo): las Edge Functions de Supabase no permiten salir
// por 25 ni por 587.

/** Lo mínimo de una conexión: Deno.TlsConn lo cumple. */
export interface SmtpConn {
  read(p: Uint8Array): Promise<number | null>;
  write(p: Uint8Array): Promise<number>;
  close(): void;
}

export interface SmtpMessage {
  from: string; // "Nombre <cuenta@gmail.com>" o solo la dirección
  to: string;
  subject: string;
  text: string;
  html: string;
}

export class SmtpError extends Error {
  constructor(readonly stage: string, readonly code: number) {
    super(`SMTP ${stage} ${code}`);
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Solo la dirección de "Nombre <dir>". */
export function addressOf(value: string): string {
  const m = /<([^<>\s]+@[^<>\s]+)>\s*$/.exec(value);
  return (m ? m[1] : value).trim();
}

const hasCrlf = (s: string) => /[\r\n]/.test(s);

function base64Utf8(s: string): string {
  const bytes = enc.encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** RFC 2047 si hay algo fuera de ASCII; si no, tal cual. */
export function encodeHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${base64Utf8(value)}?=`;
}

/** "Nombre <dir>" con el nombre codificado si lleva acentos. */
function encodeAddress(value: string): string {
  const m = /^\s*(.*?)\s*<([^<>]+)>\s*$/.exec(value);
  if (!m || !m[1]) return addressOf(value);
  return `${encodeHeader(m[1].replace(/"/g, ""))} <${m[2]}>`;
}

const wrap76 = (s: string) => s.replace(/.{1,76}/g, "$&\r\n");

/**
 * El mensaje completo, listo para DATA: cabeceras, multipart/alternative con
 * texto y HTML en base64 (así ninguna línea empieza por punto ni pasa de 76
 * caracteres) y el punto final. Rechaza saltos de línea en las cabeceras:
 * sería inyección de cabeceras.
 */
export function buildMimeMessage(msg: SmtpMessage, opts: { date: Date; messageId: string; boundary: string }): string {
  for (const v of [msg.from, msg.to, msg.subject]) {
    if (hasCrlf(v)) throw new Error("cabecera con salto de línea");
  }
  const b = opts.boundary;
  const lines = [
    `From: ${encodeAddress(msg.from)}`,
    `To: ${addressOf(msg.to)}`,
    `Subject: ${encodeHeader(msg.subject)}`,
    `Date: ${opts.date.toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${opts.messageId}>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${b}"`,
    "",
    `--${b}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(base64Utf8(msg.text)).trimEnd(),
    `--${b}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(base64Utf8(msg.html)).trimEnd(),
    `--${b}--`,
  ];
  // Transparencia (RFC 5321 §4.5.2), aunque con base64 no debería hacer falta.
  return lines.map((l) => (l.startsWith(".") ? `.${l}` : l)).join("\r\n") + "\r\n.\r\n";
}

/** Lee una respuesta completa, también las de varias líneas ("250-..."). */
async function readReply(conn: SmtpConn, buffered: { rest: string }): Promise<{ code: number; text: string }> {
  const chunk = new Uint8Array(4096);
  for (;;) {
    const lines = buffered.rest.split("\r\n");
    for (let i = 0; i < lines.length - 1; i++) {
      const m = /^(\d{3})([ -])(.*)$/.exec(lines[i]);
      if (m && m[2] === " ") {
        buffered.rest = lines.slice(i + 1).join("\r\n");
        return { code: Number(m[1]), text: lines.slice(0, i + 1).join("\n") };
      }
    }
    const n = await conn.read(chunk);
    if (n === null) throw new SmtpError("closed", 0);
    buffered.rest += dec.decode(chunk.subarray(0, n));
  }
}

/**
 * La conversación SMTP sobre una conexión ya cifrada. Nunca escribe la
 * contraseña en errores ni logs: SmtpError solo lleva la etapa y el código.
 */
export async function smtpSend(
  conn: SmtpConn,
  auth: { user: string; password: string },
  msg: SmtpMessage,
  opts: { heloName: string; date?: Date; messageId?: string; boundary?: string },
): Promise<void> {
  const buf = { rest: "" };
  const send = (line: string) => conn.write(enc.encode(line));
  const expect = async (stage: string, ok: number[]) => {
    const r = await readReply(conn, buf);
    if (!ok.includes(r.code)) throw new SmtpError(stage, r.code);
    return r;
  };
  const from = addressOf(msg.from);
  const to = addressOf(msg.to);
  if (hasCrlf(from) || hasCrlf(to) || hasCrlf(auth.user)) throw new Error("dirección con salto de línea");

  try {
    await expect("greeting", [220]);
    await send(`EHLO ${opts.heloName}\r\n`);
    await expect("ehlo", [250]);
    await send(`AUTH PLAIN ${base64Utf8(`\u0000${auth.user}\u0000${auth.password}`)}\r\n`);
    await expect("auth", [235]);
    await send(`MAIL FROM:<${from}>\r\n`);
    await expect("mail", [250]);
    await send(`RCPT TO:<${to}>\r\n`);
    await expect("rcpt", [250, 251]);
    await send("DATA\r\n");
    await expect("data", [354]);
    const domain = from.split("@")[1] ?? "localhost";
    await send(buildMimeMessage(msg, {
      date: opts.date ?? new Date(),
      messageId: opts.messageId ?? `${crypto.randomUUID()}@${domain}`,
      boundary: opts.boundary ?? `b-${crypto.randomUUID()}`,
    }));
    await expect("sent", [250]);
    await send("QUIT\r\n");
  } finally {
    try { conn.close(); } catch { /* ya cerrada */ }
  }
}
