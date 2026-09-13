import { env } from './config/env.js';
import { createGoogleSheetsClient } from './integrations/google-sheets-client.js';
import { createHolodexClient } from './integrations/holodex-client.js';
import { createResendClient } from './integrations/resend-client.js';
import { createYouTubeClient } from './integrations/youtube-client.js';
import { createPostgresStateStore } from './repositories/postgres-state-store.js';
import { createMonitorService } from './services/monitor-service.js';
import { createNotificationService } from './services/notification-service.js';
import { startMonitorScheduler } from './services/monitor-scheduler.js';
import { createApiServer } from './web/api-server.js';

const stateStore = createPostgresStateStore();
const sheetsClient = createGoogleSheetsClient();
const notificationService = createNotificationService({ stateStore, emailClient: createResendClient() });
const monitorService = createMonitorService({
  stateStore,
  sheetsClient,
  holodexClient: createHolodexClient(),
  youtubeClient: createYouTubeClient(),
  notificationService
});
const server = createApiServer({ stateStore, sheetsClient, staticDir: process.cwd() });

await stateStore.migrate();

server.listen(env.port, () => {
  console.log(`Web service listening on port ${env.port}`);
});

const stopScheduler = startMonitorScheduler({ monitorService });
async function shutdown() {
  stopScheduler();
  await new Promise((resolve) => server.close(resolve));
  await stateStore.close();
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

