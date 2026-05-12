import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class SendInputDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  text!: string;
}
