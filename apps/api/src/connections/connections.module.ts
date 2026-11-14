import { BadRequestException, Body, Controller, Delete, Get, Module, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import type { ConnectionCheck, ConnectionDto } from '@mcp-builder/shared';
import { AuditService } from '../core/core.services.js';
import { toConnectionDto } from '../core/mappers.js';
import { PrismaService } from '../core/prisma.service.js';
import { parse, resolveSecret } from '../core/util.js';
import type { Connection } from '../generated/prisma/client.js';

const fields = {
  name: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/i, 'Environment name: letters, digits, - or _ (up to 32)'),
  baseUrl: z.string().url().refine((u) => /^https?:/.test(u), 'Only http/https is supported'),
  authType: z.enum(['none', 'api_key', 'bearer']),
  authHeader: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
  // Only references are stored. A literal token here would be a secret leak.
  secretRef: z.string().max(200).refine((s) => s === '' || /^env:\/\/[A-Za-z_][A-Za-z0-9_]*$/.test(s), 'secretRef must look like env://VAR_NAME'),
  allowWrite: z.boolean(),
  agentAccess: z.enum(['read_only', 'write', 'write_destructive']),
  useForQa: z.boolean(),
};
const createSchema = z.object({
  ...fields,
  authHeader: fields.authHeader.default('X-Api-Key'),
  allowWrite: fields.allowWrite.default(false),
  agentAccess: fields.agentAccess.default('read_only'),
  useForQa: fields.useForQa.default(false),
}).strict();
// No defaults here: a PATCH must only touch the fields it sends (zod applies .default() even inside .partial()).
const updateSchema = z.object(fields).partial().strict();

// Agent eval may only change data on an environment that allows writes.
function checkAgentAccess(v: { allowWrite?: boolean; agentAccess?: string }) {
  if (v.agentAccess && v.agentAccess !== 'read_only' && !v.allowWrite) throw new BadRequestException('Letting the agent write/delete requires "Allow writes" on the environment');
}

export function authHeaders(c: Pick<Connection, 'authType' | 'authHeader' | 'secretRef'>): Record<string, string> {
  const secret = resolveSecret(c.secretRef);
  if (c.authType === 'bearer' && secret) return { authorization: `Bearer ${secret}` };
  if (c.authType === 'api_key' && secret) return { [c.authHeader]: secret };
  return {};
}

@Controller()
export class ConnectionsController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  @Get('projects/:id/connections')
  async list(@Param('id') projectId: string): Promise<ConnectionDto[]> {
    return (await this.prisma.connection.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } })).map(toConnectionDto);
  }

  @Post('projects/:id/connections')
  async create(@Param('id') projectId: string, @Body() body: unknown): Promise<ConnectionDto> {
    const input = parse(createSchema, body);
    if (input.authType !== 'none' && !input.secretRef) throw new BadRequestException('This auth type needs a secretRef');
    checkAgentAccess(input);
    if (await this.prisma.connection.findUnique({ where: { projectId_name: { projectId, name: input.name } } })) throw new BadRequestException(`Environment "${input.name}" already exists`);
    const c = await this.prisma.$transaction(async (tx) => {
      if (input.useForQa) await tx.connection.updateMany({ where: { projectId }, data: { useForQa: false } });
      return tx.connection.create({ data: { ...input, projectId } });
    });
    await this.audit.log('connection.create', `${input.name} → ${input.baseUrl}`, { projectId });
    return toConnectionDto(c);
  }

  @Patch('connections/:id')
  async update(@Param('id') id: string, @Body() body: unknown): Promise<ConnectionDto> {
    const input = parse(updateSchema, body);
    const cur = await this.prisma.connection.findUnique({ where: { id } });
    if (!cur) throw new NotFoundException('Environment not found');
    // Turning writes off also revokes the agent's data-changing access.
    if (input.allowWrite === false) input.agentAccess = 'read_only';
    checkAgentAccess({ allowWrite: input.allowWrite ?? cur.allowWrite, agentAccess: input.agentAccess ?? cur.agentAccess });
    const c = await this.prisma.$transaction(async (tx) => {
      if (input.useForQa) await tx.connection.updateMany({ where: { projectId: cur.projectId, NOT: { id } }, data: { useForQa: false } });
      return tx.connection.update({ where: { id }, data: input });
    });
    await this.audit.log('connection.update', c.name, { projectId: c.projectId, fields: Object.keys(input) });
    return toConnectionDto(c);
  }

  @Delete('connections/:id')
  async remove(@Param('id') id: string) {
    const c = await this.prisma.connection.delete({ where: { id } }).catch(() => { throw new NotFoundException('Environment not found'); });
    await this.audit.log('connection.delete', c.name, { projectId: c.projectId });
    return { ok: true };
  }

  @Post('connections/:id/test')
  async test(@Param('id') id: string): Promise<ConnectionDto> {
    const c = await this.prisma.connection.findUnique({ where: { id } });
    if (!c) throw new NotFoundException('Environment not found');
    const started = Date.now();
    let check: ConnectionCheck;
    if (c.authType !== 'none' && !resolveSecret(c.secretRef)) {
      check = { ok: false, message: `Secret ${c.secretRef || '(empty)'} is not configured on the server`, at: new Date().toISOString() };
    } else {
      try {
        const res = await fetch(c.baseUrl, { headers: authHeaders(c), redirect: 'manual', signal: AbortSignal.timeout(5000) });
        const authFail = res.status === 401 || res.status === 403;
        check = {
          ok: !authFail && res.status < 500,
          status: res.status,
          latencyMs: Date.now() - started,
          message: authFail ? 'Reachable, but authentication was rejected' : res.status >= 500 ? 'The server returned 5xx' : 'Reachable',
          at: new Date().toISOString(),
        };
      } catch (err) {
        check = { ok: false, latencyMs: Date.now() - started, message: `Cannot connect: ${(err as Error).message}`, at: new Date().toISOString() };
      }
    }
    return toConnectionDto(await this.prisma.connection.update({ where: { id }, data: { lastCheck: check as object } }));
  }
}

@Module({ controllers: [ConnectionsController] })
export class ConnectionsModule {}
