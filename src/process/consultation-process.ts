import type { ConsultationCodeInput, ConsultationInput } from '../bo/consultation.js';
import { AppError } from '../exception/app-error.js';
import type { ConsultationService } from '../service/consultation-service.js';
import type { LeadEmailCodes } from './lead-email-codes.js';
import type { PhoneAuthProcess, PhoneContext } from './phone-auth-process.js';

/** Bangladesh proves the mobile number by a text message; anywhere else proves the email (no text is sent abroad). */
const byEmail = (input: { country: string }) => input.country !== 'BD';

/**
 * Talk to an adviser across its resources: the code (Redis, sent by text message through the phone process, or by
 * email for a visitor abroad) and the enquiry (PostgreSQL). The code is checked and used up first; only then is the
 * enquiry saved and the branch number returned. If saving fails after the code was used, the visitor asks for a new
 * code: nothing is shown without a record, which is the rule that matters.
 */
export class ConsultationProcess {
  constructor(
    private readonly consultations: Pick<ConsultationService, 'start' | 'codeAsked'>,
    private readonly phone: Pick<PhoneAuthProcess, 'sendLeadCode' | 'checkLeadCode'> | undefined,
    private readonly emailCodes?: Pick<LeadEmailCodes, 'send' | 'check'>,
  ) {}

  /**
   * Sends the code. Unlike the showcase's, this works whatever the agency switched on: it is the main way in.
   * With the visitor's name, the enquiry is saved first, so the lead is kept even when the code then fails or is
   * refused (too many codes) or is never typed.
   */
  async sendCode(context: PhoneContext, input: ConsultationCodeInput, ownHost: string | null) {
    const { locale, name, ...details } = input;
    if (byEmail(input) && !input.email) throw emailRequired();
    if (name) await this.consultations.codeAsked(context.agencyId, { ...details, name }, ownHost);
    if (byEmail(input)) {
      if (!this.emailCodes) throw new AppError(404, 'EMAIL_NOT_CONFIGURED');
      return this.emailCodes.send(context, input.email!, locale);
    }
    if (!this.phone) throw new AppError(404, 'PHONE_NOT_CONFIGURED');
    return this.phone.sendLeadCode(context, input.phone, locale);
  }

  async submit(agencyId: string, input: ConsultationInput, ownHost: string | null) {
    if (byEmail(input)) {
      if (!input.email) throw emailRequired();
      if (!this.emailCodes) throw new AppError(404, 'EMAIL_NOT_CONFIGURED');
      await this.emailCodes.check(agencyId, input.email, input.code);
    } else {
      if (!this.phone) throw new AppError(404, 'PHONE_NOT_CONFIGURED');
      await this.phone.checkLeadCode(agencyId, input.phone, input.code);
    }
    return this.consultations.start(
      agencyId,
      {
        name: input.name,
        phone: input.phone,
        office: input.office,
        ref: input.ref,
        intent: input.intent,
        origin: input.origin,
        heardFrom: input.heardFrom,
        email: input.email,
        country: input.country,
        whatsapp: input.whatsapp,
      },
      ownHost,
      byEmail(input) ? 'email' : 'phone',
    );
  }
}

const emailRequired = () =>
  new AppError(400, 'INVALID_REQUEST', { fields: [{ path: 'email', code: 'required' }] });
