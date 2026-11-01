import { createApp } from './src/app.js';
import { ConsoleEmailSender} from './src/email-verification/console.email-sender.js'
import { ResendEmailSender } from './src/email-verification/resend.email-sender.js'
import { HttpUserProvisioner } from './src/user-provisioning/http.user-provisioner.js'

// o .env é carregado pela flag --env-file-if-exists dos scripts, antes dos imports (ver README)
const port = process.env.PORT;

// sem a chave do Resend (dev local) o PIN vai para o terminal
const emailSender = process.env.RESEND_API_KEY
    ? new ResendEmailSender(process.env.RESEND_API_KEY, process.env.EMAIL_FROM)
    : new ConsoleEmailSender();

const app = createApp({
    emailSender,
    userProvisioner: new HttpUserProvisioner(process.env.BACKEND_URL, process.env.INTERNAL_SERVICE_TOKEN),
    corsOrigins: process.env.CORS_ORIGINS?.split(',').map((origin) => origin.trim()) ?? [],
})

app.listen(port, () => {
    console.log(`App listening on port ${port}`);
});