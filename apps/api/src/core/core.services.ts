import { Global, Injectable, Module } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import type { BuildEvent, SettingsDto } from '@mcp-builder/shared';
import { config, DEFAULT_SETTINGS } from '../config.js';
import { PrismaService } from './prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  log(action: string, target: string, meta?: Record<string, unknown>, actor = 'system') {
    return this.prisma.auditLog.create({ data: { actor, action, target, meta: (meta ?? undefined) as Prisma.InputJsonValue | undefined } });
  }
}

@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async get(): Promise<SettingsDto> {
    const row = await this.prisma.setting.findUnique({ where: { key: 'limits' } });
    return { ...DEFAULT_SETTINGS, ...((row?.value as object) ?? {}), codexModel: config.codexModel };
  }

  async update(patch: Partial<typeof DEFAULT_SETTINGS>): Promise<SettingsDto> {
    const { codexModel: _ignored, ...current } = await this.get();
    const value = { ...current, ...patch };
    await this.prisma.setting.upsert({ where: { key: 'limits' }, create: { key: 'limits', value }, update: { value } });
    return this.get();
  }
}

/** In-process pub/sub for build progress (the worker runs inside the API process). */
@Injectable()
export class BuildEvents {
  private readonly emitter = new EventEmitter().setMaxListeners(0);
  emit(buildId: string, event: BuildEvent) { this.emitter.emit(buildId, event); }
  on(buildId: string, fn: (e: BuildEvent) => void) {
    this.emitter.on(buildId, fn);
    return () => this.emitter.off(buildId, fn);
  }
}

@Global()
@Module({ providers: [PrismaService, AuditService, SettingsService, BuildEvents], exports: [PrismaService, AuditService, SettingsService, BuildEvents] })
export class CoreModule {}
