import { requestPinController } from "./email-verification/email-verification.controller.js";
import { prisma } from "./lib/prisma.js";
import express from "express";

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

app.post('/api/v1/auth/request-pin', requestPinController)

export default app