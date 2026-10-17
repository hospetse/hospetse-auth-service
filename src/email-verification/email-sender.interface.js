// Contrato de quem envia e-mail.
// Toda implementação (Resend, Brevo...) estende esta classe e sobrescreve o send.
export class EmailSender {
    // message: { to, subject, text }
    // eslint-disable-next-line no-unused-vars
    async send(message) {
        throw new Error(`${this.constructor.name} não implementou send()`);
    }
}
