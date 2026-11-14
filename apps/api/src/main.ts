import './env.js';
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
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

@Module({ imports: [CoreModule, ProjectsModule, SpecModule, ConnectionsModule, BuildsModule, CodexAuthModule, TestCasesModule, GenerationModule, DeploymentsModule] })
class AppModule {}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  // Deployed MCP servers: mounted before the body parser so requests stream through untouched.
  app.use('/mcp', mcpProxy(app.get(PrismaService), app.get(DeploymentManager)));
  app.useBodyParser('json', { limit: '6mb' });
  app.setGlobalPrefix('api');
  app.enableCors({ origin: config.webOrigin.split(',') });
  app.enableShutdownHooks();
  await app.listen(config.port);
  console.log(`MCP Builder API on http://localhost:${config.port}/api · data: ${config.dataDir} · codex model: ${config.codexModel}`);
}

void bootstrap();
