import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';

const trimString = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class RunTestDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @Transform(trimString)
  commandId!: string;
}
