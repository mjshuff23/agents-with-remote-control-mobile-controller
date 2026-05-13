import { IsInt, IsOptional, IsString, IsUrl, MinLength } from 'class-validator';
import { Type } from 'class-transformer';

export class CheckMergeDto {
  @Type(() => Number)
  @IsInt()
  prNumber!: number;

  @IsUrl()
  prUrl!: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  sessionId?: string;
}
