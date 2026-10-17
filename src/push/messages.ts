type Locale = 'bn' | 'en';

const GENERIC: Record<Locale, string> = {
  bn: 'আপনার একটি নতুন নোটিশ আছে। দেখতে অ্যাপ খুলুন।',
  en: 'You have a new notice. Open the app to read it.',
};

/**
 * The short line shown on a phone for an inbox line. It names the kind of thing that happened and
 * nothing about who or what, because a lock screen can be read by anyone. The real line is in the app.
 */
const BY_KIND: Record<string, Record<Locale, string>> = {
  'interest.received': {
    bn: 'আপনার জন্য একটি নতুন সংযোগ অনুরোধ এসেছে।',
    en: 'You have a new connection request.',
  },
  'interest.forwarded': {
    bn: 'আপনার জন্য একটি নতুন সংযোগ অনুরোধ এসেছে।',
    en: 'You have a new connection request.',
  },
  'interest.accepted': {
    bn: 'আপনার একটি অনুরোধ গ্রহণ করা হয়েছে।',
    en: 'One of your requests was accepted.',
  },
  'interest.matched': {
    bn: 'আপনার একটি অনুরোধ গ্রহণ করা হয়েছে।',
    en: 'One of your requests was accepted.',
  },
  'interest.declined': {
    bn: 'আপনার একটি অনুরোধের উত্তর এসেছে।',
    en: 'One of your requests was answered.',
  },
  'interest.contact_shared': {
    bn: 'যোগাযোগের তথ্য শেয়ার করা হয়েছে।',
    en: 'Contact details were shared with you.',
  },
  'profile.review_decided': {
    bn: 'আপনার প্রোফাইলের একটি পরিবর্তনের সিদ্ধান্ত হয়েছে।',
    en: 'A change to your profile was decided.',
  },
  'candidates.released': {
    bn: 'আপনার জন্য নতুন পাত্র/পাত্রীর তালিকা এসেছে।',
    en: 'New matches are ready for you.',
  },
  'interest.review': {
    bn: 'একটি অনুরোধ আপনার পর্যালোচনার অপেক্ষায় আছে।',
    en: 'A request is waiting for your review.',
  },
  'interest.review_reminder': {
    bn: 'একটি অনুরোধ আপনার পর্যালোচনার অপেক্ষায় আছে।',
    en: 'A request is waiting for your review.',
  },
  'guardian.requested': {
    bn: 'আপনার এজেন্সি একজন অভিভাবক যুক্ত করার জন্য আপনার সম্মতি চেয়েছে।',
    en: 'Your agency asked for your agreement to add a guardian.',
  },
  'guardian.advice': {
    bn: 'অভিভাবক একটি প্রস্তাবে পরামর্শ দিয়েছেন।',
    en: 'Your guardian gave advice on a proposal.',
  },
  'meeting.update': {
    bn: 'একটি সাক্ষাতের সময় ঠিক বা পরিবর্তন করা হয়েছে।',
    en: 'A meeting was set or changed.',
  },
  'chat.requested': {
    bn: 'কেউ আপনার সঙ্গে কথা বলতে চেয়েছেন।',
    en: 'Someone would like to chat with you.',
  },
  'chat.accepted': {
    bn: 'আপনার কথা বলার অনুরোধ গ্রহণ করা হয়েছে।',
    en: 'Your request to chat was accepted.',
  },
  'chat.message': { bn: 'আপনার একটি নতুন বার্তা আছে।', en: 'You have a new message.' },
  'chat.reported': {
    bn: 'একটি কথোপকথন নিয়ে অভিযোগ এসেছে।',
    en: 'A conversation was reported.',
  },
  'chat.invited': {
    bn: 'আপনাকে একটি কথোপকথনে যুক্ত করা হয়েছে।',
    en: 'You were invited into a conversation.',
  },
  'profile.review_requested': {
    bn: 'একটি পরিবর্তন আপনার পর্যালোচনার অপেক্ষায় আছে।',
    en: 'A change is waiting for your review.',
  },
};

export function pushBody(templateKey: string, locale: Locale): string {
  return (BY_KIND[templateKey] ?? { bn: GENERIC.bn, en: GENERIC.en })[locale];
}
