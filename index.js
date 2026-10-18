import { createApp } from './src/app.js';
import { ConsoleEmailSender} from './src/email-verification/console.email-sender.js'
import { HttpUserProvisioner } from './src/user-provisioning/http.user-provisioner.js'
try {
    process.loadEnvFile('.env');
} catch (error) {
    if (error.code !== 'ENOENT'){
        throw error
    }
}
const port = process.env.PORT;

const app = createApp({
    emailSender: new ConsoleEmailSender(),
    userProvisioner: new HttpUserProvisioner(process.env.BACKEND_URL),
})

app.listen(port, () => {
    console.log(`App listening on port ${port}`);
});