import app from './src/app.js';

try {
    process.loadEnvFile('.env');
} catch (error) {
    if (error.code !== 'ENOENT'){
        throw error
    }
}
const port = process.env.PORT;

app.listen(port, () => {
    console.log(`App listening on port ${port}`);
});