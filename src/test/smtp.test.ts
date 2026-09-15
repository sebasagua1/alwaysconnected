// @vitest-environment node
/**
 * El cliente SMTP de la función de verificación, contra un servidor falso.
 */
import { describe, it, expect } from 'vitest';
import {
  addressOf, encodeHeader, buildMimeMessage, smtpSend, SmtpError, type SmtpConn,
} from '../../supabase/functions/_shared/smtp';

const dec = new TextDecoder();
const enc = new TextEncoder();

/** Responde a cada orden con la siguiente respuesta del guion. */
function fakeServer(script: Record<string, string>, greeting = '220 smtp.gmail.com ESMTP\r\n') {
  const sent: string[] = [];
  let pending = greeting;
  let inData = false;
  let closed = false;
  const conn: SmtpConn = {
    async read(p) {
      if (!pending) return closed ? null : new Promise<number | null>((r) => setTimeout(() => r(0), 0)) as Promise<number | null>;
      const bytes = enc.encode(pending);
      p.set(bytes.subarray(0, p.length));
      pending = dec.decode(bytes.subarray(p.length));
      return Math.min(bytes.length, p.length);
    },
    async write(p) {
      const line = dec.decode(p);
      sent.push(line);
      if (inData) {
        inData = false;
        pending = script.sent ?? '250 2.0.0 OK\r\n';
      } else {
        const cmd = line.split(/[ :\r]/)[0].toUpperCase();
        pending = script[cmd] ?? '250 OK\r\n';
        if (cmd === 'DATA') inData = true;
      }
      return p.length;
    },
    close() { closed = true; },
  };
  return { conn, sent, isClosed: () => closed };
}

const msg = {
  from: 'Always Connected <always.connected.support@gmail.com>',
  to: 'a01714719@tec.mx',
  subject: '482913 es tu código de verificación de Always Connected',
  text: 'Escribe este código:\n\n482913\n',
  html: '<p>482913</p>',
};

describe('SMTP', () => {
  it('addressOf y encodeHeader', () => {
    expect(addressOf('Always Connected <x@gmail.com>')).toBe('x@gmail.com');
    expect(addressOf('x@gmail.com')).toBe('x@gmail.com');
    expect(encodeHeader('Hola')).toBe('Hola');
    expect(encodeHeader('código')).toBe('=?UTF-8?B?Y8OzZGlnbw==?=');
  });

  it('arma un multipart con texto y HTML en base64 que se decodifica igual', () => {
    const m = buildMimeMessage(msg, { date: new Date('2026-09-15T10:00:00Z'), messageId: 'id@gmail.com', boundary: 'B' });
    expect(m).toContain('From: Always Connected <always.connected.support@gmail.com>\r\n');
    expect(m).toContain('To: a01714719@tec.mx\r\n');
    expect(m).toContain('Subject: =?UTF-8?B?');
    expect(m.endsWith('\r\n.\r\n')).toBe(true);
    const parts = m.split('--B');
    const textB64 = parts[1].split('\r\n\r\n')[1].replace(/\r\n/g, '');
    expect(Buffer.from(textB64, 'base64').toString('utf8')).toBe(msg.text);
    // Ninguna línea pasa de 998 ni empieza por punto (salvo el final).
    const lines = m.split('\r\n').slice(0, -2);
    expect(lines.every((l) => l.length <= 998 && !l.startsWith('.'))).toBe(true);
  });

  it('rechaza saltos de línea en cabeceras (inyección)', () => {
    expect(() => buildMimeMessage({ ...msg, subject: 'hola\r\nBcc: otro@x.com' }, { date: new Date(), messageId: 'i', boundary: 'B' })).toThrow();
    expect(() => buildMimeMessage({ ...msg, to: 'a@tec.mx\nBcc: b@x.com' }, { date: new Date(), messageId: 'i', boundary: 'B' })).toThrow();
  });

  it('conversación completa: EHLO, AUTH PLAIN, MAIL, RCPT, DATA, mensaje, QUIT y cierra', async () => {
    const s = fakeServer({ EHLO: '250-smtp.gmail.com\r\n250-AUTH LOGIN PLAIN\r\n250 SMTPUTF8\r\n', AUTH: '235 2.7.0 Accepted\r\n', DATA: '354 Go ahead\r\n' });
    await smtpSend(s.conn, { user: 'always.connected.support@gmail.com', password: 'app pass word' }, msg, {
      heloName: 'test', date: new Date('2026-09-15T10:00:00Z'), messageId: 'id@gmail.com', boundary: 'B',
    });
    expect(s.sent[0]).toBe('EHLO test\r\n');
    const auth = s.sent[1].replace('AUTH PLAIN ', '').trim();
    expect(Buffer.from(auth, 'base64').toString('utf8')).toBe('\u0000always.connected.support@gmail.com\u0000app pass word');
    expect(s.sent[2]).toBe('MAIL FROM:<always.connected.support@gmail.com>\r\n');
    expect(s.sent[3]).toBe('RCPT TO:<a01714719@tec.mx>\r\n');
    expect(s.sent[4]).toBe('DATA\r\n');
    expect(s.sent[5]).toContain('Content-Type: multipart/alternative');
    expect(s.sent[6]).toBe('QUIT\r\n');
    expect(s.isClosed()).toBe(true);
  });

  it('contraseña rechazada: error con etapa y código, sin la contraseña, y cierra', async () => {
    const s = fakeServer({ AUTH: '535-5.7.8 Username and Password not accepted\r\n535 5.7.8 BadCredentials\r\n' });
    const err = await smtpSend(s.conn, { user: 'u@gmail.com', password: 'secreta123' }, msg, { heloName: 't' }).catch((e) => e);
    expect(err).toBeInstanceOf(SmtpError);
    expect(err).toMatchObject({ stage: 'auth', code: 535 });
    expect(String(err.message)).not.toContain('secreta123');
    expect(s.sent.some((l) => l.startsWith('MAIL'))).toBe(false);
    expect(s.isClosed()).toBe(true);
  });

  it('destinatario rechazado: no manda DATA', async () => {
    const s = fakeServer({ AUTH: '235 ok\r\n', RCPT: '550 5.1.1 No such user\r\n' });
    const err = await smtpSend(s.conn, { user: 'u@gmail.com', password: 'p' }, msg, { heloName: 't' }).catch((e) => e);
    expect(err).toMatchObject({ stage: 'rcpt', code: 550 });
    expect(s.sent.some((l) => l.startsWith('DATA'))).toBe(false);
  });
});
