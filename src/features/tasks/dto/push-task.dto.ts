import { IsOptional, IsString, MinLength } from 'class-validator';

export class PushTaskDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  sessionId?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  remote?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  branch?: string;
}
