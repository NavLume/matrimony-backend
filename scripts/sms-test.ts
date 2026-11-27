// Sends ONE test text message through sms.net.bd and prints the balance before and after. For checking the gateway
// after its key is set; never prints the key.
//
//   npx tsx --env-file=.env scripts/sms-test.ts 01712345678
//   (on the server: docker compose run --rm tools npx tsx scripts/sms-test.ts 01712345678)
//
// Reads SMSNETBD_API_KEY (and SMSNETBD_SENDER_ID if set) from the environment.
import { normalizePhone } from '../src/bo/phone-number.js';
import { SmsNetBdSender } from '../src/sms/sms-net-bd-sender.js';

const key = process.env.SMSNETBD_API_KEY;
const typed = process.argv[2];
if (!key) {
  console.error('SMSNETBD_API_KEY is not set.');
  process.exit(1);
}
const to = typed ? normalizePhone(typed) : null;
if (!to || !to.startsWith('+880')) {
  console.error('Give a Bangladeshi mobile number, for example 01712345678.');
  process.exit(1);
}

async function balance(): Promise<string> {
  const url = new URL('https://api.sms.net.bd/user/balance/');
  url.searchParams.set('api_key', key!);
  const answer = (await (await fetch(url, { signal: AbortSignal.timeout(10000) })).json()) as {
    error?: unknown;
    msg?: string;
    data?: { balance?: string };
  };
  return Number(answer.error) === 0
    ? String(answer.data?.balance)
    : `error ${String(answer.error)} (${answer.msg ?? ''})`;
}

console.log('Balance before:', await balance());
const sender = new SmsNetBdSender(key, 10000, process.env.SMSNETBD_SENDER_ID);
try {
  await sender.send({
    to,
    text: 'Your Marriage Solution BD OTP Code is 123456. Valid for 5 minutes. Do not share it.',
  });
  console.log('Sent to', `${to.slice(0, 7)}****${to.slice(-3)}`, '— check the phone.');
} catch (error) {
  console.error('Not sent:', error instanceof Error ? error.message : 'unknown error');
  process.exitCode = 1;
}
console.log('Balance after:', await balance());
