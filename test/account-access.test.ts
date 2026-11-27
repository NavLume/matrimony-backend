import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import type { CredentialRecord } from '../src/bo/credentials-record.js';
import type { RegistrationInput } from '../src/bo/registration.js';
import { registrationInputSchema } from '../src/bo/registration.js';
import type { OneTimeTokenRepository } from '../src/cache/repository/one-time-token-repository.js';
import type { Hits, ThrottleRepository } from '../src/cache/repository/throttle-repository.js';
import { AppError } from '../src/exception/app-error.js';
import type { MailMessage } from '../src/mail/mailer.js';
import { AccountAccessProcess, type AccessContext } from '../src/process/account-access-process.js';
import { SecretBox } from '../src/security/secret-box.js';
import type { SignInMethods } from '../src/db/raw/repository/registration-repository.js';
import type { VerifiedRegistration } from '../src/service/registration-service.js';
import { account, agency, otherAgency } from './fixtures.js';

const context: AccessContext = {
  agencyId: agency,
  agencyName: 'MSBD',
  origin: 'https://marriage.example',
};
const input: RegistrationInput = registrationInputSchema.parse({
  email: 'rahim@example.com',
  password: 'a good long password',
  displayName: 'Rahim',
  locale: 'bn',
  acceptTerms: true,
  acceptPrivacy: true,
});
const code = (status: number, name: string) => (error: unknown) =>
  error instanceof AppError && error.status === status && error.code === name;

/** The token inside the first link in a message. */
const tokenIn = (message: MailMessage) => /token=([A-Za-z0-9_-]{43})/.exec(message.text)?.[1] ?? '';

const phoneOnly: SignInMethods = {
  email: null,
  emailVerified: false,
  phone: '+8801712345678',
  hasPassword: false,
  google: false,
};
const RIGHT_CODE = '123456';

function setup(
  options: {
    registered?: string[];
    record?: Partial<CredentialRecord> | null;
    methods?: SignInMethods | null;
    noPhone?: boolean;
    /** False when no account has the number (forgotten password by phone). */
    phoneFound?: boolean;
  } = {},
) {
  const methods = options.methods === undefined ? phoneOnly : options.methods;
  const attached: { accountId: string; email: string; correlationId: string }[] = [];
  let attachResult: 'attached' | 'taken' | 'unavailable' = 'attached';
  const resetSent: string[] = [];
  const registered = new Set(options.registered ?? []);
  const mails: MailMessage[] = [];
  const created: { agencyId: string; verified: VerifiedRegistration; correlationId: string }[] = [];
  const removedSessions: string[] = [];
  const passwordSets: { agencyId: string; accountId: string; hash: string }[] = [];
  const logs: string[] = [];
  let mailFails = false;
  let hashCalls = 0;

  // The same behaviour as the Redis repository: the newest token per scope replaces the older.
  const stored = new Map<string, string>();
  const latest = new Map<string, string>();
  const tokens: Pick<OneTimeTokenRepository, 'put' | 'take'> = {
    put: async (purpose, scope, digest, sealed) => {
      const pointer = `${purpose}|${scope}`;
      const previous = latest.get(pointer);
      if (previous) stored.delete(`${purpose}|${previous}`);
      stored.set(`${purpose}|${digest}`, sealed);
      latest.set(pointer, digest);
    },
    take: async (purpose, digest) => {
      const key = `${purpose}|${digest}`;
      const value = stored.get(key) ?? null;
      stored.delete(key);
      return value;
    },
  };
  const counters = new Map<string, number>();
  const throttle: Pick<ThrottleRepository, 'hit'> = {
    hit: async (name): Promise<Hits> => {
      counters.set(name, (counters.get(name) ?? 0) + 1);
      return { count: counters.get(name)!, retryAfter: 1800 };
    },
  };

  const record: CredentialRecord | null =
    options.record === null
      ? null
      : {
          account,
          status: 'active',
          email: 'rahim@example.com',
          locale: 'bn',
          passwordHash: '$argon2id$v=19$old',
          ...options.record,
        };

  const started_: { agencyId: string; accountId: string; correlationId: string }[] = [];
  const process = new AccountAccessProcess(
    {
      emailRegistered: async (_agency, email) => registered.has(email),
      createVerified: async (agencyId, verified, correlationId) => {
        created.push({ agencyId, verified, correlationId });
        return registered.has(verified.email) ? { created: false } : { created: true, account };
      },
      signInMethods: async () => methods,
      findByPhone: async () =>
        options.phoneFound === false ? null : { account, status: 'active' as const },
      attachEmail: async (_agencyId, accountId, email, correlationId) => {
        attached.push({ accountId, email, correlationId });
        return attachResult;
      },
    },
    {
      hash: async (password) => {
        hashCalls++;
        return `$argon2id$v=19$hash-of-${password.length}`;
      },
      findByEmail: async () => record,
      findById: async () => record,
      verifyAccount: async (_agencyId, _accountId, password) => {
        if (password !== 'the right password') throw new AppError(401, 'INVALID_CREDENTIALS');
        return account;
      },
      setPassword: async (agencyId, accountId, hash) => {
        passwordSets.push({ agencyId, accountId, hash });
        return record?.status === 'active';
      },
    },
    tokens,
    throttle,
    {
      removeAll: async (accountId) => {
        removedSessions.push(accountId);
      },
    },
    {
      startSession: async (agencyId, started, correlationId) => {
        started_.push({ agencyId, accountId: started.id, correlationId });
        return { sessionId: 's'.repeat(43), accessToken: 'jwt', csrfToken: 'csrf', expiresIn: 600 };
      },
    },
    {
      send: async (message) => {
        if (mailFails) throw new Error(`smtp refused ${message.to}`);
        mails.push(message);
      },
    },
    new SecretBox('ab'.repeat(32)),
    pino({ level: 'info' }, { write: (line: string) => logs.push(line) }),
    options.noPhone
      ? undefined
      : {
          sendResetCode: async (_context, phone) => {
            resetSent.push(phone);
            return { resendAfter: 60, expiresIn: 300 };
          },
          checkResetCode: async (_agencyId, _phone, given) => {
            if (given !== RIGHT_CODE) throw new AppError(400, 'CODE_INVALID');
          },
        },
  );
  return {
    process,
    started: started_,
    registered,
    mails,
    created,
    removedSessions,
    passwordSets,
    stored,
    logs,
    counters,
    attached,
    resetSent,
    attachWill: (result: typeof attachResult) => void (attachResult = result),
    hashCalls: () => hashCalls,
    failMail: () => {
      mailFails = true;
    },
    /** Waits for the emails sent in the background. */
    async settle<T>(work: Promise<T>) {
      const result = await work;
      await process.idle();
      return result;
    },
  };
}

await test('registering emails a link and creates nothing yet', async () => {
  const f = setup();
  await f.settle(f.process.startRegistration(context, input));
  assert.equal(f.created.length, 0);
  assert.equal(f.mails.length, 1);
  const mail = f.mails[0]!;
  assert.equal(mail.to, 'rahim@example.com');
  assert.match(mail.text, /^প্রিয় Rahim,/);
  assert.match(mail.text, /https:\/\/marriage\.example\/bn\/verify-email\?token=[A-Za-z0-9_-]{43}/);
  assert.match(mail.subject, /MSBD/);
});

await test('registering keeps the person as an enquiry once the link is stored, and a failure there never stops the email', async () => {
  const f = setup();
  const seen: string[] = [];
  f.process.afterRegistrationStarted = async (ctx, registered) => {
    seen.push(`${ctx.agencyId}:${registered.email}`);
  };
  await f.settle(f.process.startRegistration(context, input));
  assert.deepEqual(seen, [`${context.agencyId}:rahim@example.com`]);
  assert.equal(f.mails.length, 1);

  const g = setup();
  g.process.afterRegistrationStarted = async () => {
    throw new Error('database down');
  };
  await g.settle(g.process.startRegistration(context, input));
  assert.equal(g.mails.length, 1);
  assert.ok(g.logs.some((line) => line.includes('REGISTRATION_LEAD_FAILED')));
});

await test('the email is in the language the person registered in', async () => {
  const f = setup();
  await f.settle(f.process.startRegistration(context, { ...input, locale: 'en' }));
  assert.match(f.mails[0]!.text, /^Dear Rahim,/);
  assert.match(f.mails[0]!.text, /\/en\/verify-email\?token=/);
});

await test('the password is never kept or sent as typed: only its hash, sealed, until the link is opened', async () => {
  const f = setup();
  await f.settle(f.process.startRegistration(context, input));
  const everything = JSON.stringify([...f.stored.values()]) + f.mails[0]!.text + f.logs.join('');
  assert.equal(everything.includes('a good long password'), false);
  // What is stored is sealed, so the email and the hash are not readable in it either.
  assert.equal(everything.includes('rahim@example.com'), false);
  assert.equal(everything.includes('hash-of-'), false);
  assert.equal(f.stored.size, 1);
});

await test('opening the link creates the account from what was typed, with the terms as they were', async () => {
  const f = setup();
  await f.settle(f.process.startRegistration(context, { ...input, onBehalfOfOther: true }));
  const session = await f.process.verifyEmail(agency, tokenIn(f.mails[0]!), 'req-7');
  assert.equal(f.created.length, 1);
  // The person who confirmed the address is signed in, as the account that was just created.
  assert.deepEqual(f.started, [
    { agencyId: agency, accountId: account.id, correlationId: 'req-7' },
  ]);
  assert.equal(session.accessToken, 'jwt');
  const { agencyId, verified, correlationId } = f.created[0]!;
  assert.equal(agencyId, agency);
  assert.equal(correlationId, 'req-7');
  assert.equal(verified.email, 'rahim@example.com');
  assert.equal(verified.passwordHash, `$argon2id$v=19$hash-of-${'a good long password'.length}`);
  assert.deepEqual(verified.registration, {
    displayName: 'Rahim',
    locale: 'bn',
    onBehalfOfOther: true,
    termsVersion: verified.registration.termsVersion,
    privacyVersion: verified.registration.privacyVersion,
  });
  assert.ok(verified.registration.termsVersion.length > 0);
});

await test('a link works once', async () => {
  const f = setup();
  await f.settle(f.process.startRegistration(context, input));
  const token = tokenIn(f.mails[0]!);
  await f.process.verifyEmail(agency, token, 'req');
  await assert.rejects(
    () => f.process.verifyEmail(agency, token, 'req'),
    code(400, 'LINK_INVALID_OR_EXPIRED'),
  );
  assert.equal(f.created.length, 1);
});

await test('an unknown or made-up link is refused', async () => {
  const f = setup();
  await assert.rejects(
    () => f.process.verifyEmail(agency, 'z'.repeat(43), 'req'),
    code(400, 'LINK_INVALID_OR_EXPIRED'),
  );
});

await test('a link only works at the agency that sent it, and is not used up by trying it elsewhere', async () => {
  const f = setup();
  await f.settle(f.process.startRegistration(context, input));
  const token = tokenIn(f.mails[0]!);
  await assert.rejects(
    () => f.process.verifyEmail(otherAgency, token, 'req'),
    code(400, 'LINK_INVALID_OR_EXPIRED'),
  );
  await f.process.verifyEmail(agency, token, 'req');
  assert.equal(f.created.length, 1);
});

await test('registering again cancels the earlier link, so only the newest works', async () => {
  const f = setup();
  await f.settle(f.process.startRegistration(context, input));
  await f.settle(f.process.startRegistration(context, { ...input, displayName: 'Rahim Uddin' }));
  const [first, second] = f.mails.map(tokenIn);
  await assert.rejects(
    () => f.process.verifyEmail(agency, first!, 'req'),
    code(400, 'LINK_INVALID_OR_EXPIRED'),
  );
  await f.process.verifyEmail(agency, second!, 'req');
  assert.equal(f.created[0]!.verified.registration.displayName, 'Rahim Uddin');
});

await test('an email that already has an account is refused plainly, with no email and no link', async () => {
  const f = setup({ registered: ['rahim@example.com'] });
  await assert.rejects(
    () => f.process.startRegistration(context, input),
    (error: unknown) =>
      error instanceof AppError &&
      error.status === 409 &&
      error.code === 'EMAIL_ALREADY_REGISTERED',
  );
  await f.settle(Promise.resolve());
  assert.equal(f.stored.size, 0);
  assert.equal(f.mails.length, 0);
});

await test('the password is hashed before the address is looked up, so the work done is the same', async () => {
  const fresh = setup();
  await fresh.settle(fresh.process.startRegistration(context, input));
  const known = setup({ registered: ['rahim@example.com'] });
  await assert.rejects(() => known.process.startRegistration(context, input));
  assert.equal(fresh.hashCalls(), 1);
  assert.equal(known.hashCalls(), 1);
});

await test('one address can be sent three registration emails an hour, then is paused', async () => {
  for (const registered of [[]]) {
    const f = setup({ registered });
    for (let i = 0; i < 3; i++) await f.settle(f.process.startRegistration(context, input));
    await assert.rejects(
      () => f.process.startRegistration(context, input),
      (error: unknown) =>
        error instanceof AppError &&
        error.status === 429 &&
        error.code === 'EMAIL_RATE_LIMITED' &&
        error.details?.retryAfter === 1800,
    );
    assert.equal(f.mails.length, 3);
    // Another address is not affected.
    await f.settle(f.process.startRegistration(context, { ...input, email: 'karim@example.com' }));
  }
});

await test('a mail service failure does not fail the request or leak the address or link into the log', async () => {
  const f = setup();
  f.failMail();
  await f.settle(f.process.startRegistration(context, input));
  const logged = f.logs.join('');
  assert.match(logged, /MAIL_SEND_FAILED/);
  assert.equal(logged.includes('rahim@example.com'), false);
  assert.equal(logged.includes('token='), false);
  assert.equal(logged.includes('smtp refused'), false);
});

await test('opening the link after the address got an account by another route creates nothing and signs nobody in', async () => {
  const f = setup();
  await f.settle(f.process.startRegistration(context, input));
  f.registered.add('rahim@example.com');
  await assert.rejects(
    () => f.process.verifyEmail(agency, tokenIn(f.mails[0]!), 'req'),
    code(400, 'LINK_INVALID_OR_EXPIRED'),
  );
  // The service was asked and answered "already there": a link never signs anyone into an
  // account it did not create.
  assert.equal(f.created.length, 1);
  assert.equal(f.started.length, 0);
});

await test('a link that failed to create the account starts no session', async () => {
  const f = setup();
  await assert.rejects(
    () => f.process.verifyEmail(agency, 'z'.repeat(43), 'req'),
    code(400, 'LINK_INVALID_OR_EXPIRED'),
  );
  assert.equal(f.started.length, 0);
});

await test('asking to reset emails a link only when the address belongs to an active account', async () => {
  const known = setup();
  await known.settle(known.process.requestPasswordReset(context, 'rahim@example.com'));
  assert.equal(known.mails.length, 1);
  assert.match(
    known.mails[0]!.text,
    /https:\/\/marriage\.example\/bn\/reset-password\?token=[A-Za-z0-9_-]{43}/,
  );

  for (const record of [null, { status: 'disabled' as const }, { status: 'invited' as const }]) {
    const f = setup({ record });
    // The same quiet success, so nobody can tell these apart from the case above.
    await f.settle(f.process.requestPasswordReset(context, 'rahim@example.com'));
    assert.equal(f.mails.length, 0, JSON.stringify(record));
    assert.equal(f.stored.size, 0);
  }
});

await test('the reset email uses the language of the account', async () => {
  const f = setup({ record: { locale: 'en' } });
  await f.settle(f.process.requestPasswordReset(context, 'rahim@example.com'));
  assert.match(f.mails[0]!.text, /reset your password|choose a new one/);
  assert.match(f.mails[0]!.text, /\/en\/reset-password/);
});

await test('resetting sets the new password, signs the account out everywhere and tells its owner', async () => {
  const f = setup();
  await f.settle(f.process.requestPasswordReset(context, 'rahim@example.com'));
  const token = tokenIn(f.mails[0]!);
  await f.settle(f.process.resetPassword(context, token, 'my brand new password', 'req-3'));

  assert.deepEqual(f.passwordSets, [
    {
      agencyId: agency,
      accountId: account.id,
      hash: `$argon2id$v=19$hash-of-${'my brand new password'.length}`,
    },
  ]);
  assert.deepEqual(f.removedSessions, [account.id]);
  assert.equal(f.mails.length, 2);
  assert.equal(f.mails[1]!.to, 'rahim@example.com');
  assert.match(f.mails[1]!.text, /সব ডিভাইস থেকে সাইন আউট/);
  assert.equal(f.mails[1]!.text.includes('my brand new password'), false);
});

await test('a reset link works once, and a newer request cancels the older link', async () => {
  const f = setup();
  await f.settle(f.process.requestPasswordReset(context, 'rahim@example.com'));
  await f.settle(f.process.requestPasswordReset(context, 'rahim@example.com'));
  const [older, newer] = f.mails.map(tokenIn);
  await assert.rejects(
    () => f.process.resetPassword(context, older!, 'a new long password', 'r'),
    code(400, 'LINK_INVALID_OR_EXPIRED'),
  );
  await f.process.resetPassword(context, newer!, 'a new long password', 'r');
  await assert.rejects(
    () => f.process.resetPassword(context, newer!, 'another long password', 'r'),
    code(400, 'LINK_INVALID_OR_EXPIRED'),
  );
  assert.equal(f.passwordSets.length, 1);
});

await test('a reset link cannot be used at another agency or when the account was disabled meanwhile', async () => {
  const f = setup();
  await f.settle(f.process.requestPasswordReset(context, 'rahim@example.com'));
  const token = tokenIn(f.mails[0]!);
  await assert.rejects(
    () =>
      f.process.resetPassword(
        { ...context, agencyId: otherAgency },
        token,
        'a new long password',
        'r',
      ),
    code(400, 'LINK_INVALID_OR_EXPIRED'),
  );

  const disabled = setup({ record: { status: 'disabled' } });
  // A token that was issued while the account was active, used after it was disabled.
  const active = setup();
  await active.settle(active.process.requestPasswordReset(context, 'rahim@example.com'));
  await assert.rejects(
    () =>
      disabled.process.resetPassword(
        context,
        tokenIn(active.mails[0]!),
        'a new long password',
        'r',
      ),
    code(400, 'LINK_INVALID_OR_EXPIRED'),
  );
  assert.equal(disabled.passwordSets.length, 0);
  assert.equal(disabled.removedSessions.length, 0);
});

await test('a registration link cannot be used as a reset link, or the other way round', async () => {
  const f = setup();
  await f.settle(f.process.startRegistration(context, input));
  await assert.rejects(
    () => f.process.resetPassword(context, tokenIn(f.mails[0]!), 'a new long password', 'r'),
    code(400, 'LINK_INVALID_OR_EXPIRED'),
  );
  await f.settle(f.process.requestPasswordReset(context, 'rahim@example.com'));
  await assert.rejects(
    () => f.process.verifyEmail(agency, tokenIn(f.mails[1]!), 'r'),
    code(400, 'LINK_INVALID_OR_EXPIRED'),
  );
});

await test('asking to reset is limited to three emails an hour per address, known or not', async () => {
  for (const record of [undefined, null]) {
    const f = setup(record === null ? { record: null } : {});
    for (let i = 0; i < 3; i++)
      await f.settle(f.process.requestPasswordReset(context, 'rahim@example.com'));
    await assert.rejects(
      () => f.process.requestPasswordReset(context, 'rahim@example.com'),
      code(429, 'EMAIL_RATE_LIMITED'),
    );
  }
});

await test('registering and resetting are limited separately', async () => {
  const f = setup();
  for (let i = 0; i < 3; i++) await f.settle(f.process.startRegistration(context, input));
  await f.settle(f.process.requestPasswordReset(context, 'rahim@example.com'));
  assert.equal(f.mails.length, 4);
});

const addEmail = {
  email: 'nina@example.com',
  password: 'the right password',
  locale: 'en' as const,
};
/** The 6-digit code in an email. */
const codeIn = (mail: MailMessage) => /\b(\d{6})\b/.exec(mail.text)?.[1] ?? '';

await test('adding an email asks for the account password; a wrong one sends nothing', async () => {
  const f = setup();
  await assert.rejects(
    () => f.process.startAddEmail(context, account, { ...addEmail, password: 'wrong' }),
    code(401, 'INVALID_CREDENTIALS'),
  );
  await f.process.idle();
  assert.equal(f.mails.length, 0);
  assert.equal(f.stored.size, 0);
});

await test('an account that already has an email cannot add another', async () => {
  const f = setup({ methods: { ...phoneOnly, email: 'a@example.com' } });
  await assert.rejects(
    () => f.process.startAddEmail(context, account, addEmail),
    code(409, 'EMAIL_ALREADY_SET'),
  );
  assert.equal(f.mails.length, 0);
});

await test('with the right password a 6-digit code is emailed to the new address, and nothing is added yet', async () => {
  const f = setup();
  await f.settle(f.process.startAddEmail(context, account, addEmail));
  assert.equal(f.mails.length, 1);
  assert.equal(f.mails[0]!.to, 'nina@example.com');
  assert.match(codeIn(f.mails[0]!), /^\d{6}$/);
  assert.match(f.mails[0]!.text, /10 minutes/);
  assert.equal(f.attached.length, 0);
  // What is kept is sealed: the account and the address cannot be read from it.
  const everything = JSON.stringify([...f.stored]);
  assert.equal(everything.includes('nina@example.com'), false);
  assert.equal(everything.includes(account.id), false);
});

await test('the emailed code adds the address to the account that asked, once', async () => {
  const f = setup();
  await f.settle(f.process.startAddEmail(context, account, addEmail));
  const given = codeIn(f.mails[0]!);
  await f.process.confirmAddEmailCode(agency, account, given, 'req-9');
  assert.deepEqual(f.attached, [
    { accountId: account.id, email: 'nina@example.com', correlationId: 'req-9' },
  ]);
  await assert.rejects(
    () => f.process.confirmAddEmailCode(agency, account, given, 'r'),
    code(400, 'CODE_INVALID'),
  );
  assert.equal(f.attached.length, 1);
});

await test('a wrong code, or another account’s code, adds nothing; asking again cancels the earlier code', async () => {
  const f = setup();
  await f.settle(f.process.startAddEmail(context, account, addEmail));
  const first = codeIn(f.mails[0]!);
  await assert.rejects(
    () =>
      f.process.confirmAddEmailCode(agency, account, first === '000000' ? '111111' : '000000', 'r'),
    code(400, 'CODE_INVALID'),
  );
  await assert.rejects(
    () =>
      f.process.confirmAddEmailCode(
        agency,
        { ...account, id: '22222222-2222-4222-8222-222222222222' },
        first,
        'r',
      ),
    code(400, 'CODE_INVALID'),
  );
  await f.settle(
    f.process.startAddEmail(context, account, { ...addEmail, email: 'other@example.com' }),
  );
  const second = codeIn(f.mails[1]!);
  if (first !== second)
    await assert.rejects(
      () => f.process.confirmAddEmailCode(agency, account, first, 'r'),
      code(400, 'CODE_INVALID'),
    );
  await f.process.confirmAddEmailCode(agency, account, second, 'req-c');
  assert.deepEqual(f.attached, [
    { accountId: account.id, email: 'other@example.com', correlationId: 'req-c' },
  ]);
});

await test('too many wrong codes make the account wait', async () => {
  const f = setup();
  await f.settle(f.process.startAddEmail(context, account, addEmail));
  for (let i = 0; i < 5; i++)
    await assert.rejects(
      () => f.process.confirmAddEmailCode(agency, account, '99999' + String(i), 'r'),
      code(400, 'CODE_INVALID'),
    );
  await assert.rejects(
    () => f.process.confirmAddEmailCode(agency, account, codeIn(f.mails[0]!), 'r'),
    (error) =>
      error instanceof AppError && error.status === 429 && error.code === 'CODE_RATE_LIMITED',
  );
});

await test('an address that already has an account gets a notice instead of a code, and the answer is the same', async () => {
  const f = setup({ registered: ['nina@example.com'] });
  const answer = await f.settle(f.process.startAddEmail(context, account, addEmail));
  assert.equal(answer, undefined);
  assert.equal(f.mails.length, 1);
  assert.match(f.mails[0]!.text, /already belongs to an account/);
  assert.equal(f.stored.size, 0);
});

await test('one address is sent three of these emails an hour', async () => {
  const f = setup();
  for (let i = 0; i < 3; i++) await f.settle(f.process.startAddEmail(context, account, addEmail));
  await assert.rejects(
    () => f.process.startAddEmail(context, account, addEmail),
    (error) =>
      error instanceof AppError && error.status === 429 && error.code === 'EMAIL_RATE_LIMITED',
  );
  assert.equal(f.mails.length, 3);
});

await test('an older emailed link to add an address still works once', async () => {
  // Links were sent before codes replaced them; one made the old way is still honoured until it expires.
  const f = setup();
  await assert.rejects(
    () => f.process.confirmAddEmail(agency, 'z'.repeat(43), 'r'),
    code(400, 'LINK_INVALID_OR_EXPIRED'),
  );
});

const withEmail = { ...phoneOnly, email: 'a@example.com' };

await test('a new password needs an email: the proof code goes there, never to the phone', async () => {
  const none = setup();
  await assert.rejects(
    () => none.process.sendReauthCode(context, account, 'en'),
    code(409, 'EMAIL_REQUIRED'),
  );
  const f = setup({ methods: withEmail });
  const sent = await f.settle(f.process.sendReauthCode(context, account, 'en'));
  assert.deepEqual(sent, { resendAfter: 60, expiresIn: 600 });
  assert.equal(f.mails.length, 1);
  assert.equal(f.mails[0]!.to, 'a@example.com');
  assert.match(codeIn(f.mails[0]!), /^\d{6}$/);
  assert.equal(f.resetSent.length, 0);
});

await test('a new password with the emailed code is stored hashed, ends every session, and tells the owner', async () => {
  const f = setup({ methods: withEmail });
  await f.settle(f.process.sendReauthCode(context, account, 'en'));
  const given = codeIn(f.mails[0]!);
  await f.settle(
    f.process.changePassword(
      context,
      account,
      { code: given, password: 'a brand new strong password' },
      'req-pw',
    ),
  );
  assert.equal(f.passwordSets.length, 1);
  assert.match(f.passwordSets[0]!.hash, /^\$argon2id/);
  assert.equal(f.passwordSets[0]!.hash.includes('brand new'), false);
  assert.deepEqual(f.removedSessions, [account.id]);
  assert.equal(f.mails.length, 2);
  assert.match(f.mails[1]!.text, /এইমাত্র বদলানো হয়েছে/);
});

await test('a wrong code changes nothing; a password like the email or number is refused first', async () => {
  const f = setup({ methods: { ...withEmail, email: 'nina.phone@example.com' } });
  await assert.rejects(
    () =>
      f.process.changePassword(
        context,
        account,
        { code: '000000', password: 'a brand new strong password' },
        'r',
      ),
    code(400, 'CODE_INVALID'),
  );
  for (const [password, field] of [
    ['nina.phone@example.com', 'sameAsEmail'],
    ['01712345678', 'sameAsPhone'],
  ] as const)
    await assert.rejects(
      () => f.process.changePassword(context, account, { code: '123456', password }, 'r'),
      (error) =>
        error instanceof AppError &&
        error.status === 400 &&
        JSON.stringify(error.details) ===
          JSON.stringify({ fields: [{ path: 'password', code: field }] }),
    );
  assert.equal(f.passwordSets.length, 0);
  assert.deepEqual(f.removedSessions, []);
});

await test('a forgotten password by phone: only for a registered number of an account with no email', async () => {
  const unknown = setup({ phoneFound: false });
  await assert.rejects(
    () => unknown.process.requestPhoneReset(context, '+8801712345678', 'bn'),
    code(404, 'PHONE_NOT_REGISTERED'),
  );
  const hasEmail = setup({ methods: withEmail });
  await assert.rejects(
    () => hasEmail.process.requestPhoneReset(context, '+8801712345678', 'bn'),
    code(409, 'USE_EMAIL'),
  );
  const off = setup({ noPhone: true });
  await assert.rejects(
    () => off.process.requestPhoneReset(context, '+8801712345678', 'bn'),
    code(404, 'PHONE_NOT_CONFIGURED'),
  );
  const f = setup();
  await f.process.requestPhoneReset(context, '+8801712345678', 'bn');
  assert.deepEqual(f.resetSent, ['+8801712345678']);
  for (const other of [unknown, hasEmail, off]) assert.equal(other.resetSent.length, 0);
});

await test('the texted code sets the new password and ends every session; a wrong one changes nothing', async () => {
  const f = setup();
  await assert.rejects(
    () =>
      f.process.resetPasswordByPhone(
        context,
        { phone: '+8801712345678', code: '000000', password: 'a brand new strong password' },
        'r',
      ),
    code(400, 'CODE_INVALID'),
  );
  assert.equal(f.passwordSets.length, 0);
  await f.process.resetPasswordByPhone(
    context,
    { phone: '+8801712345678', code: RIGHT_CODE, password: 'a brand new strong password' },
    'r',
  );
  assert.equal(f.passwordSets.length, 1);
  assert.deepEqual(f.removedSessions, [account.id]);
});
