import crypto from 'node:crypto';
import { prisma } from "../lib/prisma.js";
import { AppError } from '../lib/app-error.js';
import { signAccessToken, ACCESS_TOKEN_TTL_SECONDS } from '../lib/jwt.js';

const REFRESH_TOKEN_TTL_DAYS = 30;

// SHA-256 simples basta: o token já tem 256 bits aleatórios (não dá para adivinhar),
// e por ser determinístico dá para buscar pelo token_hash (@unique)
function hashRefreshToken(refreshToken) {
    return crypto.createHash('sha256').update(refreshToken).digest('hex')
};

// gera o token, salva só o hash e devolve o token puro (só o cliente fica com ele).
// db: passe o transacao_banco quando estiver dentro de uma transação
export async function issueRefreshToken(userAuthId, db = prisma) {
    const refreshToken = crypto.randomBytes(32).toString('base64url');
    const tokenHash = hashRefreshToken(refreshToken);
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

    await db.refreshToken.create({
        data: { userAuthId, tokenHash, expiresAt }
    });

    return refreshToken;
};

export async function refreshService(refreshToken) {

    // a mesma mensagem para todos os casos: não conta ao cliente por que o token falhou
    const invalidToken = new AppError("Refresh token inválido", 401);

    // ver se o token existe
    const stored = await prisma.refreshToken.findUnique({
        where: { tokenHash: hashRefreshToken(refreshToken) },
        include: { userAuth: true }
    });
    if (!stored) { throw invalidToken }

    // token já revogado sendo usado de novo = reuso: alguém tem uma cópia (ladrão ou dono).
    // Revoga todos os tokens da conta, forçando novo login. Fica fora de transação
    // de propósito: o throw logo depois não pode desfazer a revogação
    if (stored.revokedAt) {
        await prisma.refreshToken.updateMany({
            where: { userAuthId: stored.userAuthId, revokedAt: null },
            data: { revokedAt: new Date() }
        });
        throw invalidToken
    }

    // ver se não expirou
    if (stored.expiresAt < new Date()) { throw invalidToken }

    // conta precisa continuar ativa para renovar
    if (stored.userAuth.status !== 'active') { throw invalidToken }

    // rotação: revoga o atual e emite um novo, juntos
    const newRefreshToken = await prisma.$transaction(async (transacao_banco) => {
        // revoga só se ainda estiver aberto: se outra requisição usou o mesmo token antes, count é 0
        const revoked = await transacao_banco.refreshToken.updateMany({
            where: { id: stored.id, revokedAt: null },
            data: { revokedAt: new Date() }
        });
        if (revoked.count === 0) { throw invalidToken }

        return issueRefreshToken(stored.userAuthId, transacao_banco);
    });

    const accessToken = await signAccessToken(stored.userAuthId);

    return {
        accessToken,
        tokenType: 'Bearer',
        expiresIn: ACCESS_TOKEN_TTL_SECONDS,
        refreshToken: newRefreshToken
    };
};
