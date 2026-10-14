import crypto, { hash } from 'node:crypto';
import { accessSync } from 'node:fs';

function generatePin(){
        let PIN = "";
        for (let i = 0; i < 6; i++){
            PIN += crypto.randomInt(10);
        }
        return PIN;
    }

function hashPin(pin){
    const secret = process.env.PIN_HMAC_SECRET;
    if (!secret) {
        throw new Error('PIN.HMAC_SECRET não configurada')
    }
    return crypto.createHmac('sha256',secret).update(pin).digest('hex')
}
export async function requestPinService() {
    const pin = generatePin();
    const hash_pin = hashPin(pin);
    const myPin = {
        "PIN": pin,
        "HASH_PIN": hash_pin
    }
    console.log(myPin)
    return myPin;
}

