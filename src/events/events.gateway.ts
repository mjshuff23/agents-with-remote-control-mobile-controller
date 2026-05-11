import { Injectable } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { AppConfigService } from '../config/app-config.service';

@Injectable()
@WebSocketGateway({ cors: { origin: '*' } })
export class EventsGateway implements OnGatewayInit, OnGatewayConnection {
  @WebSocketServer()
  private server?: Server;

  constructor(private readonly config: AppConfigService) {}

  afterInit(server: Server): void {
    this.server = server;
  }

  handleConnection(client: Socket): void {
    const secret = this.config.controllerSecret;
    if (secret && client.handshake.auth.token !== secret) {
      client.disconnect(true);
    }
  }

  @SubscribeMessage('subscribe')
  subscribe(client: Socket, payload: { taskId: string }): { ok: true } {
    client.join(`task:${payload.taskId}`);
    return { ok: true };
  }

  @SubscribeMessage('unsubscribe')
  unsubscribe(client: Socket, payload: { taskId: string }): void {
    client.leave(`task:${payload.taskId}`);
  }

  emitToTask(taskId: string, event: string, payload: unknown): void {
    this.server?.to(`task:${taskId}`).emit(event, payload);
  }
}
