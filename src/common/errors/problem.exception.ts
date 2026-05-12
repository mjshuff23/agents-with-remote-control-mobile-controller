import { HttpException, HttpStatus } from '@nestjs/common';

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
}

/**
 * HTTP exception that serializes to RFC 7807 Problem Details format.
 *
 * @param status - HTTP status code for the response.
 * @param title  - Short human-readable problem summary.
 * @param detail - Detailed explanation of the problem.
 * @param type   - URI identifying the problem type (defaults to "about:blank").
 */
export class ProblemException extends HttpException {
  constructor(status: HttpStatus, title: string, detail: string, type = 'about:blank') {
    super({ type, title, status, detail }, status);
    this.message = title;
  }
}
