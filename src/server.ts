import type { Server } from 'node:http';
import { createV1Modules } from './api/v1/modules.js';
import { createApp } from './app.js';
import { ConfigError, loadConfig, type Config } from './config/env.js';
import { applyServerTimeouts } from './http/server-timeouts.js';
import { createLogger, type Logger } from './lib/logger.js';
import { createPrismaClient, type PrismaClient } from './lib/prisma.js';
import { createHealthRepository } from './modules/health/health.repository.js';
import { createHealthService } from './modules/health/health.service.js';
import { createUsersRepository } from './modules/users/users.repository.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

function loadConfigOrExit(): Config {
  try {
    return loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      // The logger depends on config, so report directly to stderr.
      process.stderr.write(
        `Invalid environment configuration:\n${error.issues.map((issue) => `  - ${issue}`).join('\n')}\n`,
      );
      process.exit(1);
    }
    throw error;
  }
}

function registerShutdown(
  server: Server,
  prisma: PrismaClient,
  logger: Logger,
): void {
  let shuttingDown = false;

  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');

    // Forces exit if open connections keep the server from closing in time.
    setTimeout(() => {
      logger.error('Shutdown timed out, forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();

    server.close((closeError) => {
      prisma
        .$disconnect()
        .catch((error: unknown) => {
          logger.error({ err: error }, 'Failed to disconnect from database');
        })
        .finally(() => {
          process.exit(closeError === undefined ? 0 : 1);
        });
    });
  };

  // SIGTERM is what hosting platforms send; SIGINT covers Ctrl+C, including
  // on Windows where SIGTERM is never delivered.
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

function main(): void {
  const config = loadConfigOrExit();
  const logger = createLogger({
    level: config.logLevel,
    nodeEnv: config.nodeEnv,
  });

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'Unhandled promise rejection');
    process.exit(1);
  });
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'Uncaught exception');
    process.exit(1);
  });

  const prisma = createPrismaClient(config.databaseUrl);
  const healthService = createHealthService({
    repository: createHealthRepository(prisma),
    logger,
  });
  const app = createApp({
    config,
    logger,
    healthService,
    authSubjects: createUsersRepository(prisma),
    v1Modules: createV1Modules({ prisma, logger }),
  });

  const server = app.listen(config.port, (error) => {
    if (error !== undefined) {
      logger.fatal({ err: error }, 'Failed to start HTTP server');
      process.exit(1);
    }
    logger.info(
      { port: config.port, nodeEnv: config.nodeEnv },
      'Sparrow API listening',
    );
  });
  applyServerTimeouts(server);

  registerShutdown(server, prisma, logger);
}

main();
