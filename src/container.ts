import type { AppConfig } from './config/env.js';
import type { Logger } from 'pino';
import { createDatabase } from './db/config/database.js';
import { IdentityRepository } from './db/raw/repository/identity-repository.js';
import { IdentityDbService } from './db/service/identity-db-service.js';
import { EventRepository } from './db/raw/repository/event-repository.js';
import { EventDbService } from './db/service/event-db-service.js';
import { IdentityService } from './service/identity-service.js';
import { MobileService } from './service/mobile-service.js';
import { createRedis } from './cache/config/redis.js';
import { SessionRepository } from './cache/repository/session-repository.js';
import { AccessTokens, parseSigningKey } from './security/access-token.js';
import { PasswordHasher } from './security/password-hasher.js';
import { OneTimeTokenRepository } from './cache/repository/one-time-token-repository.js';
import { ThrottleRepository } from './cache/repository/throttle-repository.js';
import { ConsoleMailer, type Mailer } from './mail/mailer.js';
import { SmtpMailer } from './mail/smtp-mailer.js';
import { CredentialRepository } from './db/raw/repository/credential-repository.js';
import { CredentialDbService } from './db/service/credential-db-service.js';
import { CredentialService } from './service/credential-service.js';
import { AccountAccessProcess } from './process/account-access-process.js';
import { StaffInvitationProcess } from './process/staff-invitation-process.js';
import { ClientLoginProcess } from './process/client-login-process.js';
import { PaymentService } from './service/payment-service.js';
import { ServiceTermsService } from './service/service-terms-service.js';
import { JourneyService } from './service/journey-service.js';
import { AttentionService } from './service/attention-service.js';
import { ConcernService } from './service/concern-service.js';
import { PrivacyService } from './service/privacy-service.js';
import { DeclineService } from './service/decline-service.js';
import { DeclineDbService } from './db/service/decline-db-service.js';
import { DeclineRepository } from './db/raw/repository/decline-repository.js';
import { PrivacyDbService } from './db/service/privacy-db-service.js';
import { PrivacyRepository } from './db/raw/repository/privacy-repository.js';
import { SettingsService } from './service/settings-service.js';
import { SettingsDbService } from './db/service/settings-db-service.js';
import { SettingsRepository } from './db/raw/repository/settings-repository.js';
import { ConcernDbService } from './db/service/concern-db-service.js';
import { ConcernRepository } from './db/raw/repository/concern-repository.js';
import { AttentionDbService } from './db/service/attention-db-service.js';
import { AttentionRepository } from './db/raw/repository/attention-repository.js';
import { JourneyDbService } from './db/service/journey-db-service.js';
import { JourneyRepository } from './db/raw/repository/journey-repository.js';
import { ServiceTermsDbService } from './db/service/service-terms-db-service.js';
import { ServiceTermsRepository } from './db/raw/repository/service-terms-repository.js';
import { AgreementService } from './service/agreement-service.js';
import { AgreementDbService } from './db/service/agreement-db-service.js';
import { AgreementRepository } from './db/raw/repository/agreement-repository.js';
import { LegalService } from './service/legal-service.js';
import { LegalDbService } from './db/service/legal-db-service.js';
import { LegalRepository } from './db/raw/repository/legal-repository.js';
import { PreviewRepository } from './cache/repository/preview-repository.js';
import { SiteContentService } from './service/site-content-service.js';
import { SiteContentDbService } from './db/service/site-content-db-service.js';
import { SiteContentRepository } from './db/raw/repository/site-content-repository.js';
import { CoupleMatchService } from './service/couple-match-service.js';
import { CoupleMatchDbService } from './db/service/couple-match-db-service.js';
import { CoupleMatchRepository } from './db/raw/repository/couple-match-repository.js';
import { ActivityService } from './service/activity-service.js';
import { ActivityRepository } from './db/raw/repository/activity-repository.js';
import { GuardianProcess } from './process/guardian-process.js';
import { GuardianService } from './service/guardian-service.js';
import { GuardianDbService } from './db/service/guardian-db-service.js';
import { GuardianRepository } from './db/raw/repository/guardian-repository.js';
import { MeetingService } from './service/meeting-service.js';
import { MeetingDbService } from './db/service/meeting-db-service.js';
import { MeetingRepository } from './db/raw/repository/meeting-repository.js';
import { VerificationService } from './service/verification-service.js';
import { VerificationDbService } from './db/service/verification-db-service.js';
import { VerificationRepository } from './db/raw/repository/verification-repository.js';
import { ReportService } from './service/report-service.js';
import { ChatService } from './service/chat-service.js';
import { ChatDbService } from './db/service/chat-db-service.js';
import { ChatRepository } from './db/raw/repository/chat-repository.js';
import { ReportRepository } from './db/raw/repository/report-repository.js';
import { PaymentDbService } from './db/service/payment-db-service.js';
import { PaymentRepository } from './db/raw/repository/payment-repository.js';
import { PushProcess } from './process/push-process.js';
import { PushDbService } from './db/service/push-db-service.js';
import { PushRepository } from './db/raw/repository/push-repository.js';
import { ConsolePushSender } from './push/push-sender.js';
import { AccountDeletionProcess } from './process/account-deletion-process.js';
import { AccountDeletionDbService } from './db/service/account-deletion-db-service.js';
import { AccountDeletionRepository } from './db/raw/repository/account-deletion-repository.js';
import { ClientLoginService } from './service/client-login-service.js';
import { ClientLoginDbService } from './db/service/client-login-db-service.js';
import { ClientLoginRepository } from './db/raw/repository/client-login-repository.js';
import { StaffInvitationService } from './service/staff-invitation-service.js';
import { StaffInvitationDbService } from './db/service/staff-invitation-db-service.js';
import { StaffInvitationRepository } from './db/raw/repository/staff-invitation-repository.js';
import { GoogleAuthProcess } from './process/google-auth-process.js';
import { GoogleProvider } from './security/google-provider.js';
import { PhoneAuthProcess } from './process/phone-auth-process.js';
import { PhoneCodeRepository } from './cache/repository/phone-code-repository.js';
import { ConsoleSmsSender } from './sms/sender.js';
import { SecretBox } from './security/secret-box.js';
import { AuthProcess } from './process/auth-process.js';
import { createMongo } from './mongo/config/client.js';
import { MongoEventRepository } from './mongo/repository/event-repository.js';
import { MongoEventService } from './mongo/service/event-service.js';
import type { EventDocument } from './mongo/entity/workflow-event.js';
import { ProfileRepository } from './db/raw/repository/profile-repository.js';
import { ProfileDbService } from './db/service/profile-db-service.js';
import { ProfileService } from './service/profile-service.js';
import { PhotoRepository } from './db/raw/repository/photo-repository.js';
import { PhotoDbService } from './db/service/photo-db-service.js';
import { PhotoService } from './service/photo-service.js';
import { PhotoProcess } from './process/photo-process.js';
import { CvRepository } from './db/raw/repository/cv-repository.js';
import { CvDbService } from './db/service/cv-db-service.js';
import { CvService } from './service/cv-service.js';
import { CvProcess } from './process/cv-process.js';
import { processImage } from './security/image-processor.js';
import { createFileStorage } from './storage/config/storage.js';
import { RegistrationRepository } from './db/raw/repository/registration-repository.js';
import { RegistrationDbService } from './db/service/registration-db-service.js';
import { RegistrationService } from './service/registration-service.js';
import { ReviewRepository } from './db/raw/repository/review-repository.js';
import { ReviewDbService } from './db/service/review-db-service.js';
import { ReviewService } from './service/review-service.js';
import { ReviewProcess } from './process/review-process.js';
import { ClientRepository } from './db/raw/repository/client-repository.js';
import { ClientDbService } from './db/service/client-db-service.js';
import { ClientService } from './service/client-service.js';
import { CandidateRepository } from './db/raw/repository/candidate-repository.js';
import { CandidateDbService } from './db/service/candidate-db-service.js';
import { CandidateService } from './service/candidate-service.js';
import { MatchRepository } from './db/raw/repository/match-repository.js';
import { MatchDbService } from './db/service/match-db-service.js';
import { MatchService } from './service/match-service.js';
import { MatchProcess } from './process/match-process.js';
import { ConnectionRepository } from './db/raw/repository/connection-repository.js';
import { ConnectionDbService } from './db/service/connection-db-service.js';
import { ConnectionService } from './service/connection-service.js';
import type { ProfileActor } from './service/profile-service.js';
import { listenClientFor, NotificationHub } from './notify/notification-hub.js';
import { EventDeliveryProcess } from './process/event-delivery-process.js';
/** The console driver is for development only: the configuration refuses it in production. */
function createMailer(config: AppConfig): Mailer {
  if (config.MAIL_DRIVER === 'console')
    return new ConsoleMailer((text) =>
      process.stdout.write(`${text}
`),
    );
  return new SmtpMailer({
    host: config.SMTP_HOST!,
    port: config.SMTP_PORT,
    tls: config.SMTP_TLS,
    ...(config.SMTP_USER && config.SMTP_PASSWORD
      ? { user: config.SMTP_USER, password: config.SMTP_PASSWORD }
      : {}),
    from: config.MAIL_FROM!,
    timeoutMs: config.IO_TIMEOUT_MS * 2,
  });
}
export async function createApiContainer(config: AppConfig, logger: Logger) {
  const db = createDatabase(config, logger);
  const redis = createRedis(config, logger);
  try {
    await db.ready();
    await redis.connect();
    const storage = createFileStorage(config);
    const profiles = new ProfileService(
      new ProfileDbService(db, new ProfileRepository(), new EventRepository()),
    );
    const candidates = new CandidateService(
      new CandidateDbService(db, new CandidateRepository(), new EventRepository()),
      logger,
    );
    const connections = new ConnectionService(
      new ConnectionDbService(
        db,
        new ConnectionRepository(),
        new MatchRepository(),
        new CandidateRepository(),
        new EventRepository(),
      ),
    );
    // One database connection listens for every account's live notifications.
    const hub = new NotificationHub(listenClientFor(config.DATABASE_URL), logger);
    const identities = new IdentityService(
      new IdentityDbService(db, new IdentityRepository()),
      config.TENANT_HOSTS,
    );
    const box = new SecretBox(config.SESSION_ENCRYPTION_KEY);
    const sessions = new SessionRepository(redis);
    const throttle = new ThrottleRepository(redis);
    const credentials = new CredentialService(
      new CredentialDbService(db, new CredentialRepository(), new EventRepository()),
      new PasswordHasher(),
      logger,
    );
    const accessTokens = new AccessTokens(parseSigningKey(config.AUTH_JWT_PRIVATE_KEY));
    const auth = new AuthProcess(
      credentials,
      accessTokens,
      sessions,
      identities,
      throttle,
      new EventDbService(db, new EventRepository()),
      {
        sessionTtl: config.SESSION_TTL_SECONDS,
        accessTtl: config.ACCESS_TOKEN_TTL_SECONDS,
        maxSessions: config.MAX_SESSIONS_PER_ACCOUNT,
        deviceSessionTtl: config.DEVICE_SESSION_TTL_SECONDS,
      },
    );
    const registrations = new RegistrationService(
      new RegistrationDbService(db, new RegistrationRepository(), new EventRepository()),
    );
    const oneTimeTokens = new OneTimeTokenRepository(redis);
    // The agency's own terms and privacy text; a registration records the version shown when the person agreed.
    const legal = new LegalService(
      new LegalDbService(db, new LegalRepository(), new EventRepository()),
    );
    const legalVersions = (agencyId: string) => legal.versions(agencyId);
    const agreements = new AgreementService(
      new AgreementDbService(db, new AgreementRepository(), new EventRepository()),
      legalVersions,
    );
    // Phone sign-in is on only when a way to send the codes is configured.
    const phone =
      config.SMS_DRIVER === 'console'
        ? new PhoneAuthProcess(
            new ConsoleSmsSender((text) => process.stdout.write(`${text}\n`)),
            new PhoneCodeRepository(redis),
            throttle,
            oneTimeTokens,
            registrations,
            credentials,
            auth,
            box,
            logger,
            config.SMS_ALLOWED_COUNTRIES,
            legalVersions,
          )
        : undefined;
    const mailer = createMailer(config);
    const invitations = new StaffInvitationProcess(
      new StaffInvitationService(
        new StaffInvitationDbService(
          db,
          new StaffInvitationRepository(),
          new RegistrationRepository(),
          new EventRepository(),
        ),
      ),
      credentials,
      auth,
      throttle,
      mailer,
      logger,
    );
    const clientLogins = new ClientLoginProcess(
      new ClientLoginService(
        new ClientLoginDbService(
          db,
          new ClientLoginRepository(),
          new RegistrationRepository(),
          new EventRepository(),
        ),
        legalVersions,
      ),
      credentials,
      auth,
      throttle,
      mailer,
      // Texts go out only where a sender is set up, the same condition as phone sign-in.
      config.SMS_DRIVER === 'console'
        ? new ConsoleSmsSender((text) =>
            process.stdout.write(`${text}
`),
          )
        : undefined,
      logger,
    );
    const guardians = new GuardianProcess(
      new GuardianService(
        new GuardianDbService(
          db,
          new GuardianRepository(),
          new RegistrationRepository(),
          new EventRepository(),
        ),
        undefined,
        undefined,
        legalVersions,
      ),
      credentials,
      auth,
      throttle,
      mailer,
      logger,
    );
    const access = new AccountAccessProcess(
      registrations,
      credentials,
      oneTimeTokens,
      throttle,
      sessions,
      auth,
      mailer,
      box,
      logger,
      phone,
      legalVersions,
    );
    // Sign-in with Google is on only when both settings are given.
    const google =
      config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET
        ? new GoogleAuthProcess(
            new GoogleProvider({
              clientId: config.GOOGLE_CLIENT_ID,
              clientSecret: config.GOOGLE_CLIENT_SECRET,
              timeoutMs: config.IO_TIMEOUT_MS,
            }),
            sessions,
            oneTimeTokens,
            registrations,
            credentials,
            auth,
            box,
            logger,
            legalVersions,
          )
        : undefined;
    await hub.start();
    const chats = new ChatService(
      new ChatDbService(db, new ChatRepository(), new EventRepository()),
    );
    const deletions = new AccountDeletionProcess(
      new AccountDeletionDbService(db, new AccountDeletionRepository()),
      auth,
      sessions,
      storage,
      new EventDbService(db, new EventRepository()),
      logger,
      chats,
    );
    // Push: phones may always register; a push is sent only where a sender is set up.
    const pushDb = new PushDbService(db, new PushRepository());
    const push = new PushProcess(
      pushDb,
      new ConsolePushSender((text) => process.stdout.write(`${text}\n`)),
      async (agencyId) => (await identities.tenantById(agencyId)).name,
      logger,
    );
    if (config.PUSH_DRIVER === 'console')
      hub.onAny((signal) => void push.dispatch(signal.agencyId, signal.accountId));
    const siteContent = new SiteContentService(
      new SiteContentDbService(db, new SiteContentRepository(), new EventRepository()),
      storage,
      undefined,
      undefined,
      new PreviewRepository(redis),
    );
    // Signing in again within the waiting time cancels a deletion.
    auth.afterSignIn = (agencyId, accountId) =>
      deletions.cancelOnSignIn(agencyId, accountId).catch(() => undefined);
    return {
      config,
      logger,
      redis,
      identities,
      auth,
      access,
      invitations,
      clientLogins,
      guardians,
      mobile: new MobileService(identities, config, siteContent),
      deletions,
      push,
      reports: new ReportService(db, new ReportRepository()),
      chats,
      payments: new PaymentService(
        new PaymentDbService(db, new PaymentRepository(), new EventRepository()),
        storage,
        logger,
      ),
      settings: new SettingsService(
        new SettingsDbService(db, new SettingsRepository(), new EventRepository()),
      ),
      declines: new DeclineService(new DeclineDbService(db, new DeclineRepository())),
      privacy: new PrivacyService(
        new PrivacyDbService(db, new PrivacyRepository(), new EventRepository()),
        deletions,
      ),
      concerns: new ConcernService(
        new ConcernDbService(db, new ConcernRepository(), new EventRepository()),
      ),
      attention: new AttentionService(new AttentionDbService(db, new AttentionRepository())),
      journey: new JourneyService(new JourneyDbService(db, new JourneyRepository())),
      serviceTerms: new ServiceTermsService(
        new ServiceTermsDbService(db, new ServiceTermsRepository(), new EventRepository()),
      ),
      activity: new ActivityService(db, new ActivityRepository()),
      siteContent,
      legal,
      agreements,
      coupleMatches: new CoupleMatchService(
        new CoupleMatchDbService(db, new CoupleMatchRepository(), new EventRepository()),
      ),
      meetings: new MeetingService(
        new MeetingDbService(db, new MeetingRepository(), new EventRepository()),
      ),
      verification: new VerificationService(
        new VerificationDbService(db, new VerificationRepository(), new EventRepository()),
        storage,
        logger,
      ),
      google,
      phone,
      registrations,
      cvs: new CvProcess(
        new CvService(new CvDbService(db, new CvRepository(), new EventRepository())),
        storage,
        logger,
      ),
      photos: new PhotoProcess(
        new PhotoService(new PhotoDbService(db, new PhotoRepository(), new EventRepository())),
        storage,
        processImage,
        logger,
      ),
      profiles,
      reviews: new ReviewProcess(
        new ReviewService(
          new ReviewDbService(
            db,
            new ReviewRepository(),
            new ProfileRepository(),
            new EventRepository(),
          ),
        ),
        storage,
        candidates,
        logger,
      ),
      candidates,
      connections,
      live: {
        subscribe: (agencyId: string, accountId: string, listener: () => void) =>
          hub.subscribe(agencyId, accountId, () => listener()),
        unread: (actor: ProfileActor) => connections.unreadCount(actor),
      },
      matches: new MatchProcess(
        new MatchService(new MatchDbService(db, new MatchRepository(), new CandidateRepository())),
        storage,
      ),
      clients: new ClientService(
        new ClientDbService(db, new ClientRepository(), new EventRepository()),
        profiles,
      ),
      ready: async () => {
        await db.ping();
        await redis.ping();
      },
      close: async () => {
        await hub.stop();
        await access.idle();
        await invitations.idle();
        await clientLogins.idle();
        await guardians.idle();
        await phone?.idle();
        redis.disconnect();
        await db.close();
      },
    };
  } catch (error) {
    redis.disconnect();
    await db.close();
    throw error;
  }
}
export async function createWorkerContainer(config: AppConfig, logger: Logger) {
  const db = createDatabase(config, logger);
  const mongo = createMongo(config);
  try {
    await db.ready();
    await mongo.connect();
    const repository = new MongoEventRepository(
      mongo.db(config.MONGO_DATABASE).collection<EventDocument>('workflow_events'),
    );
    await repository.ready();
    return {
      delivery: new EventDeliveryProcess(
        new EventDbService(db, new EventRepository()),
        new MongoEventService(repository),
        logger,
        config.EVENT_MAX_ATTEMPTS,
      ),
      close: async () => {
        await mongo.close();
        await db.close();
      },
    };
  } catch (error) {
    await mongo.close();
    await db.close();
    throw error;
  }
}
