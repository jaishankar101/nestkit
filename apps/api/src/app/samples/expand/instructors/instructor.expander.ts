import { ExpanderMethods } from '@cisstech/nestjs-expand' // Updated import
import { Injectable } from '@nestjs/common'
import { InstructorDTO } from './instructor.dto'
import { InstructorService } from './instructor.service'

@Injectable()
@ExpanderMethods() // Updated decorator
export class InstructorExpander {
  constructor(private readonly instructorService: InstructorService) {}

  async fetchInstructorById(instructorId: number): Promise<InstructorDTO> {
    const instructor = await this.instructorService.getInstructorById(instructorId)
    if (!instructor) {
      throw new Error(`Instructor with id ${instructorId} not found`)
    }
    return instructor
  }
}
