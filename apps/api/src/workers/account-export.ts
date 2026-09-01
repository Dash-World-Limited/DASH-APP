/**
 * Account-export worker.
 *
 * Consumes `account.export.build`: gathers a subject's own data into one JSON
 * archive, stores it via `ExportArchivePort`, and moves the request to `ready`
 * with an expiry. The heavy read is off the request path so a large history
 * does not stall the API.
 *
 * Failures are recorded on the request as `failed` with a bounded reason — the
 * worker does not throw, so one bad export cannot wedge the queue.
 */

import type { PrismaClient } from '@dash/db';
import type { ExportArchivePort, QueuePort } from '@dash/domain/ports';
import type { FastifyBaseLogger } from 'fastify';
import { buildDataExport } from '../account/export.js';

export interface BuildExportJob {
  requestId: string;
}

export function registerAccountExportWorker(deps: {
  prisma: PrismaClient;
  queue: QueuePort;
  archive: ExportArchivePort;
  ttlHours: number;
  log: FastifyBaseLogger;
}): void {
  const { prisma, queue, archive, ttlHours, log } = deps;

  queue.process<BuildExportJob>('account.export.build', async (job) => {
    const result = await buildDataExport(prisma, archive, {
      requestId: job.payload.requestId,
      ttlHours,
    });

    log.info(
      { requestId: job.payload.requestId, status: result.status, sizeBytes: result.view.sizeBytes },
      'account export build finished',
    );
  });
}
