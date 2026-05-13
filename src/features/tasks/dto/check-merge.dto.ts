import { IsInt, IsOptional, IsString, IsUrl, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';

export class CheckMergeDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  prNumber!: number;

  @IsUrl()
  prUrl!: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  sessionId?: string;
}
