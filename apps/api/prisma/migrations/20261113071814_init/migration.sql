-- CreateEnum
CREATE TYPE "Impact" AS ENUM ('read', 'write', 'side_effect', 'destructive');

-- CreateEnum
CREATE TYPE "VersionStatus" AS ENUM ('draft', 'released', 'deprecated');

-- CreateEnum
CREATE TYPE "BuildStatus" AS ENUM ('queued', 'running', 'succeeded', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "QaStatus" AS ENUM ('pass', 'fail', 'blocked', 'not_run');

-- CreateEnum
CREATE TYPE "AuthType" AS ENUM ('none', 'api_key', 'bearer');

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "owner" TEXT NOT NULL DEFAULT 'system',
    "outputs" JSONB NOT NULL DEFAULT '{"mcp":true,"cli":true}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SpecSnapshot" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "filename" TEXT,
    "raw" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "oasVersion" TEXT NOT NULL,
    "apiVersion" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "operations" JSONB NOT NULL,
    "issues" JSONB NOT NULL,
    "securitySchemes" JSONB NOT NULL,
    "servers" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SpecSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectContext" (
    "projectId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT '',
    "sampleTasks" TEXT NOT NULL DEFAULT '',
    "businessRules" TEXT NOT NULL DEFAULT '',
    "dataFormats" TEXT NOT NULL DEFAULT '',
    "accessScope" TEXT NOT NULL DEFAULT '',
    "impacts" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "expectedResults" TEXT NOT NULL DEFAULT '',
    "freeform" TEXT NOT NULL DEFAULT '',
    "glossary" JSONB NOT NULL DEFAULT '[]',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectContext_pkey" PRIMARY KEY ("projectId")
);

-- CreateTable
CREATE TABLE "ToolDefinition" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "tag" TEXT NOT NULL DEFAULT 'default',
    "operationId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "impact" "Impact" NOT NULL DEFAULT 'read',
    "requireConfirm" BOOLEAN NOT NULL DEFAULT false,
    "selected" BOOLEAN NOT NULL DEFAULT false,
    "unsupportedReason" TEXT,
    "inputSchema" JSONB NOT NULL,
    "params" JSONB NOT NULL,
    "responseSchema" JSONB,
    "present" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ToolDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Connection" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "authType" "AuthType" NOT NULL DEFAULT 'none',
    "authHeader" TEXT NOT NULL DEFAULT 'X-Api-Key',
    "secretRef" TEXT NOT NULL DEFAULT '',
    "allowWrite" BOOLEAN NOT NULL DEFAULT false,
    "useForQa" BOOLEAN NOT NULL DEFAULT false,
    "lastCheck" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Connection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Version" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "status" "VersionStatus" NOT NULL DEFAULT 'draft',
    "apiVersion" TEXT NOT NULL DEFAULT '',
    "specSnapshotId" TEXT,
    "contextSnapshot" JSONB,
    "toolsSnapshot" JSONB,
    "changelog" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMP(3),
    "deprecatedAt" TIMESTAMP(3),

    CONSTRAINT "Version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Build" (
    "id" TEXT NOT NULL,
    "seq" SERIAL NOT NULL,
    "projectId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "status" "BuildStatus" NOT NULL DEFAULT 'queued',
    "stage" TEXT,
    "stages" JSONB NOT NULL DEFAULT '{"spec":"idle","codex":"idle","build":"idle","qa":"idle","package":"idle"}',
    "runIntegration" BOOLEAN NOT NULL DEFAULT true,
    "packageVerified" BOOLEAN,
    "integrationVerified" TEXT,
    "repairRounds" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "cachedInputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "provenance" JSONB NOT NULL DEFAULT '{}',
    "limits" JSONB NOT NULL DEFAULT '{}',
    "codexThreadId" TEXT,
    "error" TEXT,
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "triggeredBy" TEXT NOT NULL DEFAULT 'system',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "Build_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuildLog" (
    "id" SERIAL NOT NULL,
    "buildId" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "level" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "message" TEXT NOT NULL,

    CONSTRAINT "BuildLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QaResult" (
    "id" TEXT NOT NULL,
    "buildId" TEXT NOT NULL,
    "layer" TEXT NOT NULL,
    "tool" TEXT,
    "name" TEXT NOT NULL,
    "status" "QaStatus" NOT NULL,
    "detail" TEXT NOT NULL DEFAULT '',
    "evidence" JSONB,

    CONSTRAINT "QaResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Artifact" (
    "id" TEXT NOT NULL,
    "buildId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Artifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "meta" JSONB,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "Project_slug_key" ON "Project"("slug");

-- CreateIndex
CREATE INDEX "SpecSnapshot_projectId_createdAt_idx" ON "SpecSnapshot"("projectId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ToolDefinition_projectId_method_path_key" ON "ToolDefinition"("projectId", "method", "path");

-- CreateIndex
CREATE UNIQUE INDEX "Connection_projectId_name_key" ON "Connection"("projectId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Version_projectId_number_key" ON "Version"("projectId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "Build_seq_key" ON "Build"("seq");

-- CreateIndex
CREATE INDEX "Build_status_createdAt_idx" ON "Build"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Build_projectId_createdAt_idx" ON "Build"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "BuildLog_buildId_id_idx" ON "BuildLog"("buildId", "id");

-- CreateIndex
CREATE INDEX "QaResult_buildId_idx" ON "QaResult"("buildId");

-- CreateIndex
CREATE INDEX "AuditLog_at_idx" ON "AuditLog"("at");

-- AddForeignKey
ALTER TABLE "SpecSnapshot" ADD CONSTRAINT "SpecSnapshot_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectContext" ADD CONSTRAINT "ProjectContext_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolDefinition" ADD CONSTRAINT "ToolDefinition_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Connection" ADD CONSTRAINT "Connection_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Version" ADD CONSTRAINT "Version_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Version" ADD CONSTRAINT "Version_specSnapshotId_fkey" FOREIGN KEY ("specSnapshotId") REFERENCES "SpecSnapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Build" ADD CONSTRAINT "Build_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Build" ADD CONSTRAINT "Build_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "Version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuildLog" ADD CONSTRAINT "BuildLog_buildId_fkey" FOREIGN KEY ("buildId") REFERENCES "Build"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QaResult" ADD CONSTRAINT "QaResult_buildId_fkey" FOREIGN KEY ("buildId") REFERENCES "Build"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_buildId_fkey" FOREIGN KEY ("buildId") REFERENCES "Build"("id") ON DELETE CASCADE ON UPDATE CASCADE;
