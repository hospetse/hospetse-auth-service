import { requestPinService } from "./email-verification.service.js";
import Joi from 'joi'

const pinRequestSchema = Joi.object({
    email: Joi.string().trim().email().required()
}).required();

export async function requestPinController(req, res) {

    //const pin = await requestPinService();
    const response = pinRequestSchema.validate(req.body)
    if (response.error) {
        res.status(400).json(response.error.message)
        console.log(response.value)
        return
    }
    const obj = await requestPinService();
    res.status(201).json(obj)
    /*
    Logica para pegar o email, 
    vai salvar no banco
    e retornar 201 pro sistema
    */
    console.log(response)
    
}