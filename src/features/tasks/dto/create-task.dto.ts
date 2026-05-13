import { Type } from 'class-transformer';
import { Transform } from 'class-transformer';
import { IsIn, IsObject, IsOptional, IsString, IsUrl, MaxLength, MinLength, ValidateNested } from 'class-validator';

const trimString = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** Normalized external issue reference attached at task creation. */
export class ExternalIssueRefDto {
  @IsIn(['github', 'linear'])
  provider!: 'github' | 'linear';

  @IsString()
  @MaxLength(256)
  externalId!: string;

  @IsString()
  @MaxLength(64)
  key!: string;

  @IsOptional()
  @IsUrl()
  @MaxLength(1024)
  url?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  title?: string;
}

/** Validated input for creating a new task. */
export class CreateTaskDto {
  @IsString()
  @MinLength(1)
  @MaxLength(20000)
  @Transform(trimString)
  /** Task prompt text (1-20000 chars, required). */
  prompt!: string;

  @IsIn(['codex'])
  /** Agent name to run (currently only "codex" is supported). */
  agent!: 'codex';

  @IsOptional()
  @IsString()
  @MaxLength(160)
  @Transform(trimString)
  /** Optional human-readable title (max 160 chars). */
  title?: string;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => ExternalIssueRefDto)
  /** Optional external issue reference (GitHub or Linear) to link at creation. */
  externalIssueRef?: ExternalIssueRefDto;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  @Transform(trimString)
  /** Explicit base branch to create the worktree from. Defaults to current HEAD. */
  baseRef?: string;
}
