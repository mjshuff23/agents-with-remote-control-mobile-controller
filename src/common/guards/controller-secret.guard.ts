import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { AppConfigService } from '../../config/app-config.service';

@Injectable()
/**
 * Guard that validates the controller secret from the request.
 * Extracts the token from the `x-controller-secret` header or
 * `Authorization: Bearer <token>` and compares it to the configured secret.
 */
export class ControllerSecretGuard implements CanActivate {
  constructor(private readonly config: AppConfigService) {}

  /**
   * Validate the controller secret from the incoming request.
   *
   * @param context - NestJS execution context.
   * @returns `true` if the secret is valid.
   * @throws UnauthorizedException if the secret is missing or invalid.
   */
  canActivate(context: ExecutionContext): boolean {
    const secret = this.config.controllerSecret;
    if (!secret) {
      throw new UnauthorizedException('CONTROLLER_SECRET is required for controller actions.');
    }

    const request = context.switchToHttp().getRequest<Request>();
    const token = controllerToken(request);
    if (token !== secret) {
      throw new UnauthorizedException('Invalid controller secret.');
    }

    return true;
  }
}

/**
 * Extract the controller token from `x-controller-secret` header or
 * `Authorization: Bearer <token>`, returning undefined when absent.
 *
 * @param request - Express request object.
 * @returns The extracted token string, or `undefined` if absent.
 */
function controllerToken(request: Request): string | undefined {
  const header = request.header('x-controller-secret');
  if (header) {
    return header;
  }

  const auth = request.header('authorization');
  const match = auth?.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}
