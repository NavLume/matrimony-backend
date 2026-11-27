/**
 * One HTML frame for every account email (confirm email, codes, password reset, invitations).
 *
 * Built for mail apps, not browsers: tables and inline styles only, system fonts, no images unless
 * the agency supplies a logo, and no scripts. The colours are the website's tokens as fixed hex
 * values; only the brand colour changes per agency. Dark mode is handled where the mail app
 * supports it (Apple Mail, iOS Mail, Outlook.com); Gmail keeps the light version.
 *
 * The link is always shown as visible text under the button, so the words on the button can never
 * hide a different address, and every message still carries its plain-text part.
 */
export type EmailLocale = 'bn' | 'en';

export interface EmailBrand {
  /** The agency's name, shown in the header band and the footer. */
  name: string;
  /** `#RRGGBB` from the agency's branding. Anything else falls back to the default maroon. */
  primaryColor?: string;
  /** Optional https address of a PNG or JPEG logo (not WebP or SVG: Outlook shows neither). */
  logoUrl?: string;
}

export interface EmailContent {
  locale: EmailLocale;
  /** The line a mail app shows beside the subject. Hidden in the message itself. */
  preheader: string;
  heading: string;
  greeting?: string;
  paragraphs: string[];
  /** A one-time code shown large, for the messages that carry one instead of a link. */
  code?: string;
  /** The one thing the reader should do. The address must start with https:// (or http:// in development). */
  action?: { label: string; url: string };
  /** Shown above the visible link under the button. */
  linkHint?: string;
  /** Small print under the link: how long it works, what to do if it was not asked for. */
  notes?: string[];
  footer: string;
}

const DEFAULT_PRIMARY = '#881f38';
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/* The website's light tokens (globals.css) as hex, and the dark ones used in the media query. */
const LIGHT = {
  page: '#fdfaf5',
  card: '#ffffff',
  ink: '#251616',
  mute: '#665754',
  line: '#e6ded8',
  gold: '#d99e46',
};
const DARK = {
  page: '#171009',
  card: '#211a12',
  ink: '#efece6',
  mute: '#b5b0a8',
  line: '#3a3128',
  gold: '#e8b45e',
};

const SANS =
  "'Noto Sans Bengali','Hind Siliguri',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const SERIF = "'Playfair Display',Georgia,'Times New Roman',serif";
const MONO = "'SFMono-Regular',Menlo,Consolas,'Liberation Mono',monospace";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Only web addresses are ever written into an href. */
function safeUrl(url: string): string | null {
  return /^https?:\/\/[^\s<>"']+$/.test(url) ? url : null;
}

/** WCAG relative luminance of a `#RRGGBB` colour (the same rule the website uses). */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((start) => {
    const channel = parseInt(hex.slice(start, start + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** White or near-black, whichever reads better on the brand colour. */
function readableOn(hex: string): string {
  const background = luminance(hex) + 0.05;
  return 1.05 / background >= background / 0.0556 ? '#ffffff' : '#111111';
}

export function renderEmail(brand: EmailBrand, content: EmailContent): string {
  const primary =
    brand.primaryColor && HEX_COLOR.test(brand.primaryColor) ? brand.primaryColor : DEFAULT_PRIMARY;
  const onPrimary = readableOn(primary);
  const bengali = content.locale === 'bn';
  // Bengali glyphs have tall marks: more line height, no serif, never letter-spaced.
  const leading = bengali ? '1.75' : '1.6';
  const headingFont = bengali ? SANS : SERIF;
  const name = escapeHtml(brand.name);
  const logo = brand.logoUrl ? safeUrl(brand.logoUrl) : null;
  const actionUrl = content.action ? safeUrl(content.action.url) : null;

  const paragraph = (text: string) =>
    `<p class="ink" style="margin:0 0 14px;font-family:${SANS};font-size:16px;line-height:${leading};color:${LIGHT.ink};">${escapeHtml(text)}</p>`;
  const note = (text: string) =>
    `<p class="mute" style="margin:0 0 6px;font-family:${SANS};font-size:13px;line-height:${leading};color:${LIGHT.mute};">${escapeHtml(text)}</p>`;

  const code = content.code
    ? `<p style="margin:18px 0 20px;"><span class="code" style="display:inline-block;padding:12px 22px;border:1px solid ${LIGHT.line};border-radius:12px;background:${LIGHT.page};font-family:${MONO};font-size:30px;font-weight:bold;letter-spacing:6px;line-height:1.2;color:${LIGHT.ink};">${escapeHtml(content.code)}</span></p>`
    : '';

  const button =
    content.action && actionUrl
      ? `<table role="presentation" class="btn" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 18px;">
          <tr><td align="center" bgcolor="${primary}" style="background:${primary};border-radius:999px;">
            <a href="${escapeHtml(actionUrl)}" target="_blank" rel="noopener" style="display:inline-block;padding:14px 32px;font-family:${SANS};font-size:16px;font-weight:bold;line-height:1.25;color:${onPrimary};text-decoration:none;border-radius:999px;">${escapeHtml(content.action.label)}</a>
          </td></tr>
        </table>
        <p class="mute" style="margin:0 0 4px;font-family:${SANS};font-size:13px;line-height:${leading};color:${LIGHT.mute};">${escapeHtml(content.linkHint ?? '')}</p>
        <p style="margin:0 0 18px;font-family:${SANS};font-size:13px;line-height:1.5;word-break:break-all;"><a class="link" href="${escapeHtml(actionUrl)}" target="_blank" rel="noopener" style="color:${primary};text-decoration:underline;">${escapeHtml(actionUrl)}</a></p>`
      : '';

  return `<!DOCTYPE html>
<html lang="${content.locale}" dir="ltr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(content.heading)}</title>
<style>
  @media (prefers-color-scheme: dark) {
    .page { background: ${DARK.page} !important; }
    .card { background: ${DARK.card} !important; border-color: ${DARK.line} !important; }
    .ink { color: ${DARK.ink} !important; }
    .mute { color: ${DARK.mute} !important; }
    .link { color: ${DARK.ink} !important; }
    .rule { border-color: ${DARK.gold} !important; }
    .gem { color: ${DARK.gold} !important; }
    .code { background: ${DARK.page} !important; border-color: ${DARK.line} !important; color: ${DARK.ink} !important; }
  }
  @media (max-width: 520px) {
    .outer { padding: 16px 10px !important; }
    .band { padding: 18px 20px !important; }
    .pad { padding: 24px 20px 20px !important; }
    .btn { width: 100% !important; }
    .btn a { display: block !important; padding-left: 12px !important; padding-right: 12px !important; }
  }
</style>
</head>
<body class="page" style="margin:0;padding:0;background:${LIGHT.page};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:${LIGHT.page};">${escapeHtml(content.preheader)}</div>
<table role="presentation" class="page" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${LIGHT.page};">
  <tr><td class="outer" align="center" style="padding:32px 12px;">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;">
      <tr><td class="band" bgcolor="${primary}" style="background:${primary};border-radius:16px 16px 0 0;padding:22px 32px;">
        ${logo ? `<img src="${escapeHtml(logo)}" alt="" height="32" style="height:32px;width:auto;border:0;vertical-align:middle;margin-right:10px;">` : ''}<span style="font-family:${headingFont};font-size:19px;font-weight:bold;line-height:1.3;color:${onPrimary};vertical-align:middle;">${name}</span>
      </td></tr>
      <tr><td class="card pad" bgcolor="${LIGHT.card}" style="background:${LIGHT.card};border:1px solid ${LIGHT.line};border-top:0;border-radius:0 0 16px 16px;padding:30px 32px 24px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" aria-hidden="true"><tr>
          <td width="30" valign="middle"><div class="rule" style="border-top:1px solid ${LIGHT.gold};font-size:0;line-height:0;">&nbsp;</div></td>
          <td class="gem" valign="middle" style="padding:0 8px;font-size:9px;line-height:9px;color:${LIGHT.gold};">&#9670;</td>
          <td width="30" valign="middle"><div class="rule" style="border-top:1px solid ${LIGHT.gold};font-size:0;line-height:0;">&nbsp;</div></td>
        </tr></table>
        <h1 class="ink" style="margin:14px 0 14px;font-family:${headingFont};font-size:26px;font-weight:bold;line-height:1.3;color:${LIGHT.ink};">${escapeHtml(content.heading)}</h1>
        ${content.greeting ? paragraph(content.greeting) : ''}
        ${content.paragraphs.map(paragraph).join('\n        ')}
        ${code}
        ${button}
        ${(content.notes ?? []).map(note).join('\n        ')}
      </td></tr>
      <tr><td align="center" style="padding:18px 24px 0;">
        <p class="mute" style="margin:0;font-family:${SANS};font-size:12px;line-height:${leading};color:${LIGHT.mute};">${escapeHtml(content.footer)}</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}
