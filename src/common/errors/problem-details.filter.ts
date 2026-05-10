import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus
} from '@nestjs/common';
import { Response } from 'express';
import { ProblemDetails } from './problem.exception';

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
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
      detail: exception instanceof Error ? exception.message : 'Unexpected server error',
      instance
    };
  }

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
