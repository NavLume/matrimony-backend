import { AppError } from '../exception/app-error.js';

/**
 * A screen for an uploaded PDF, not a guarantee. It refuses what is plainly not a PDF and what
 * carries active content that a CV never needs: scripts, launch actions, forms that submit, rich
 * media and attached files. Names inside a PDF may be written with #xx escapes, which are decoded
 * before looking, so `/J#61vaScript` does not slip through.
 *
 * What it cannot see: content inside compressed object streams. That is why the file is also only
 * ever served with `nosniff`, a sandboxing content-security-policy and no caching, and only to
 * someone allowed to see it.
 */
const ACTIVE_CONTENT =
  /\/(JavaScript|JS|Launch|OpenAction|AA|EmbeddedFile|EmbeddedFiles|RichMedia|SubmitForm|ImportData|GoToR|GoToE)\b/;

export function assertPdf(bytes: Buffer): void {
  if (bytes.length < 16 || bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new AppError(415, 'CV_NOT_A_PDF');
  }
  // A PDF ends with %%EOF, allowing for trailing whitespace or a short tail.
  if (
    !bytes
      .subarray(Math.max(0, bytes.length - 2048))
      .toString('latin1')
      .includes('%%EOF')
  ) {
    throw new AppError(415, 'CV_NOT_A_PDF');
  }
  const text = bytes
    .toString('latin1')
    .replace(/#([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  if (ACTIVE_CONTENT.test(text)) throw new AppError(422, 'CV_ACTIVE_CONTENT');
}
