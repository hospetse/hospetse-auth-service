import { createRequestPinController } from "./email-verification/email-verification.controller.js";
import { prisma } from "./lib/prisma.js";
import express from "express";
import { createRegisterController } from "./user-auth/user-auth.controller.js";
import { createRefreshController } from "./refresh-token/refresh-token.controller.js";

export function createApp({ emailSender, userProvisioner }) {
    const app = express();

    app.use(express.json());

    app.get('/health', async (req, res) => {
        try {
            const response = await prisma.$queryRaw`SELECT 67`;
            res.status(200).json(
                {
                    "server": "Server is running",
                    "db": "Database is running"
                });
            console.log("/health");
            console.log(response)
        } catch (error) {
            res.status(503).json(
                { "message": "Database is down for some reason bro" }
            )
            console.error(error);
        }
    });

    app.post('/api/v1/auth/request-pin', createRequestPinController(emailSender));
    app.post('/api/v1/auth/register', createRegisterController(userProvisioner));
    app.post('/api/v1/auth/refresh', createRefreshController());
    return app
}

