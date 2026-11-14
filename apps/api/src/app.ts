import './env.js';
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AuthModule } from './auth/auth.module.js';
import { authMiddleware, SessionService } from './auth/sessions.js';
import { BuildsModule } from './builds/builds.module.js';
import { CodexAuthModule } from './codex/codex-auth.module.js';
import { TestCasesModule } from './testcases/test-cases.module.js';
import { GenerationModule } from './generation/generation.module.js';
import { config } from './config.js';
import { ConnectionsModule } from './connections/connections.module.js';
import { CoreModule } from './core/core.services.js';
import { ProjectsModule } from './projects/projects.module.js';
import { SpecModule } from './spec/spec.module.js';
import { DeploymentManager, DeploymentsModule, mcpProxy } from './deployments/deployments.module.js';
import { PrismaService } from './core/prisma.service.js';

@Module({ imports: [CoreModule, AuthModule, ProjectsModule, SpecModule, ConnectionsModule, BuildsModule, CodexAuthModule, TestCasesModule, GenerationModule, DeploymentsModule] })
class AppModule {}

/** The configured API, not yet listening (main.ts listens; e2e tests listen on a random port). */
export async function createApp(): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  // Deployed MCP servers: mounted before the body parser so requests stream through untouched (and outside sign-in).
  app.use('/mcp', mcpProxy(app.get(PrismaService), app.get(DeploymentManager)));
  app.use('/api', authMiddleware(app.get(SessionService)));
  app.useBodyParser('json', { limit: '6mb' });
  app.setGlobalPrefix('api');
  app.enableCors({ origin: config.webOrigin.split(','), credentials: true });
  app.enableShutdownHooks();
  return app;
}
