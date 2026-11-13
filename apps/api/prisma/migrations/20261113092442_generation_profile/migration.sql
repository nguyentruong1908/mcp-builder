-- AlterTable
ALTER TABLE "Build" ADD COLUMN     "generation" JSONB,
ADD COLUMN     "qaRepairRounds" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "generation" JSONB;
