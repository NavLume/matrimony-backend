import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codeMessage } from '../src/sms/messages.js';
import { ConsoleSmsSender } from '../src/sms/sender.js';

await test('the code text follows the gateway OTP form with the agency name, the same in either language', () => {
  const en = codeMessage({
    to: '+8801712345678',
    locale: 'en',
    agencyName: 'MSBD',
    code: '042917',
  });
  assert.equal(en.to, '+8801712345678');
  assert.equal(en.text, 'Your MSBD OTP Code is 042917. Valid for 5 minutes. Do not share it.');
  const bn = codeMessage({
    to: '+8801712345678',
    locale: 'bn',
    agencyName: 'MSBD',
    code: '042917',
  });
  assert.equal(bn.text, en.text);
});

await test('a text stays short: one SMS in English, and no link in either language', () => {
  const en = codeMessage({
    to: '+8801712345678',
    locale: 'en',
    agencyName: 'Marriage Solution BD',
    code: '123456',
  });
  assert.ok(en.text.length <= 160, `${en.text.length} characters`);
  for (const locale of ['en', 'bn'] as const)
    assert.equal(
      /https?:|www\./i.test(
        codeMessage({ to: '+8801712345678', locale, agencyName: 'MSBD', code: '123456' }).text,
      ),
      false,
    );
});

await test('the development sender prints the text, with the number, in the terminal', async () => {
  const written: string[] = [];
  await new ConsoleSmsSender((text) => written.push(text)).send({
    to: '+8801712345678',
    text: 'MSBD: your code is 123456.',
  });
  assert.equal(written.length, 1);
  assert.match(written[0]!, /\[dev sms\] to=\+8801712345678/);
  assert.match(written[0]!, /\[dev sms\] MSBD: your code is 123456\./);
});
