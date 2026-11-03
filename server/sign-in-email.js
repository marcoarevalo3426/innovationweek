import { fileURLToPath } from 'node:url';

const logoCid = 'nep-innovation-week-logo';
const logoPath = fileURLToPath(new URL('../public/nep-innovation-week.png', import.meta.url));

// Inline styles and a table layout keep the email readable in desktop and mobile mail clients.
export function signInEmail({ from, to, code }) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) {
    throw new TypeError('A six-digit sign-in code is required.');
  }
  return {
    from,
    to,
    subject: 'Your NEP Innovation Week sign-in code',
    text: `NEP Innovation Week\n\nYour sign-in code is ${code}.\n\nEnter this code on the sign-in page. It expires in 10 minutes.\nNever share your sign-in code. If you did not request this email, you can safely ignore it.`,
    html: `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Your sign-in code</title></head>
<body style="margin:0;padding:0;background-color:#f4f1fa;color:#23242d;font-family:Arial,Helvetica,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">Your secure sign-in code for NEP Innovation Week. Valid for 10 minutes.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f1fa;">
    <tr><td align="center" style="padding:32px 12px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;background-color:#ffffff;border:1px solid #ddd8e6;border-radius:16px;">
        <tr><td align="center" style="padding:32px 24px 24px;border-bottom:1px solid #e1dce8;">
          <img src="cid:${logoCid}" alt="NEP Innovation Week" width="250" height="80" style="display:block;width:250px;max-width:100%;height:auto;border:0;">
        </td></tr>
        <tr><td style="padding:32px 24px;">
          <p style="margin:0 0 12px;color:#6036cc;font-size:12px;font-weight:700;letter-spacing:1.5px;">LET'S MAKE SOMETHING HAPPEN</p>
          <h1 style="margin:0 0 16px;font-size:28px;line-height:1.25;font-weight:700;">Your next big idea starts here.</h1>
          <p style="margin:0 0 24px;font-size:16px;line-height:1.7;color:#716a78;">Use this code to sign in to NEP Innovation Week and help shape what comes next.</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f0fc;border:1px solid #d8cdeb;border-radius:12px;">
            <tr><td align="center" style="padding:24px 8px;">
              <p style="margin:0 0 12px;font-size:12px;line-height:1.5;font-weight:700;letter-spacing:1.5px;color:#716a78;">YOUR SIGN-IN CODE</p>
              <p style="margin:0;font-family:'Courier New',Courier,monospace;font-size:44px;line-height:1.3;font-weight:800;letter-spacing:6px;color:#4923af;">${code}</p>
              <p style="margin:14px 0 0;font-size:14px;line-height:1.5;color:#716a78;">This code expires in <strong>10 minutes.</strong></p>
            </td></tr>
          </table>
          <p style="margin:24px 0 0;font-size:14px;line-height:1.7;color:#716a78;">Enter the code on the sign-in page. Keep it private &mdash; never share your sign-in code.</p>
          <p style="margin:16px 0 0;font-size:12px;line-height:1.7;color:#716a78;">Didn't request this email? You can safely ignore it.</p>
        </td></tr>
        <tr><td align="center" style="padding:20px 24px;border-top:1px solid #e1dce8;font-size:12px;line-height:1.7;color:#716a78;">One NEP. Endless possibilities.</td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
    // CID embeds the supplied PNG in the message, without requiring remote image hosting.
    attachments: [{ filename: 'nep-innovation-week.png', path: logoPath, cid: logoCid, contentDisposition: 'inline' }],
  };
}
