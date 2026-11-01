import 'dotenv/config';
import assert, { AssertionError } from 'node:assert/strict';
import argon2 from 'argon2';
import { prisma } from '../src/lib/prisma.js';
import { accounts } from './seed-accounts.js';

try {
    assert(process.env.DATABASE_URL, 'DATABASE_URL ausente.');
    assert(process.env.SEED_ADMIN_PASSWORD, 'SEED_ADMIN_PASSWORD ausente.');
    assert(process.env.SEED_TUTOR_PASSWORD, 'SEED_TUTOR_PASSWORD ausente.');
    const hashes = [];
    for (const account of accounts) {
        hashes.push(await argon2.hash(account.accountType === 'admin'
            ? process.env.SEED_ADMIN_PASSWORD : process.env.SEED_TUTOR_PASSWORD));
    }
    await prisma.$transaction(async tx => {
        for (const [index, account] of accounts.entries()) {
            const matches = await tx.userAuth.findMany({ where: { OR: [{ id: account.id }, { email: account.email }] } });
            const current = matches[0];
            assert(matches.length <= 1 && (!current || (
                current.id === account.id && current.email === account.email && current.termsVersion === 'seed'
            )), 'Conflito de identidade no seed; nenhuma alteração foi salva.');
            const data = { passwordHash: hashes[index], status: 'active', provisionedAt: current?.provisionedAt ?? new Date() };
            if (current) {
                await tx.userAuth.update({ where: { id: account.id }, data });
                await tx.refreshToken.updateMany({ where: { userAuthId: account.id, revokedAt: null }, data: { revokedAt: new Date() } });
            } else {
                await tx.userAuth.create({ data: { id: account.id, email: account.email, termsVersion: 'seed', ...data } });
            }
        }
    });
    console.log('Seed concluído: 3 identidades ativas.');
} catch (error) {
    console.error(error instanceof AssertionError ? error.message : 'Falha no seed; transação revertida. Verifique a conexão e conflitos nos dados reservados.');
    process.exitCode = 1;
} finally {
    await prisma.$disconnect();
}
