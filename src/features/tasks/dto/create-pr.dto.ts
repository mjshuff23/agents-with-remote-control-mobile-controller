import { IsOptional, IsString, Matches, MinLength } from 'class-validator';

export class CreatePrDto {
  @IsString()
  @MinLength(1)
  @Matches(/\S/, { message: 'title must contain non-whitespace characters' })
  title!: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  sessionId?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @Matches(/\S/, { message: 'base must contain non-whitespace characters' })
  base?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @Matches(/\S/, { message: 'head must contain non-whitespace characters' })
  head?: string;
}
