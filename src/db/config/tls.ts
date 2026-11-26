import { readFileSync } from 'node:fs';

/**
 * The TLS options for a PostgreSQL connection. With `verify-full` the server's certificate is always checked against its
 * host name. A managed database (for example DigitalOcean's) signs its certificate with its own authority, which is not in
 * the system's list of trusted ones, so the deployment gives that authority's certificate as a file (`DB_CA_FILE`) and it is
 * trusted for this connection only. The check is never switched off.
 */
export function databaseSsl(verify: boolean, caFile?: string) {
  if (!verify) return false;
  return caFile
    ? { rejectUnauthorized: true, ca: readFileSync(caFile, 'utf8') }
    : { rejectUnauthorized: true };
}
