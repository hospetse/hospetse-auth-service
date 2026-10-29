import crypto from 'node:crypto';
import argon2 from 'argon2';
import { prisma } from "../lib/prisma.js";
import { AppError } from '../lib/app-error.js';
import { hashPin } from '../email-verification/email-verification.service.js';
import { signAccessToken, ACCESS_TOKEN_TTL_SECONDS } from '../lib/jwt.js';
import { issueRefreshToken } from '../refresh-token/refresh-token.service.js';

const MAX_PIN_ATTEMPTS = 5;

// Compara os dois hashes em tempo constante, para não vazar pelo tempo de resposta
// quantos caracteres do PIN estavam certos.
function isSamePinHash(pinHash, storedPinHash) {
    const a = Buffer.from(pinHash, 'hex');
    const b = Buffer.from(storedPinHash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
};

export async function registerService({ challengeId, pin, password, name, termsVersion }, userProvisioner) {

    // ver se challenge existe
    const challenge = await prisma.emailVerification.findUnique({
        where: { id: challengeId }
    });
    if (!challenge) { throw new AppError("Código de verificação não encontrado", 404) }

    // ver o pin ainda pode ser usado
    if (challenge.invalidatedAt || challenge.expiresAt < new Date()) {
        throw new AppError("Código expirado ou já utilizado", 410)
    }

    // challenge já consumido só vale como retentativa: o cadastro anterior parou porque o back-end falhou
    // (user_auth ainda pending). Se a conta já está active, ou não existe, o PIN não pode ser reusado
    const isRetry = Boolean(challenge.consumedAt);
    if (isRetry) {
        const userAuthPending = await prisma.userAuth.findUnique({
            where: { email: challenge.email, status: 'pending_provisioning' }
        });
        if (!userAuthPending) { throw new AppError("Código expirado ou já utilizado", 410) }
    }

    // ver se nao estourou as tentativas
    if (challenge.attempts >= MAX_PIN_ATTEMPTS) {
        throw new AppError("Limite de tentativas atingido", 429)
    }

    // se o for PIN errado conta uma tentativa
    if (!isSamePinHash(hashPin(pin), challenge.pinHash)) {
        await prisma.emailVerification.update({
            where: { id: challengeId },
            data: { attempts: { increment: 1 } }
        });
        throw new AppError("Código inválido", 401)
    }

    // hash da senha fora da transação (é lento de propósito)
    const passwordHash = await argon2.hash(password);
    const email = challenge.email;

    try {
        const userAuth = await prisma.$transaction(async (transacao_banco) => {
            // consome só se ainda estiver aberto: se outra requisição consumiu antes, count é 0.
            // Na retentativa ele já foi consumido na primeira vez, então não consome de novo
            if (!isRetry) {
                const consumed = await transacao_banco.emailVerification.updateMany({
                    where: { id: challengeId, consumedAt: null, invalidatedAt: null, expiresAt: { gt: new Date() } },
                    data: { consumedAt: new Date() }
                });
                if (consumed.count === 0) { throw new AppError("Código expirado ou já utilizado", 410) }
            }

            const existing = await transacao_banco.userAuth.findUnique({
                where: { email }
            });
            if (existing?.status === 'active') { throw new AppError("E-mail já cadastrado", 409) }

            // retentativa: reaproveita a user_auth pending (mesmo authUserId)
            if (existing) {
                return transacao_banco.userAuth.update({
                    where: { id: existing.id },
                    data: { passwordHash, termsVersion, termsAcceptedAt: new Date() }
                });
            }

            return transacao_banco.userAuth.create({
                data: { email, passwordHash, termsVersion }
                // Para lembrar: Linha criada (o resto vem dos defaults do schema):
                // {
                //   id:              gerado pelo banco (gen_random_uuid) → vira o authUserId
                //   email:           do challenge
                //   passwordHash:    "$argon2id$..."
                //   status:          "pending_provisioning" (default)
                //   provisionedAt:   null (preenchido logo abaixo, quando o back-end confirmar)
                //   createdAt:       now() (default)
                //   updatedAt:       now() (@updatedAt, muda a cada update)
                //   termsAcceptedAt: now() (default, hora do servidor)
                //   termsVersion:    do payload
                // }
            });
        });

        // cria o USER no back-end. Se falhar, lança (409 ou 503) e a user_auth fica pending para a retentativa
        await userProvisioner.provision({ authUserId: userAuth.id, email, name });

        // só com a confirmação do back-end a conta fica ativa
        await prisma.userAuth.update({
            where: { id: userAuth.id },
            data: { status: 'active', provisionedAt: new Date() }
        });

        // conta ativa e USER confirmado no back-end: só agora emite o token (ADR-011)
        const accessToken = await signAccessToken(userAuth.id);
        const refreshToken = await issueRefreshToken(userAuth.id);

        return {
            accessToken,
            tokenType: 'Bearer',
            expiresIn: ACCESS_TOKEN_TTL_SECONDS,
            refreshToken
        };
    } catch (error) {
        // corrida: outra requisição criou a user_auth do mesmo e-mail entre o findUnique e o create
        if (error.code === 'P2002') {
            throw new AppError("E-mail já cadastrado", 409)
        }
        throw error;
    }
};

// hash de uma senha que ninguém sabe: o login roda o argon2.verify mesmo quando o e-mail não existe,
// para o tempo de resposta não contar quais e-mails têm conta. Gerado no primeiro login (é lento de propósito)
let dummyPasswordHash;

export async function loginService({ email, password }) {

    // a mesma mensagem para e-mail inexistente e senha errada: não conta ao cliente qual dos dois falhou
    const invalidCredentials = new AppError("E-mail ou senha inválidos", 401);

    const userAuth = await prisma.userAuth.findUnique({
        where: { email }
    });

    dummyPasswordHash ??= await argon2.hash(crypto.randomUUID());
    const isPasswordValid = await argon2.verify(userAuth?.passwordHash ?? dummyPasswordHash, password);
    if (!userAuth || !isPasswordValid) { throw invalidCredentials }

    // só depois da senha certa: quem não sabe a senha não descobre que existe um cadastro pela metade
    if (userAuth.status !== 'active') {
        throw new AppError("Cadastro não concluído: peça um novo código para terminar o cadastro", 403)
    }

    const accessToken = await signAccessToken(userAuth.id);
    const refreshToken = await issueRefreshToken(userAuth.id);

    return {
        accessToken,
        tokenType: 'Bearer',
        expiresIn: ACCESS_TOKEN_TTL_SECONDS,
        refreshToken
    };
};
