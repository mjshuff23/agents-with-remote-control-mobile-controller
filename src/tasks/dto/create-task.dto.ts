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
  prompt: string;

  @IsString()
  /** Agent name to run (e.g. "codex"). */
  agent: string;

  @IsString()
  @Transform(trimString)
  /** Optional human-readable title. */
  title?: string;
}
