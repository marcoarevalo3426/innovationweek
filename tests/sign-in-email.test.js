import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import nodemailer from 'nodemailer';
import { signInEmail } from '../server/sign-in-email.js';

const envelope = { from: 'Innovation Week <sender@example.invalid>', to: 'recipient@example.invalid' };

test('sign-in email preserves leading zeros and includes readable HTML and plain text', () => {
  const mail = signInEmail({ ...envelope, code: '000123' });
  assert.match(mail.text, /000123/);
  assert.match(mail.text, /10 minutes/);
  assert.match(mail.html, />000123<\/p>/);
  assert.match(mail.html, /font-size:48px[^>]+font-weight:900/);
  assert.match(mail.html, /never share your sign-in code/i);
  assert.equal(mail.to, envelope.to);
});

test('Nodemailer packages the actual logo as an inline image alongside both message formats', async () => {
  // Stream transport builds the complete email locally; it never opens an SMTP connection.
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
  const mail = signInEmail({ ...envelope, code: '654321' });
  const result = await transport.sendMail(mail);
  const message = result.message.toString();
  assert.match(message, /Content-Type: multipart\/alternative/i);
  assert.match(message, /Content-Type: multipart\/related/i);
  assert.match(message, /Content-Type: text\/plain/i);
  assert.match(message, /Content-Type: text\/html/i);
  assert.match(message, /Content-ID: <nep-innovation-week-logo>/i);
  assert.match(message, /Content-Disposition: inline/i);
  const image = readFileSync(mail.attachments[0].path);
  assert.equal(image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.ok(message.replace(/\s/g, '').includes(image.toString('base64')));
});

test('invalid codes cannot be interpolated into sign-in emails', () => {
  for (const code of ['12345', '1234567', '<img/>', '123 45', 123456, null]) {
    assert.throws(() => signInEmail({ ...envelope, code }), /six-digit/);
  }
});
