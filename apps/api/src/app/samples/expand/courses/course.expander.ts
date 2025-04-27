import { Expander, UseExpansionMethod } from '@cisstech/nestjs-expand'
import { Injectable } from '@nestjs/common'
import { InstructorExpander } from '../instructors/instructor.expander'
import { CourseDTO } from './course.dto'

@Injectable()
@Expander(CourseDTO)
@UseExpansionMethod<CourseDTO>({
  name: 'instructor', // Field name to populate
  class: InstructorExpander, // The reusable logic class
  method: 'fetchInstructorById', // Method in InstructorExpander
  params: ['instructorId'], // Map parent.instructorId to the first arg of fetchInstructorById
})
export class CourseExpander {}
