import { IsNumber, IsOptional, IsString, MinLength } from 'class-validator';

export class CrossReferenceDto {
  @IsString()
  @MinLength(1)
  prUrl!: string;

  @IsNumber()
  prNumber!: number;

  @IsString()
  @MinLength(1)
  linearIssueId!: string;

  @IsString()
  @MinLength(1)
  linearIssueKey!: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  sessionId?: string;
}
