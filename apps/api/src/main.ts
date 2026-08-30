/**
 * API entry point.
 */

import { buildServer } from './server.js';
import { describeAdapters, loadConfig } from './config.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildServer({ config });

  await app.listen({ port: config.API_PORT, host: config.API_HOST });

  // The adapter line is deliberately prominent. If it says `payments=mock`,
  // nothing here has ever charged a real card.
  app.log.info(
    `DASH APP API on http://${config.API_HOST}:${config.API_PORT}  [${describeAdapters(config)}]`,
  );
  if (config.PAYMENT_PROVIDER === 'mock') {
    app.log.warn('Payments are MOCKED. No real money moves in this configuration.');
  }
  if (config.DEV_EXPOSE_OTP) {
    app.log.warn('DEV_EXPOSE_OTP is on. Login codes are printed to this console.');
  }

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`${signal} received, shutting down`);
    try {
      await app.services.queue.close();
      await app.close();
      await app.services.prisma.$disconnect();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'shutdown failed');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  console.error('\nAPI failed to start:\n');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
