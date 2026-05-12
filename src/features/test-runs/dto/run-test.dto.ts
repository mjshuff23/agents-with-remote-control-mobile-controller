import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';

/** Trim transformer for class-validator inputs. */
const trimString = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** Validated input for running a test command. */
export class RunTestDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @Transform(trimString)
  /** Test command ID from arc.config.json (1-120 chars). */
  commandId: string;
}
