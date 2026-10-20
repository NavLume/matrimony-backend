import type { LegalDocument, LegalInput, LegalKind, LocalizedText } from '../../../bo/legal.js';
import type { Transaction } from '../../config/database.js';

type Row = Record<string, unknown>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function text(value: unknown): LocalizedText | undefined {
  if (!isObject(value)) return undefined;
  const bn = typeof value.bn === 'string' && value.bn ? value.bn : undefined;
  const en = typeof value.en === 'string' && value.en ? value.en : undefined;
  return bn || en ? { ...(bn ? { bn } : {}), ...(en ? { en } : {}) } : undefined;
}

function map(kind: LegalKind, row: Row | undefined): LegalDocument {
  if (!row) return { kind, version: 0 };
  return {
    kind,
    version: row.version as number,
    title: text(row.title),
    body: text(row.body),
    createdAt: (row.created_at as Date).toISOString(),
  };
}

/** The agency's terms and privacy policy: numbered versions that are only ever added. */
export class LegalRepository {
  async current(tx: Transaction, agencyId: string, kind: LegalKind): Promise<LegalDocument> {
    const result = await tx.query(
      `SELECT version, title, body, created_at FROM matrimony.legal_documents
        WHERE agency_id = $1 AND kind = $2 ORDER BY version DESC LIMIT 1`,
      [agencyId, kind],
    );
    return map(kind, result.rows[0] as Row | undefined);
  }

  /** Adds the next version. Two saves at once cannot take the same number: the second fails. */
  async addVersion(
    tx: Transaction,
    agencyId: string,
    kind: LegalKind,
    input: LegalInput,
    accountId: string,
  ): Promise<LegalDocument> {
    const result = await tx.query(
      `INSERT INTO matrimony.legal_documents (agency_id, kind, version, title, body, created_by)
       SELECT $1, $2, coalesce(max(version), 0) + 1, $3::jsonb, $4::jsonb, $5
         FROM matrimony.legal_documents WHERE agency_id = $1 AND kind = $2
       RETURNING version, title, body, created_at`,
      [
        agencyId,
        kind,
        JSON.stringify(input.title ?? {}),
        JSON.stringify(input.body ?? {}),
        accountId,
      ],
    );
    return map(kind, result.rows[0] as Row);
  }
}
