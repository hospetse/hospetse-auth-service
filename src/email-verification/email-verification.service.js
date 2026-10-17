import crypto from 'node:crypto';
import { prisma } from "../lib/prisma.js";
import { AppError } from '../lib/app-error.js';



function generatePin() {
    let PIN = "";
    for (let i = 0; i < 6; i++) {
        PIN += crypto.randomInt(10);
    }
    return PIN;
};

export function hashPin(pin) {
    const secret = process.env.PIN_HMAC_SECRET;
    if (!secret) {
        throw new Error('PIN.HMAC_SECRET não configurada')
    }
    return crypto.createHmac('sha256', secret).update(pin).digest('hex')
};

export async function requestPinService(email, emailSender) {

    const userAuthActive = await prisma.userAuth.findUnique({
        where: { email, status: 'active'}
    })
    if (userAuthActive) { throw new AppError("Usuário já ativo", 409)}

    const lastChallenge = await prisma.emailVerification.findFirst({
        where: { email },
        orderBy: { createdAt: 'desc' },
    });

    if (lastChallenge && Date.now() - lastChallenge.createdAt.getTime() < 60_000){
        throw new AppError("Aguarde para solicitar um novo código", 429)
    }

    const pin = generatePin();
    const pinHash = hashPin(pin);
    const expiresAt = new Date(Date.now() + 900_000);

    const challenge = await prisma.$transaction(async (transacao_banco) => {
        await transacao_banco.emailVerification.updateMany({
            where: { email, consumedAt: null, invalidatedAt: null },
            data: { invalidatedAt: new Date() },
        });
        const created = await transacao_banco.emailVerification.create({
            data: { email, pinHash, expiresAt },
        });

        await emailSender.send({
            to: email,
            subject: "PIN",
            text: pin
        });

        return created;

    }, { timeout: 10000 });


    return { challengeId: challenge.id };
};