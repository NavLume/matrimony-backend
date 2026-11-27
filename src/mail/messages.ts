import { renderEmail, type EmailContent } from './email-layout.js';
import type { MailMessage } from './mailer.js';

/**
 * The emails the sign-in flows send, in Bengali and English. Every message has a plain-text part
 * (it reads the same in every mail app) and an HTML part drawn in the website's look by
 * email-layout.ts, which always shows the link as visible text under its button, so the words on
 * a button can never hide a different address. Hours of validity are written here and must match
 * the lifetimes in AccountAccessProcess.
 */
export type MailLocale = 'bn' | 'en';

interface Context {
  to: string;
  locale: MailLocale;
  agencyName: string;
}

const LINK_HINT: Record<MailLocale, string> = {
  bn: 'বোতামটি কাজ না করলে এই লিংকটি আপনার ব্রাউজারে কপি করুন:',
  en: 'If the button does not work, copy this link into your browser:',
};

const standardFooter = (locale: MailLocale, agency: string) =>
  locale === 'bn'
    ? `${agency} এই স্বয়ংক্রিয় বার্তাটি পাঠিয়েছে। অনুগ্রহ করে এর উত্তর দেবেন না।`
    : `${agency} sent this automatic message. Please do not reply.`;

type Frame = Omit<EmailContent, 'locale' | 'linkHint' | 'footer'> & { footer?: string };

/** The HTML part, in the agency's name, with the shared link hint and footer. */
function html(locale: MailLocale, agencyName: string, frame: Frame): string {
  const { footer, ...content } = frame;
  return renderEmail(
    { name: agencyName },
    {
      ...content,
      locale,
      linkHint: LINK_HINT[locale],
      footer: footer ?? standardFooter(locale, agencyName),
    },
  );
}

export function verificationEmail(context: Context & { name: string; link: string }): MailMessage {
  const { to, locale, agencyName, name, link } = context;
  return locale === 'bn'
    ? {
        to,
        subject: `${agencyName}: আপনার ইমেইল নিশ্চিত করুন`,
        text: [
          `প্রিয় ${name},`,
          '',
          `${agencyName}-এ আপনার অ্যাকাউন্ট তৈরি করতে নিচের লিংকটি খুলুন। লিংকটি ২৪ ঘণ্টা পর্যন্ত কাজ করবে।`,
          '',
          link,
          '',
          'আপনি এটির অনুরোধ না করে থাকলে এই ইমেইলটি উপেক্ষা করুন। কোনো অ্যাকাউন্ট তৈরি হবে না।',
        ].join('\n'),
        html: html(locale, agencyName, {
          preheader: 'আপনার অ্যাকাউন্ট তৈরি শেষ করতে লিংকটি খুলুন। লিংকটি ২৪ ঘণ্টা কাজ করবে।',
          heading: 'আপনার ইমেইল নিশ্চিত করুন',
          greeting: `প্রিয় ${name},`,
          paragraphs: [
            `${agencyName}-এ আপনার অ্যাকাউন্ট তৈরি করতে আর একটি ধাপ বাকি: এই ইমেইল ঠিকানাটি যে আপনার, তা নিশ্চিত করুন।`,
          ],
          action: { label: 'ইমেইল নিশ্চিত করুন', url: link },
          notes: [
            'লিংকটি ২৪ ঘণ্টা পর্যন্ত কাজ করবে।',
            'আপনি এটির অনুরোধ না করে থাকলে এই ইমেইলটি উপেক্ষা করুন। কোনো অ্যাকাউন্ট তৈরি হবে না।',
          ],
          footer: `এই ঠিকানা দিয়ে নিবন্ধনের অনুরোধ করা হয়েছে বলে ${agencyName} এই স্বয়ংক্রিয় বার্তাটি পাঠিয়েছে। অনুগ্রহ করে এর উত্তর দেবেন না।`,
        }),
      }
    : {
        to,
        subject: `${agencyName}: confirm your email`,
        text: [
          `Dear ${name},`,
          '',
          `Open the link below to create your account at ${agencyName}. It works for 24 hours.`,
          '',
          link,
          '',
          'If you did not ask for this, ignore this email. No account will be created.',
        ].join('\n'),
        html: html(locale, agencyName, {
          preheader: 'Open the link to finish creating your account. It works for 24 hours.',
          heading: 'Confirm your email',
          greeting: `Dear ${name},`,
          paragraphs: [
            `One more step to create your account at ${agencyName}: confirm that this email address is yours.`,
          ],
          action: { label: 'Confirm my email', url: link },
          notes: [
            'The link works for 24 hours.',
            'If you did not ask for this, ignore this email. No account will be created.',
          ],
          footer: `${agencyName} sent this automatic message because this address was used to register. Please do not reply.`,
        }),
      };
}

/** The link that adds this address to the account that asked, sent to the address itself. */
export function addEmailEmail(context: Context & { link: string }): MailMessage {
  const { to, locale, agencyName, link } = context;
  return locale === 'bn'
    ? {
        to,
        subject: `${agencyName}: আপনার ইমেইল যোগ করুন`,
        text: [
          'প্রিয় ব্যবহারকারী,',
          '',
          `${agencyName}-এ আপনার অ্যাকাউন্টে এই ইমেইলটি যোগ করার অনুরোধ পেয়েছি। যোগ করতে নিচের লিংকটি খুলুন। লিংকটি ১ ঘণ্টা কাজ করবে এবং একবারই ব্যবহার করা যাবে।`,
          '',
          link,
          '',
          'আপনি অনুরোধ না করে থাকলে এই ইমেইলটি উপেক্ষা করুন। কোনো ইমেইল যোগ হবে না।',
        ].join('\n'),
        html: html(locale, agencyName, {
          preheader: 'আপনার অ্যাকাউন্টে এই ইমেইল যোগ করতে লিংকটি খুলুন।',
          heading: 'আপনার ইমেইল যোগ করুন',
          greeting: 'প্রিয় ব্যবহারকারী,',
          paragraphs: [`${agencyName}-এ আপনার অ্যাকাউন্টে এই ইমেইলটি যোগ করার অনুরোধ পেয়েছি।`],
          action: { label: 'ইমেইল যোগ করুন', url: link },
          notes: [
            'লিংকটি ১ ঘণ্টা কাজ করবে এবং একবারই ব্যবহার করা যাবে।',
            'আপনি অনুরোধ না করে থাকলে এই ইমেইলটি উপেক্ষা করুন। কোনো ইমেইল যোগ হবে না।',
          ],
        }),
      }
    : {
        to,
        subject: `${agencyName}: add your email`,
        text: [
          'Hello,',
          '',
          `We received a request to add this email to an account at ${agencyName}. Open the link below to add it. It works for 1 hour and only once.`,
          '',
          link,
          '',
          'If you did not ask for this, ignore this email. Nothing will be added.',
        ].join('\n'),
        html: html(locale, agencyName, {
          preheader: 'Open the link to add this email to your account.',
          heading: 'Add your email',
          greeting: 'Hello,',
          paragraphs: [`We received a request to add this email to an account at ${agencyName}.`],
          action: { label: 'Add this email', url: link },
          notes: [
            'The link works for 1 hour and only once.',
            'If you did not ask for this, ignore this email. Nothing will be added.',
          ],
        }),
      };
}

/**
 * A 6-digit code by email, used instead of a text message (owner decision, 27 Nov 2026): to add this address to an
 * account, or to choose a new password. The minutes match EMAIL_CODE_SECONDS in AccountAccessProcess.
 */
export function emailCodeEmail(
  context: Context & { code: string; purpose: 'add_email' | 'password' | 'consultation' },
): MailMessage {
  const { to, locale, agencyName, code, purpose } = context;
  if (locale === 'bn') {
    const what =
      purpose === 'add_email'
        ? 'আপনার অ্যাকাউন্টে এই ইমেইল যোগ করতে'
        : purpose === 'consultation'
          ? 'পরামর্শের অনুরোধ নিশ্চিত করতে'
          : 'আপনার অ্যাকাউন্টের নতুন পাসওয়ার্ড ঠিক করতে';
    return {
      to,
      subject: `${agencyName}: আপনার কোড ${code}`,
      text: [
        'প্রিয় ব্যবহারকারী,',
        '',
        `${agencyName}-এ ${what} এই কোডটি লিখুন:`,
        '',
        code,
        '',
        'কোডটি ১০ মিনিট কাজ করবে। কাউকে বলবেন না।',
        'আপনি অনুরোধ না করে থাকলে এই ইমেইলটি উপেক্ষা করুন। কিছুই বদলাবে না।',
      ].join('\n'),
      html: html(locale, agencyName, {
        preheader: 'কোডটি ১০ মিনিট কাজ করবে। কাউকে বলবেন না।',
        heading: 'আপনার কোড',
        greeting: 'প্রিয় ব্যবহারকারী,',
        paragraphs: [`${agencyName}-এ ${what} এই কোডটি লিখুন:`],
        code,
        notes: [
          'কোডটি ১০ মিনিট কাজ করবে। কাউকে বলবেন না।',
          'আপনি অনুরোধ না করে থাকলে এই ইমেইলটি উপেক্ষা করুন। কিছুই বদলাবে না।',
        ],
      }),
    };
  }
  const what =
    purpose === 'add_email'
      ? 'add this email to your account'
      : purpose === 'consultation'
        ? 'confirm your consultation request'
        : 'choose a new password for your account';
  return {
    to,
    subject: `${agencyName}: your code ${code}`,
    text: [
      'Hello,',
      '',
      `To ${what} at ${agencyName}, enter this code:`,
      '',
      code,
      '',
      'It works for 10 minutes. Do not share it.',
      'If you did not ask for this, ignore this email. Nothing will change.',
    ].join('\n'),
    html: html(locale, agencyName, {
      preheader: 'It works for 10 minutes. Do not share it.',
      heading: 'Your code',
      greeting: 'Hello,',
      paragraphs: [`To ${what} at ${agencyName}, enter this code:`],
      code,
      notes: [
        'It works for 10 minutes. Do not share it.',
        'If you did not ask for this, ignore this email. Nothing will change.',
      ],
    }),
  };
}

/** Sent instead of the link when the address already belongs to an account. */
export function emailInUseNotice(context: Context & { signInLink: string }): MailMessage {
  const { to, locale, agencyName, signInLink } = context;
  return locale === 'bn'
    ? {
        to,
        subject: `${agencyName}: এই ইমেইল আগে থেকেই ব্যবহার হচ্ছে`,
        text: [
          'প্রিয় ব্যবহারকারী,',
          '',
          `কেউ ${agencyName}-এ অন্য একটি অ্যাকাউন্টে এই ইমেইল যোগ করার চেষ্টা করেছে, কিন্তু এই ইমেইলে আগে থেকেই একটি অ্যাকাউন্ট আছে।`,
          '',
          `সাইন ইন করতে: ${signInLink}`,
          '',
          'আপনি না করে থাকলে কিছু করতে হবে না।',
        ].join('\n'),
        html: html(locale, agencyName, {
          preheader: 'এই ইমেইলে আগে থেকেই একটি অ্যাকাউন্ট আছে।',
          heading: 'এই ইমেইল আগে থেকেই ব্যবহার হচ্ছে',
          greeting: 'প্রিয় ব্যবহারকারী,',
          paragraphs: [
            `কেউ ${agencyName}-এ অন্য একটি অ্যাকাউন্টে এই ইমেইল যোগ করার চেষ্টা করেছে, কিন্তু এই ইমেইলে আগে থেকেই একটি অ্যাকাউন্ট আছে।`,
          ],
          action: { label: 'সাইন ইন করুন', url: signInLink },
          notes: ['আপনি না করে থাকলে কিছু করতে হবে না।'],
        }),
      }
    : {
        to,
        subject: `${agencyName}: this email is already in use`,
        text: [
          'Hello,',
          '',
          `Someone tried to add this email to another account at ${agencyName}, but it already belongs to an account.`,
          '',
          `To sign in: ${signInLink}`,
          '',
          'If it was not you, you do not need to do anything.',
        ].join('\n'),
        html: html(locale, agencyName, {
          preheader: 'This email already belongs to an account.',
          heading: 'This email is already in use',
          greeting: 'Hello,',
          paragraphs: [
            `Someone tried to add this email to another account at ${agencyName}, but it already belongs to an account.`,
          ],
          action: { label: 'Sign in', url: signInLink },
          notes: ['If it was not you, you do not need to do anything.'],
        }),
      };
}

export function passwordResetEmail(context: Context & { link: string }): MailMessage {
  const { to, locale, agencyName, link } = context;
  return locale === 'bn'
    ? {
        to,
        subject: `${agencyName}: পাসওয়ার্ড রিসেট`,
        text: [
          'প্রিয় ব্যবহারকারী,',
          '',
          `আপনার ${agencyName} পাসওয়ার্ড বদলানোর অনুরোধ পেয়েছি। নতুন পাসওয়ার্ড দিতে নিচের লিংকটি খুলুন। লিংকটি ১ ঘণ্টা কাজ করবে এবং একবারই ব্যবহার করা যাবে।`,
          '',
          link,
          '',
          'আপনি অনুরোধ না করে থাকলে এই ইমেইলটি উপেক্ষা করুন। আপনার পাসওয়ার্ড বদলাবে না।',
        ].join('\n'),
        html: html(locale, agencyName, {
          preheader: 'নতুন পাসওয়ার্ড দিতে লিংকটি খুলুন। লিংকটি ১ ঘণ্টা কাজ করবে।',
          heading: 'পাসওয়ার্ড রিসেট করুন',
          greeting: 'প্রিয় ব্যবহারকারী,',
          paragraphs: [`আপনার ${agencyName} পাসওয়ার্ড বদলানোর অনুরোধ পেয়েছি।`],
          action: { label: 'নতুন পাসওয়ার্ড দিন', url: link },
          notes: [
            'লিংকটি ১ ঘণ্টা কাজ করবে এবং একবারই ব্যবহার করা যাবে।',
            'আপনি অনুরোধ না করে থাকলে এই ইমেইলটি উপেক্ষা করুন। আপনার পাসওয়ার্ড বদলাবে না।',
          ],
        }),
      }
    : {
        to,
        subject: `${agencyName}: reset your password`,
        text: [
          'Hello,',
          '',
          `We received a request to change your ${agencyName} password. Open the link below to choose a new one. It works for 1 hour and only once.`,
          '',
          link,
          '',
          'If you did not ask for this, ignore this email. Your password will not change.',
        ].join('\n'),
        html: html(locale, agencyName, {
          preheader: 'Open the link to choose a new password. It works for 1 hour.',
          heading: 'Reset your password',
          greeting: 'Hello,',
          paragraphs: [`We received a request to change your ${agencyName} password.`],
          action: { label: 'Choose a new password', url: link },
          notes: [
            'The link works for 1 hour and only once.',
            'If you did not ask for this, ignore this email. Your password will not change.',
          ],
        }),
      };
}

export function passwordChangedEmail(context: Context & { resetLink: string }): MailMessage {
  const { to, locale, agencyName, resetLink } = context;
  return locale === 'bn'
    ? {
        to,
        subject: `${agencyName}: আপনার পাসওয়ার্ড বদলানো হয়েছে`,
        text: [
          'প্রিয় ব্যবহারকারী,',
          '',
          `আপনার ${agencyName} পাসওয়ার্ড এইমাত্র বদলানো হয়েছে এবং সব ডিভাইস থেকে সাইন আউট করা হয়েছে।`,
          '',
          `আপনি এটি না করে থাকলে এখনই পাসওয়ার্ড রিসেট করুন: ${resetLink}`,
          'এবং এজেন্সির সঙ্গে যোগাযোগ করুন।',
        ].join('\n'),
        html: html(locale, agencyName, {
          preheader: 'আপনার পাসওয়ার্ড এইমাত্র বদলানো হয়েছে।',
          heading: 'আপনার পাসওয়ার্ড বদলানো হয়েছে',
          greeting: 'প্রিয় ব্যবহারকারী,',
          paragraphs: [
            `আপনার ${agencyName} পাসওয়ার্ড এইমাত্র বদলানো হয়েছে এবং সব ডিভাইস থেকে সাইন আউট করা হয়েছে।`,
            'আপনি এটি না করে থাকলে এখনই পাসওয়ার্ড রিসেট করুন এবং এজেন্সির সঙ্গে যোগাযোগ করুন।',
          ],
          action: { label: 'পাসওয়ার্ড রিসেট করুন', url: resetLink },
        }),
      }
    : {
        to,
        subject: `${agencyName}: your password was changed`,
        text: [
          'Hello,',
          '',
          `Your ${agencyName} password was just changed, and every device was signed out.`,
          '',
          `If this was not you, reset your password now: ${resetLink}`,
          'and contact the agency.',
        ].join('\n'),
        html: html(locale, agencyName, {
          preheader: 'Your password was just changed.',
          heading: 'Your password was changed',
          greeting: 'Hello,',
          paragraphs: [
            `Your ${agencyName} password was just changed, and every device was signed out.`,
            'If this was not you, reset your password now and contact the agency.',
          ],
          action: { label: 'Reset my password', url: resetLink },
        }),
      };
}

/** An admin's invitation to work as staff, sent to the invited address. The days match INVITATION_DAYS. */
export function staffInvitationEmail(
  context: Context & {
    name: string;
    role: 'admin' | 'agent';
    invitedBy: string;
    link: string;
  },
): MailMessage {
  const { to, locale, agencyName, name, role, invitedBy, link } = context;
  return locale === 'bn'
    ? {
        to,
        subject: `${agencyName}: আপনাকে আমন্ত্রণ জানানো হয়েছে`,
        text: [
          `প্রিয় ${name},`,
          '',
          `${invitedBy} আপনাকে ${agencyName}-এ ${role === 'admin' ? 'অ্যাডমিন' : 'এজেন্ট'} হিসেবে কাজ করার জন্য আমন্ত্রণ জানিয়েছেন। পাসওয়ার্ড ঠিক করে অ্যাকাউন্ট চালু করতে নিচের লিংকটি খুলুন। লিংকটি ৭ দিন কাজ করবে এবং একবারই ব্যবহার করা যাবে।`,
          '',
          link,
          '',
          'আপনি এটি আশা না করে থাকলে এই ইমেইলটি উপেক্ষা করুন। কোনো অ্যাকাউন্ট তৈরি হবে না।',
        ].join('\n'),
        html: html(locale, agencyName, {
          preheader: 'পাসওয়ার্ড ঠিক করে অ্যাকাউন্ট চালু করুন। লিংকটি ৭ দিন কাজ করবে।',
          heading: 'আপনাকে আমন্ত্রণ জানানো হয়েছে',
          greeting: `প্রিয় ${name},`,
          paragraphs: [
            `${invitedBy} আপনাকে ${agencyName}-এ ${role === 'admin' ? 'অ্যাডমিন' : 'এজেন্ট'} হিসেবে কাজ করার জন্য আমন্ত্রণ জানিয়েছেন।`,
          ],
          action: { label: 'অ্যাকাউন্ট চালু করুন', url: link },
          notes: [
            'লিংকটি ৭ দিন কাজ করবে এবং একবারই ব্যবহার করা যাবে।',
            'আপনি এটি আশা না করে থাকলে এই ইমেইলটি উপেক্ষা করুন। কোনো অ্যাকাউন্ট তৈরি হবে না।',
          ],
        }),
      }
    : {
        to,
        subject: `${agencyName}: you have been invited`,
        text: [
          `Dear ${name},`,
          '',
          `${invitedBy} has invited you to work at ${agencyName} as ${role === 'admin' ? 'an admin' : 'an agent'}. Open the link below to choose a password and start your account. It works for 7 days and only once.`,
          '',
          link,
          '',
          'If you did not expect this, ignore this email. No account will be created.',
        ].join('\n'),
        html: html(locale, agencyName, {
          preheader: 'Choose a password and start your account. The link works for 7 days.',
          heading: 'You have been invited',
          greeting: `Dear ${name},`,
          paragraphs: [
            `${invitedBy} has invited you to work at ${agencyName} as ${role === 'admin' ? 'an admin' : 'an agent'}.`,
          ],
          action: { label: 'Start my account', url: link },
          notes: [
            'The link works for 7 days and only once.',
            'If you did not expect this, ignore this email. No account will be created.',
          ],
        }),
      };
}

/** The link that opens a client's own login, sent to the address the agent entered. The days match CLIENT_LOGIN_DAYS. */
export function clientLoginEmail(context: Context & { name: string; link: string }): MailMessage {
  const { to, locale, agencyName, name, link } = context;
  return locale === 'bn'
    ? {
        to,
        subject: `${agencyName}: আপনার নিজের লগইন`,
        text: [
          `প্রিয় ${name},`,
          '',
          `${agencyName} আপনার জন্য একটি লগইন তৈরি করেছে, যাতে আপনি নিজে আপনার মিল ও অনুরোধ দেখতে পারেন। পাসওয়ার্ড ঠিক করতে নিচের লিংকটি খুলুন। লিংকটি ৭ দিন কাজ করবে এবং একবারই ব্যবহার করা যাবে।`,
          '',
          link,
          '',
          'আপনি এটি আশা না করে থাকলে এই ইমেইলটি উপেক্ষা করুন। কোনো অ্যাকাউন্ট তৈরি হবে না।',
        ].join('\n'),
        html: html(locale, agencyName, {
          preheader: 'পাসওয়ার্ড ঠিক করতে লিংকটি খুলুন। লিংকটি ৭ দিন কাজ করবে।',
          heading: 'আপনার নিজের লগইন',
          greeting: `প্রিয় ${name},`,
          paragraphs: [
            `${agencyName} আপনার জন্য একটি লগইন তৈরি করেছে, যাতে আপনি নিজে আপনার মিল ও অনুরোধ দেখতে পারেন।`,
          ],
          action: { label: 'পাসওয়ার্ড ঠিক করুন', url: link },
          notes: [
            'লিংকটি ৭ দিন কাজ করবে এবং একবারই ব্যবহার করা যাবে।',
            'আপনি এটি আশা না করে থাকলে এই ইমেইলটি উপেক্ষা করুন। কোনো অ্যাকাউন্ট তৈরি হবে না।',
          ],
        }),
      }
    : {
        to,
        subject: `${agencyName}: your own login`,
        text: [
          `Dear ${name},`,
          '',
          `${agencyName} has set up a login for you, so you can see your matches and requests yourself. Open the link below to choose your password. It works for 7 days and only once.`,
          '',
          link,
          '',
          'If you did not expect this, ignore this email. No account will be created.',
        ].join('\n'),
        html: html(locale, agencyName, {
          preheader: 'Open the link to choose your password. It works for 7 days.',
          heading: 'Your own login',
          greeting: `Dear ${name},`,
          paragraphs: [
            `${agencyName} has set up a login for you, so you can see your matches and requests yourself.`,
          ],
          action: { label: 'Choose my password', url: link },
          notes: [
            'The link works for 7 days and only once.',
            'If you did not expect this, ignore this email. No account will be created.',
          ],
        }),
      };
}

/** The link that opens a guardian's login, sent to the address the agent entered. The days match GUARDIAN_INVITE_DAYS. */
export function guardianInviteEmail(
  context: Context & { name: string; clientName: string; link: string },
): MailMessage {
  const { to, locale, agencyName, name, clientName, link } = context;
  return locale === 'bn'
    ? {
        to,
        subject: `${agencyName}: অভিভাবক হিসেবে আপনার লগইন`,
        text: [
          `প্রিয় ${name},`,
          '',
          `${clientName} এবং ${agencyName} আপনাকে অভিভাবক হিসেবে যুক্ত করতে চেয়েছেন, যাতে আপনি তাঁর প্রস্তাবগুলো দেখে পরামর্শ দিতে পারেন। পাসওয়ার্ড ঠিক করতে নিচের লিংকটি খুলুন। লিংকটি ৭ দিন কাজ করবে এবং একবারই ব্যবহার করা যাবে।`,
          '',
          link,
          '',
          'আপনি এটি আশা না করে থাকলে এই ইমেইলটি উপেক্ষা করুন। কোনো অ্যাকাউন্ট তৈরি হবে না।',
        ].join('\n'),
        html: html(locale, agencyName, {
          preheader: 'পাসওয়ার্ড ঠিক করতে লিংকটি খুলুন। লিংকটি ৭ দিন কাজ করবে।',
          heading: 'অভিভাবক হিসেবে আপনার লগইন',
          greeting: `প্রিয় ${name},`,
          paragraphs: [
            `${clientName} এবং ${agencyName} আপনাকে অভিভাবক হিসেবে যুক্ত করতে চেয়েছেন, যাতে আপনি তাঁর প্রস্তাবগুলো দেখে পরামর্শ দিতে পারেন।`,
          ],
          action: { label: 'পাসওয়ার্ড ঠিক করুন', url: link },
          notes: [
            'লিংকটি ৭ দিন কাজ করবে এবং একবারই ব্যবহার করা যাবে।',
            'আপনি এটি আশা না করে থাকলে এই ইমেইলটি উপেক্ষা করুন। কোনো অ্যাকাউন্ট তৈরি হবে না।',
          ],
        }),
      }
    : {
        to,
        subject: `${agencyName}: your login as a guardian`,
        text: [
          `Dear ${name},`,
          '',
          `${clientName} and ${agencyName} would like you to be a guardian, so you can see their proposals and give advice. Open the link below to choose your password. It works for 7 days and only once.`,
          '',
          link,
          '',
          'If you did not expect this, ignore this email. No account will be created.',
        ].join('\n'),
        html: html(locale, agencyName, {
          preheader: 'Open the link to choose your password. It works for 7 days.',
          heading: 'Your login as a guardian',
          greeting: `Dear ${name},`,
          paragraphs: [
            `${clientName} and ${agencyName} would like you to be a guardian, so you can see their proposals and give advice.`,
          ],
          action: { label: 'Choose my password', url: link },
          notes: [
            'The link works for 7 days and only once.',
            'If you did not expect this, ignore this email. No account will be created.',
          ],
        }),
      };
}
