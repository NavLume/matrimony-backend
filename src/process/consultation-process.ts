import type { ConsultationCodeInput, ConsultationInput } from '../bo/consultation.js';
import { AppError } from '../exception/app-error.js';
import type { ConsultationService } from '../service/consultation-service.js';
import type { PhoneAuthProcess, PhoneContext } from './phone-auth-process.js';

/**
 * Talk to an adviser across its two resources: the text-message code (Redis, through the phone process) and the
 * enquiry (PostgreSQL). The code is checked and used up first; only then is the enquiry saved and the adviser
 * returned. If saving fails after the code was used, the visitor asks for a new code: nothing is shown without a
 * record, which is the rule that matters.
 */
export class ConsultationProcess {
  constructor(
    private readonly consultations: Pick<ConsultationService, 'start' | 'codeAsked'>,
    private readonly phone: Pick<PhoneAuthProcess, 'sendLeadCode' | 'checkLeadCode'> | undefined,
  ) {}

  /**
   * Sends the code. Unlike the showcase's, this works whatever the agency switched on: it is the main way in.
   * With the visitor's name, the enquiry is saved first, so the lead is kept even when the text then fails or is
   * refused (too many codes) or the code is never typed.
   */
  async sendCode(context: PhoneContext, input: ConsultationCodeInput, ownHost: string | null) {
    if (!this.phone) throw new AppError(404, 'PHONE_NOT_CONFIGURED');
    const { locale, name, ...details } = input;
    if (name) await this.consultations.codeAsked(context.agencyId, { ...details, name }, ownHost);
    return this.phone.sendLeadCode(context, input.phone, locale);
  }

  async submit(agencyId: string, input: ConsultationInput, ownHost: string | null) {
    if (!this.phone) throw new AppError(404, 'PHONE_NOT_CONFIGURED');
    await this.phone.checkLeadCode(agencyId, input.phone, input.code);
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
      },
      ownHost,
    );
  }
}
