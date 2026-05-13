import { IsInt, IsOptional, IsString, IsUrl, MinLength } from 'class-validator';
import { Type } from 'class-transformer';

export class CrossReferenceDto {
  @IsUrl()
  prUrl!: string;

  @Type(() => Number)
  @IsInt()
  prNumber!: number;

  @IsOptional()
  @IsString()
  @MinLength(1)
  sessionId?: string;
}
