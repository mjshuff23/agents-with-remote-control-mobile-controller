import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

const trimString = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class CreateTaskDto {
  @IsString()
  @MinLength(1)
  @MaxLength(20000)
  @Transform(trimString)
  prompt!: string;

  @IsIn(['codex'])
  agent!: 'codex';

  @IsOptional()
  @IsString()
  @MaxLength(160)
  @Transform(trimString)
  title?: string;
}
