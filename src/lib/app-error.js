export class AppError extends Error{
    constructor(message, statusCode){
        super(message);
        this.name = "App Error";
        this.statusCode = statusCode;
    }
}