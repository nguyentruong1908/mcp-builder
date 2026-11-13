import { BadRequestException, Body, Controller, Delete, Get, Module, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import type { TestCaseDto } from '@mcp-factory/shared';
import { AuditService } from '../core/core.services.js';
import { PrismaService } from '../core/prisma.service.js';
import { parse } from '../core/util.js';
import type { Prisma, TestCase } from '../generated/prisma/client.js';

const CATEGORIES = ['input', 'auth', 'not_found', 'conflict', 'rate_limited', 'client', 'server', 'timeout', 'network', 'response'] as const;
const strList = z.array(z.string().trim().min(1).max(500)).max(20);

const base = z.object({
  kind: z.enum(['tool_call', 'agent_task']),
  name: z.string().trim().min(1).max(200),
  enabled: z.boolean().default(true),
  tool: z.string().max(64).nullable().default(null),
  args: z.record(z.string(), z.unknown()).nullable().default(null),
  target: z.enum(['mock', 'live']).default('mock'),
  mockResponse: z.object({ status: z.number().int().min(100).max(599), body: z.unknown().optional() }).nullable().default(null),
  expect: z.object({ isError: z.boolean().optional(), category: z.enum(CATEGORIES).optional(), contains: strList.optional() }).strict().default({}),
  task: z.string().trim().max(2000).nullable().default(null),
  expectedTools: strList.default([]),
  answerContains: strList.default([]),
}).strict();

function check(v: z.infer<typeof base>) {
  if (v.kind === 'tool_call' && !v.tool) throw new BadRequestException('Test case gọi tool cần chọn tool');
  if (v.kind === 'agent_task' && !v.task) throw new BadRequestException('Test case tác vụ agent cần nội dung tác vụ');
  if (v.kind === 'tool_call' && v.mockResponse && v.target !== 'mock') throw new BadRequestException('Response giả lập chỉ dùng với target mock');
  if (JSON.stringify(v.args ?? {}).length > 20_000 || JSON.stringify(v.mockResponse ?? {}).length > 50_000) throw new BadRequestException('args/mockResponse quá lớn');
}

const toData = (v: z.infer<typeof base>) => ({
  ...v,
  args: (v.args ?? undefined) as Prisma.InputJsonValue | undefined,
  mockResponse: (v.mockResponse ?? undefined) as Prisma.InputJsonValue | undefined,
  expect: v.expect as Prisma.InputJsonValue,
});

export function toTestCaseDto(t: TestCase): TestCaseDto {
  return {
    id: t.id,
    kind: t.kind as TestCaseDto['kind'],
    name: t.name,
    enabled: t.enabled,
    tool: t.tool,
    args: (t.args as Record<string, unknown> | null) ?? null,
    target: t.target as TestCaseDto['target'],
    mockResponse: (t.mockResponse as TestCaseDto['mockResponse']) ?? null,
    expect: (t.expect as TestCaseDto['expect']) ?? {},
    task: t.task,
    expectedTools: t.expectedTools,
    answerContains: t.answerContains,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

@Controller()
export class TestCasesController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  @Get('projects/:id/test-cases')
  async list(@Param('id') projectId: string): Promise<TestCaseDto[]> {
    return (await this.prisma.testCase.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } })).map(toTestCaseDto);
  }

  @Post('projects/:id/test-cases')
  async create(@Param('id') projectId: string, @Body() body: unknown): Promise<TestCaseDto> {
    const v = parse(base, body);
    check(v);
    if (!(await this.prisma.project.findUnique({ where: { id: projectId } }))) throw new NotFoundException('Project không tồn tại');
    const t = await this.prisma.testCase.create({ data: { ...toData(v), projectId } });
    await this.audit.log('testcase.create', v.name, { projectId });
    return toTestCaseDto(t);
  }

  @Patch('test-cases/:id')
  async update(@Param('id') id: string, @Body() body: unknown): Promise<TestCaseDto> {
    const cur = await this.prisma.testCase.findUnique({ where: { id } });
    if (!cur) throw new NotFoundException('Test case không tồn tại');
    const merged = parse(base, { ...toTestCaseDto(cur), id: undefined, createdAt: undefined, updatedAt: undefined, ...(body as object) });
    check(merged);
    const t = await this.prisma.testCase.update({ where: { id }, data: toData(merged) });
    await this.audit.log('testcase.update', t.name, { projectId: t.projectId });
    return toTestCaseDto(t);
  }

  @Delete('test-cases/:id')
  async remove(@Param('id') id: string) {
    const t = await this.prisma.testCase.delete({ where: { id } }).catch(() => { throw new NotFoundException('Test case không tồn tại'); });
    await this.audit.log('testcase.delete', t.name, { projectId: t.projectId });
    return { ok: true };
  }
}

@Module({ controllers: [TestCasesController] })
export class TestCasesModule {}
