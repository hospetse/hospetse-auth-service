import { requestPinService } from "./email-verification.service.js";
import Joi from 'joi'
import { AppError } from "../lib/app-error.js";


const pinRequestSchema = Joi.object({
    email: Joi.string().trim().email().lowercase().max(255).required()
}).required();  // Contrato da API

export function createRequestPinController(emailSender) {
    return async (req, res) => {

        const response = pinRequestSchema.validate(req.body)

        if (response.error) {
            return res.status(400).json({ "Erro": "Mande um e-mail certo" })
        }

        try {
            const email = response.value.email
            const result = await requestPinService(email, emailSender);
            res.status(201).json(result);
        } catch (error) {
            if (error instanceof AppError) {
                return res.status(error.statusCode).json({ error: error.message });
            }
            console.log(error.message)
            return res.status(500).json({ error: 'Não foi possível enviar o código' });
        }

    }
}
