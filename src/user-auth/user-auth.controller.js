import { registerService } from "./user-auth.service.js";
import Joi from 'joi'
import { AppError } from "../lib/app-error.js";


const registerSchema = Joi.object({
    challengeId: Joi.string().guid().required(),
    pin: Joi.string().pattern(/^\d{6}$/).required(),
    password: Joi.string().required(), // TBD: tamanho mínimo/máximo (decisão da PO na https://dev.azure.com/escola-ti/Hospetse/_boards/board/t/Hospetse%20Team/Backlog%20items?System.AssignedTo=%40me&workitem=252)
    acceptedTerms: Joi.boolean().valid(true).required(),
    termsVersion: Joi.string().trim().max(64).required()
}).required();  // Contrato da API

export function createRegisterController() {
    return async (req, res) => {

        const response = registerSchema.validate(req.body)

        if (response.error) {
            return res.status(400).json({ error: response.error.message })
        }

        try {
            const result = await registerService(response.value);
            res.status(201).json(result);
        } catch (error) {
            if (error instanceof AppError) {
                return res.status(error.statusCode).json({ error: error.message });
            }
            console.log(error.message)
            return res.status(500).json({ error: 'Não foi possível concluir o cadastro' });
        }

    }
}
