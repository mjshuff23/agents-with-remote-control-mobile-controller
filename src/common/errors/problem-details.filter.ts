import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus
} from '@nestjs/common';
import { Response } from 'express';
import { ProblemDetails } from './problem.exception';

/**
 * Global exception filter that converts all exceptions to RFC 7807
 * Problem Details JSON responses (`application/problem+json`).
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  /**
   * Handle an exception by writing a Problem Details response.
   *
   * @param exception - The thrown exception (any type).
   * @param host      - NestJS arguments host providing HTTP context.
   */
  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<{ url?: string }>();
    const status = exception instanceof HttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;

    const body = this.toProblemDetails(exception, status, request.url ?? '');
    response
      .status(status)
      .type('application/problem+json')
      .json(body);
  }

  /**
   * Build a Problem Details body from an exception and its context.
   *
   * @param exception - The thrown exception.
   * @param status    - HTTP status code.
   * @param instance  - Request URL for the `instance` field.
   * @returns A Problem Details object conforming to RFC 7807.
   */
  private toProblemDetails(exception: unknown, status: number, instance: string): ProblemDetails {
    if (exception instanceof HttpException) {
      const response = exception.getResponse();
      if (typeof response === 'object' && response !== null) {
        const data = response as Record<string, unknown>;
        return {
          type: typeof data.type === 'string' ? data.type : 'about:blank',
          title: typeof data.title === 'string' ? data.title : this.titleForStatus(status),
          status,
          detail: this.detailFromResponse(data, exception.message),
          instance
        };
      }

      return {
        type: 'about:blank',
        title: this.titleForStatus(status),
        status,
        detail: String(response),
        instance
      };
    }

    return {
      type: 'about:blank',
      title: this.titleForStatus(status),
      status,
      detail: status >= 500
        ? 'Unexpected server error'
        : exception instanceof Error ? exception.message : 'Unexpected server error',
      instance
    };
  }

  /**
   * Extract a detail string from an HttpException response body.
   *
   * @param data     - The HttpException response data.
   * @param fallback - Fallback string if no detail is found.
   * @returns A human-readable detail string.
   */
  private detailFromResponse(data: Record<string, unknown>, fallback: string): string {
    if (typeof data.detail === 'string') {
      return data.detail;
    }
    if (typeof data.message === 'string') {
      return data.message;
    }
    if (Array.isArray(data.message)) {
      return data.message.join('; ');
    }
    return fallback;
  }

  /**
   * Map an HTTP status code to a human-readable title string.
   *
   * @param status - HTTP status code.
   * @returns A standard title like "Bad Request" or "Internal Server Error".
   */
  private titleForStatus(status: number): string {
    if (status === HttpStatus.BAD_REQUEST) {
      return 'Bad Request';
    }
    if (status === HttpStatus.NOT_FOUND) {
      return 'Not Found';
    }
    if (status === HttpStatus.CONFLICT) {
      return 'Conflict';
    }
    if (status === HttpStatus.SERVICE_UNAVAILABLE) {
      return 'Service Unavailable';
    }
    return status >= 500 ? 'Internal Server Error' : 'Request Failed';
  }
}
