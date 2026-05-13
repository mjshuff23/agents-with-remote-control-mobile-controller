import { IsOptional, IsString, MinLength } from 'class-validator';

export class CreatePrDto {
  @IsString()
  @MinLength(1)
  title!: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  sessionId?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  base?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  head?: string;
}
