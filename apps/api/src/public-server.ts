import type { FastifyInstance } from 'fastify';
import { buildServer, type BuildOptions } from './server.js';
import { registerRegistrationRoutes } from './routes/registration.js';

/**
 * Runtime API builder used by the deployed app.
 *
 * The core server remains unchanged while the public registration flow is
 * developed and tested on this feature branch. Production entry points should
 * use this builder so Declutters can create new customer accounts.
 */
export async function buildPublicServer(options: BuildOptions = {}): Promise<FastifyInstance> {
  const app = await buildServer(options);
  await registerRegistrationRoutes(app);
  return app;
}
