/*
  Warnings:

  - Added the required column `terms_version` to the `user_auth` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "user_auth" ADD COLUMN     "terms_accepted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "terms_version" VARCHAR(64) NOT NULL;
