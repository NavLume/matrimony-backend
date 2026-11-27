import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderEmail } from '../src/mail/email-layout.js';
import {
  addEmailEmail,
  clientLoginEmail,
  emailCodeEmail,
  emailInUseNotice,
  guardianInviteEmail,
  passwordChangedEmail,
  passwordResetEmail,
  staffInvitationEmail,
  verificationEmail,
} from '../src/mail/messages.js';

const LINK = 'https://msbd.example/bn/verify-email?token=abc_DEF-123';

await test('every account email has an HTML part in the agency name, with its link visible under the button', () => {
  const base = { to: 'a@example.com', agencyName: 'Marriage Solution BD' };
  for (const locale of ['bn', 'en'] as const) {
    const messages = [
      verificationEmail({ ...base, locale, name: 'Sadia', link: LINK }),
      addEmailEmail({ ...base, locale, link: LINK }),
      emailInUseNotice({ ...base, locale, signInLink: LINK }),
      passwordResetEmail({ ...base, locale, link: LINK }),
      passwordChangedEmail({ ...base, locale, resetLink: LINK }),
      staffInvitationEmail({
        ...base,
        locale,
        name: 'N',
        role: 'agent',
        invitedBy: 'A',
        link: LINK,
      }),
      clientLoginEmail({ ...base, locale, name: 'N', link: LINK }),
      guardianInviteEmail({ ...base, locale, name: 'N', clientName: 'C', link: LINK }),
    ];
    for (const message of messages) {
      assert.ok(message.html, message.subject);
      assert.match(message.html, /Marriage Solution BD/);
      assert.match(message.html, new RegExp(`<html lang="${locale}"`));
      // Once in the button and once as the visible link text and its href.
      assert.equal(message.html.split(LINK).length - 1, 3, message.subject);
      // The plain-text part is still there and still carries the link.
      assert.ok(message.text.includes(LINK));
    }
  }
});

await test('a code email shows the code large and has no button', () => {
  const message = emailCodeEmail({
    to: 'a@example.com',
    locale: 'en',
    agencyName: 'MSBD',
    code: '042917',
    purpose: 'password',
  });
  assert.match(message.html!, /class="code"[^>]*>042917</);
  assert.doesNotMatch(message.html!, /class="btn"/);
});

await test('names and words are escaped, and only a web address is ever put in a link', () => {
  const html = renderEmail(
    { name: 'A&B <script>', primaryColor: 'red; background:url(x)' },
    {
      locale: 'en',
      preheader: 'p',
      heading: '<b>hi</b>',
      greeting: 'Dear "x" <img src=x onerror=alert(1)>,',
      paragraphs: ['ok'],
      action: { label: 'Go', url: 'javascript:alert(1)' },
      footer: 'f',
    },
  );
  assert.doesNotMatch(html, /<script>|<img src=x|<b>hi<\/b>|javascript:/);
  assert.match(html, /A&amp;B &lt;script&gt;/);
  // No button for an address that is not http(s), and an invalid colour falls back to the default.
  assert.doesNotMatch(html, /class="btn"/);
  assert.match(html, /#881f38/);
});

await test('the text on the brand colour is white or near-black, whichever reads better', () => {
  const dark = renderEmail(
    { name: 'X', primaryColor: '#1a237e' },
    {
      locale: 'en',
      preheader: '',
      heading: 'h',
      paragraphs: [],
      action: { label: 'Go', url: LINK },
      footer: '',
    },
  );
  const light = renderEmail(
    { name: 'X', primaryColor: '#f5e663' },
    {
      locale: 'en',
      preheader: '',
      heading: 'h',
      paragraphs: [],
      action: { label: 'Go', url: LINK },
      footer: '',
    },
  );
  assert.match(dark, /color:#ffffff;vertical-align/);
  assert.match(light, /color:#111111;vertical-align/);
});
