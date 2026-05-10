import { HttpException, HttpStatus } from '@nestjs/common';

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
}

export class ProblemException extends HttpException {
  constructor(status: HttpStatus, title: string, detail: string, type = 'about:blank') {
    super({ type, title, status, detail }, status);
    this.message = title;
  }
}
