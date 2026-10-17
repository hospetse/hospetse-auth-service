import { createApp } from './src/app.js';
import { ConsoleEmailSender} from './src/email-verification/console.email-sender.js'
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
})

app.listen(port, () => {
    console.log(`App listening on port ${port}`);
});