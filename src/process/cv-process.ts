import type { Logger } from 'pino';
import { MAX_CV_BYTES, safeFileName, type CvState } from '../bo/cv.js';
import { AppError } from '../exception/app-error.js';
import { assertPdf } from '../security/pdf-check.js';
import type { CvService, CvTarget } from '../service/cv-service.js';
import type { ProfileActor } from '../service/profile-service.js';
import type { FileStorage } from '../storage/service/file-storage.js';

/**
 * A CV from the file's point of view. It joins the PDF check, the file storage and the database
 * and keeps them consistent, the way photos do:
 *
 * - The PDF is checked before anything is stored.
 * - The database record is written only after the file is stored, so a CV in the list always has its file.
 * - If the record cannot be written, the file just stored is deleted again.
 * - When a CV is replaced or removed, the record changes first and the old files go after. A file that
 *   cannot be deleted is logged and left behind harmlessly: nothing points to it any more.
 */
export class CvProcess {
  constructor(
    private readonly cvs: Pick<
      CvService,
      | 'state'
      | 'reserve'
      | 'attach'
      | 'remove'
      | 'review'
      | 'locate'
      | 'locateForConnection'
      | 'infoForConnection'
    >,
    private readonly storage: FileStorage,
    private readonly logger: Logger,
  ) {}

  state(actor: ProfileActor, target: CvTarget): Promise<CvState> {
    return this.cvs.state(actor, target);
  }

  async upload(
    actor: ProfileActor,
    target: CvTarget,
    bytes: Buffer,
    rawName: string | undefined,
    correlationId: string,
  ): Promise<CvState> {
    if (bytes.length === 0 || bytes.length > MAX_CV_BYTES) throw new AppError(413, 'CV_TOO_LARGE');
    const reservation = await this.cvs.reserve(actor, target);
    assertPdf(bytes);
    await this.storage.put(reservation.storageKey, bytes, 'application/pdf');
    try {
      const change = await this.cvs.attach(
        actor,
        target,
        reservation,
        safeFileName(rawName),
        bytes.length,
        correlationId,
      );
      await this.deleteQuietly(change.deleteKeys);
      return change.state;
    } catch (error) {
      await this.deleteQuietly([reservation.storageKey]);
      throw error;
    }
  }

  async remove(actor: ProfileActor, target: CvTarget, correlationId: string): Promise<CvState> {
    const change = await this.cvs.remove(actor, target, correlationId);
    await this.deleteQuietly(change.deleteKeys);
    return change.state;
  }

  async review(
    actor: ProfileActor,
    profileId: string,
    approve: boolean,
    notes: string | null,
    correlationId: string,
  ): Promise<CvState> {
    const change = await this.cvs.review(actor, profileId, approve, notes, correlationId);
    await this.deleteQuietly(change.deleteKeys);
    return change.state;
  }

  /** The file of a CV the owner or staff asked for. */
  async file(
    actor: ProfileActor,
    target: CvTarget,
    which: 'current' | 'replacement',
  ): Promise<{ bytes: Buffer; fileName: string }> {
    return this.read(await this.cvs.locate(actor, target, which));
  }

  /** The file of a connected person's CV. */
  async fileOfConnection(
    actor: ProfileActor,
    candidateId: string,
  ): Promise<{ bytes: Buffer; fileName: string }> {
    return this.read(await this.cvs.locateForConnection(actor, candidateId));
  }

  infoOfConnection(actor: ProfileActor, candidateId: string) {
    return this.cvs.infoForConnection(actor, candidateId);
  }

  private async read(found: { storageKey: string; fileName: string }) {
    const bytes = await this.storage.get(found.storageKey);
    if (!bytes) throw new AppError(404, 'CV_NOT_FOUND');
    return { bytes, fileName: found.fileName };
  }

  private async deleteQuietly(keys: string[]) {
    for (const key of keys) {
      try {
        await this.storage.delete(key);
      } catch {
        // Only the code is logged: a storage error can carry the bucket or the path.
        this.logger.error({ code: 'CV_FILE_DELETE_FAILED' }, 'Could not delete a CV file');
      }
    }
  }
}
