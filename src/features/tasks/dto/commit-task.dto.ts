import { IsOptional, IsString, MinLength } from 'class-validator';

export class CommitTaskDto {
  @IsString()
  @MinLength(1)
  summary!: string;

  @IsOptional()
  @IsString()
  sessionId?: string;

  @IsOptional()
  @IsString()
  linearKey?: string;

  @IsOptional()
  @IsString()
  githubIssueKey?: string;
}
