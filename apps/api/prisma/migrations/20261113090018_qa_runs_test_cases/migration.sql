-- AlterTable
ALTER TABLE "Build" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'export',
ADD COLUMN     "sourceBuildId" TEXT,
ADD COLUMN     "sourceBuildLabel" TEXT,
ADD COLUMN     "toolsSnapshot" JSONB;

-- CreateTable
CREATE TABLE "TestCase" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "tool" TEXT,
    "args" JSONB,
    "target" TEXT NOT NULL DEFAULT 'mock',
    "mockResponse" JSONB,
    "expect" JSONB NOT NULL DEFAULT '{}',
    "task" TEXT,
    "expectedTools" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "answerContains" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TestCase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TestCase_projectId_idx" ON "TestCase"("projectId");

-- AddForeignKey
ALTER TABLE "TestCase" ADD CONSTRAINT "TestCase_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
