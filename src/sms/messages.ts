import type { SmsMessage } from './sender.js';

/**
 * The text message that carries a one-time code. The minutes are written
 * here and must match the lifetime in PhoneAuthProcess. Short on purpose: a long message costs
 * more, and Bengali text is split into more parts than English.
 */
export function codeMessage(context: {
  to: string;
  locale: 'bn' | 'en';
  agencyName: string;
  code: string;
}): SmsMessage {
  const { to, locale, agencyName, code } = context;
  // The gateway (sms.net.bd) asks for this exact OTP form, with the brand name in it: "Your <Brand> OTP Code is 123456".
  // English in both languages (plain letters also fit 160 characters in one part, so a code costs one message).
  void locale;
  return {
    to,
    text: `Your ${agencyName} OTP Code is ${code}. Valid for 5 minutes. Do not share it.`,
  };
}

/** The text that carries a client's login link. Short on purpose. The days match CLIENT_LOGIN_DAYS. */
export function clientLoginMessage(context: {
  to: string;
  locale: 'bn' | 'en';
  agencyName: string;
  link: string;
}): SmsMessage {
  const { to, locale, agencyName, link } = context;
  return {
    to,
    text:
      locale === 'bn'
        ? `${agencyName}: আপনার লগইন চালু করতে পাসওয়ার্ড ঠিক করুন: ${link} (৭ দিন, একবার)`
        : `${agencyName}: open this link to choose your password and log in: ${link} (7 days, once)`,
  };
}
