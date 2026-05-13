import { IsOptional, IsString, MinLength } from 'class-validator';

export class CommitTaskDto {
  @IsString()
  @MinLength(1)
  summary!: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  sessionId?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  linearKey?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  githubIssueKey?: string;
}
