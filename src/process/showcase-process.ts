import { variantKey } from '../bo/photo.js';
import type { LeadInput } from '../bo/showcase.js';
import { AppError } from '../exception/app-error.js';
import { showcaseBlur } from '../security/photo-view.js';
import type { ShowcaseService } from '../service/showcase-service.js';
import type { FileStorage } from '../storage/service/file-storage.js';
import type { PhoneAuthProcess, PhoneContext } from './phone-auth-process.js';

/**
 * What the public site's "Meet our members" needs beyond the rules: the heavily blurred picture of a card (made
 * from the small stored copy, so the clear picture is never sent), and the visitor's request to be called, which
 * needs a number proved with a text-message code before anything is stored.
 */
export class ShowcaseProcess {
  constructor(
    private readonly showcase: Pick<
      ShowcaseService,
      'publicCards' | 'browse' | 'photoKey' | 'acceptsLeads' | 'recordLead'
    >,
    private readonly storage: Pick<FileStorage, 'get'>,
    private readonly phone: Pick<PhoneAuthProcess, 'sendLeadCode' | 'checkLeadCode'> | undefined,
  ) {}

  cards(agencyId: string) {
    return this.showcase.publicCards(agencyId);
  }

  browse(...args: Parameters<ShowcaseService['browse']>) {
    return this.showcase.browse(...args);
  }

  async photo(agencyId: string, ref: string): Promise<Buffer> {
    const key = await this.showcase.photoKey(agencyId, ref);
    if (!key) throw new AppError(404, 'NOT_FOUND');
    const data = await this.storage.get(variantKey(key, 'thumb'));
    if (!data) throw new AppError(404, 'NOT_FOUND');
    return showcaseBlur(data);
  }

  /** Sends the visitor a code, only while the agency has the showcase on (otherwise nobody should be paying for texts). */
  async sendCode(context: PhoneContext, phone: string, locale: 'bn' | 'en') {
    if (!this.phone) throw new AppError(404, 'PHONE_NOT_CONFIGURED');
    if (!(await this.showcase.acceptsLeads(context.agencyId))) throw new AppError(404, 'NOT_FOUND');
    return this.phone.sendLeadCode(context, phone, locale);
  }

  /** Checks the code, then stores the lead. The number stored is the one the code proved. */
  async submit(agencyId: string, input: LeadInput) {
    if (!this.phone) throw new AppError(404, 'PHONE_NOT_CONFIGURED');
    if (!(await this.showcase.acceptsLeads(agencyId))) throw new AppError(404, 'NOT_FOUND');
    await this.phone.checkLeadCode(agencyId, input.phone, input.code);
    await this.showcase.recordLead(agencyId, {
      name: input.name,
      phone: input.phone,
      ref: input.ref,
    });
  }
}
