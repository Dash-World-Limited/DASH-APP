const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeEmailHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}

export interface DashEmailDetail {
  label: string;
  value: string;
}

export interface DashEmailCta {
  label: string;
  href: string;
}

export interface DashEmailLayout {
  previewText: string;
  eyebrow?: string;
  title: string;
  greeting?: string;
  paragraphs?: readonly string[];
  code?: string;
  details?: readonly DashEmailDetail[];
  cta?: DashEmailCta;
  securityNote?: string;
}

/**
 * Email-client-safe DASH layout. Everything supplied here is escaped, so a
 * listing title, seller name or other user-authored value can never become HTML.
 */
export function dashEmailHtml(input: DashEmailLayout): string {
  const preview = escapeEmailHtml(input.previewText);
  const eyebrow = input.eyebrow ? escapeEmailHtml(input.eyebrow) : null;
  const title = escapeEmailHtml(input.title);
  const greeting = input.greeting ? escapeEmailHtml(input.greeting) : null;
  const paragraphs = (input.paragraphs ?? [])
    .map(
      (paragraph) =>
        `<p style="margin:14px 0 0;font-size:15px;line-height:24px;color:#4b5563;">${escapeEmailHtml(paragraph)}</p>`,
    )
    .join('');
  const code = input.code ? escapeEmailHtml(input.code) : null;
  const details = (input.details ?? [])
    .map(
      ({ label, value }) =>
        `<tr><td style="padding:9px 0;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:#9ca3af;vertical-align:top;">${escapeEmailHtml(label)}</td><td style="padding:9px 0 9px 18px;font-size:14px;font-weight:700;color:#111827;text-align:right;vertical-align:top;">${escapeEmailHtml(value)}</td></tr>`,
    )
    .join('');
  const cta = input.cta
    ? `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin-top:26px;"><tr><td style="border-radius:999px;background:#0f766e;"><a href="${escapeEmailHtml(input.cta.href)}" style="display:inline-block;padding:13px 22px;font-size:14px;font-weight:800;color:#ffffff;text-decoration:none;">${escapeEmailHtml(input.cta.label)}</a></td></tr></table>`
    : '';
  const securityNote = input.securityNote
    ? `<div style="margin-top:24px;border-left:3px solid #d8ad52;padding:2px 0 2px 14px;font-size:13px;line-height:20px;color:#6b7280;">${escapeEmailHtml(input.securityNote)}</div>`
    : '';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <meta name="supported-color-schemes" content="light" />
    <title>${title}</title>
  </head>
  <body style="margin:0;padding:0;background:#f4f6f9;font-family:Arial,Helvetica,sans-serif;color:#111827;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${preview}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#f4f6f9;padding:28px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:560px;background:#ffffff;border-radius:20px;overflow:hidden;border:1px solid #e5e7eb;">
            <tr>
              <td style="background:#0b1220;padding:26px 30px;">
                <div style="font-size:24px;font-weight:800;letter-spacing:-0.5px;color:#ffffff;">DASH<span style="color:#d8ad52;">.</span></div>
                <div style="margin-top:5px;font-size:11px;font-weight:700;letter-spacing:1.8px;text-transform:uppercase;color:#9ca3af;">Beyond the Digital</div>
              </td>
            </tr>
            <tr>
              <td style="padding:34px 30px 32px;">
                ${eyebrow ? `<div style="font-size:11px;font-weight:800;letter-spacing:1.4px;text-transform:uppercase;color:#0f766e;">${eyebrow}</div>` : ''}
                ${greeting ? `<div style="margin-top:${eyebrow ? '16' : '0'}px;font-size:15px;line-height:24px;color:#4b5563;">${greeting}</div>` : ''}
                <h1 style="margin:${greeting || eyebrow ? '10' : '0'}px 0 8px;font-size:26px;line-height:34px;letter-spacing:-0.5px;color:#111827;">${title}</h1>
                ${paragraphs}
                ${code ? `<div style="margin-top:24px;background:#f8fafc;border:1px solid #e5e7eb;border-radius:16px;padding:23px 18px;text-align:center;"><div style="font-size:34px;line-height:40px;font-weight:800;letter-spacing:8px;color:#0b1220;">${code}</div></div>` : ''}
                ${details ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:24px;border-top:1px solid #edf0f3;border-bottom:1px solid #edf0f3;">${details}</table>` : ''}
                ${cta}
                ${securityNote}
              </td>
            </tr>
            <tr>
              <td style="border-top:1px solid #edf0f3;padding:20px 30px 24px;font-size:11px;line-height:18px;color:#9ca3af;">
                DASH · Beyond the Digital · A Dash World product
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}
