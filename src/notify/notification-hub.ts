import { Client } from 'pg';
import type { Logger } from 'pino';

/** Who an inbox line was added for. */
export interface NotificationSignal {
  agencyId: string;
  accountId: string;
}

type Listener = (signal: NotificationSignal) => void;

/** The part of a database client the hub needs, so a test can stand in for it. */
export interface ListenClient {
  connect(): Promise<unknown>;
  query(sql: string): Promise<unknown>;
  on(event: 'notification', handler: (message: { payload?: string | null }) => void): unknown;
  on(event: 'error' | 'end', handler: (error?: Error) => void): unknown;
  end(): Promise<void>;
}

const CHANNEL = 'notifications';
const FIRST_RETRY_MS = 1000;
const LONGEST_RETRY_MS = 30_000;
/** How many live streams one account may keep open. More tabs than this are refused. */
export const MAX_STREAMS_PER_ACCOUNT = 5;

/**
 * Turns "an inbox line was added" from the database into a call for whoever is listening for that
 * account. One database connection listens for all of them, however many browser tabs are open.
 *
 * - The channel carries only the agency and the account (see migration 021), never inbox text.
 * - If the connection drops, it is made again with a growing pause, and every listener is told once
 *   it is back, because lines may have been added while it was gone. Nobody misses an update.
 * - Several API processes each listen, so a tab hears about a line whichever process wrote it.
 */
export class NotificationHub {
  private client: ListenClient | null = null;
  private readonly listeners = new Map<string, Set<Listener>>();
  private stopped = false;
  private retry: NodeJS.Timeout | undefined;
  private pause = FIRST_RETRY_MS;

  constructor(
    private readonly connect: () => ListenClient,
    private readonly logger: Logger,
  ) {}

  /** Starts listening. Resolves once the first connection is made; a failure is retried, not thrown. */
  async start(): Promise<void> {
    await this.open();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.retry);
    const client = this.client;
    this.client = null;
    await client?.end().catch(() => undefined);
    this.listeners.clear();
  }

  /** How many listeners an account has now. */
  count(agencyId: string, accountId: string): number {
    return this.listeners.get(key(agencyId, accountId))?.size ?? 0;
  }

  /**
   * Calls `listener` whenever a line is added for the account, and once when the connection to the
   * database is made again. Returns what stops it, or null when the account has too many open.
   */
  subscribe(agencyId: string, accountId: string, listener: Listener): (() => void) | null {
    const id = key(agencyId, accountId);
    const set = this.listeners.get(id) ?? new Set<Listener>();
    if (set.size >= MAX_STREAMS_PER_ACCOUNT) return null;
    set.add(listener);
    this.listeners.set(id, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(id);
    };
  }

  private async open(): Promise<void> {
    if (this.stopped) return;
    const client = this.connect();
    client.on('notification', (message) => this.receive(message.payload));
    const lost = (error?: Error) => {
      if (this.client !== client) return;
      this.client = null;
      this.logger.warn(
        { code: 'NOTIFICATION_LISTEN_LOST', reason: error?.name },
        'Live notification connection lost',
      );
      void client.end().catch(() => undefined);
      this.schedule();
    };
    client.on('error', lost);
    client.on('end', () => lost());
    try {
      await client.connect();
      await client.query(`LISTEN ${CHANNEL}`);
      this.client = client;
      this.pause = FIRST_RETRY_MS;
      // Lines may have been added while there was no connection: everyone checks again.
      this.broadcast();
    } catch {
      void client.end().catch(() => undefined);
      this.schedule();
    }
  }

  private schedule() {
    if (this.stopped) return;
    clearTimeout(this.retry);
    this.retry = setTimeout(() => void this.open(), this.pause);
    this.retry.unref();
    this.pause = Math.min(this.pause * 2, LONGEST_RETRY_MS);
  }

  private receive(payload: string | null | undefined) {
    if (!payload) return;
    let signal: NotificationSignal;
    try {
      const parsed = JSON.parse(payload) as { agency?: unknown; account?: unknown };
      if (typeof parsed.agency !== 'string' || typeof parsed.account !== 'string') return;
      signal = { agencyId: parsed.agency, accountId: parsed.account };
    } catch {
      return;
    }
    for (const listener of this.listeners.get(key(signal.agencyId, signal.accountId)) ?? []) {
      this.call(listener, signal);
    }
  }

  private broadcast() {
    for (const [id, set] of this.listeners) {
      const [agencyId, accountId] = id.split(':') as [string, string];
      for (const listener of set) this.call(listener, { agencyId, accountId });
    }
  }

  /** A listener that throws must not stop the others. */
  private call(listener: Listener, signal: NotificationSignal) {
    try {
      listener(signal);
    } catch {
      this.logger.error({ code: 'NOTIFICATION_LISTENER_FAILED' }, 'A live listener failed');
    }
  }
}

const key = (agencyId: string, accountId: string) => `${agencyId}:${accountId}`;

/** The real thing: a dedicated database connection for LISTEN. */
export const listenClientFor = (connectionString: string) => (): ListenClient =>
  new Client({ connectionString }) as unknown as ListenClient;
