import { NestKitExpandModule } from '@cisstech/nestjs-expand'
import { Module } from '@nestjs/common'
import { CourseController } from './courses/course.controller'
import { CourseExpander } from './courses/course.expander'
import { CourseService } from './courses/course.service'
import { InstructorService } from './instructors/instructor.service'
import { InstructorExpander } from './instructors/instructor.expander'

@Module({
  imports: [
    NestKitExpandModule.forRoot({
      enableLogging: true,
      enableGlobalSelection: true,
    }),
  ],
  controllers: [CourseController],
  providers: [CourseService, InstructorService, CourseExpander, InstructorExpander],
})
export class ExpandSampleModule {}
