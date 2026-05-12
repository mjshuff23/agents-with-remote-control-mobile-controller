import { IsIn, IsOptional, IsString, MaxLength, Min, IsInt } from 'class-validator';
import { Transform, Type } from 'class-transformer';

export class IssueSearchQueryDto {
  @IsIn(['github', 'linear'])
  provider!: 'github' | 'linear';

  @IsOptional()
  @IsString()
  @MaxLength(256)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  query?: string;

  /** GitHub: owner/repo slug. Linear: team ID. */
  @IsOptional()
  @IsString()
  @MaxLength(256)
  scope?: string;

  /** Linear: filter by workflow state ID. */
  @IsOptional()
  @IsString()
  @MaxLength(256)
  stateId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}
