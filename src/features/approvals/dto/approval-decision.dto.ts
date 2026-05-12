import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Trim transformer for class-validator inputs. */
const trimString = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** Validated input for an approval decision (approve/deny). */
export class ApprovalDecisionDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @Transform(trimString)
  /** Optional operator message (max 2000 chars). */
  message?: string;
}
