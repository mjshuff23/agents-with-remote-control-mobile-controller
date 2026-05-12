import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

const trimString = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

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
}
