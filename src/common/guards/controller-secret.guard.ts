import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { AppConfigService } from '../../config/app-config.service';

@Injectable()
export class ControllerSecretGuard implements CanActivate {
  constructor(private readonly config: AppConfigService) {}

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

function controllerToken(request: Request): string | undefined {
  const header = request.header('x-controller-secret');
  if (header) {
    return header;
  }

  const auth = request.header('authorization');
  const match = auth?.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}
