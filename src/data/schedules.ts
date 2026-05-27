import type { ScheduleConfig } from '../types'

/**
 * Period times only — class names and student rosters live in Firebase (Roster Editor).
 * These never change year to year.
 */
export const SCHEDULES: ScheduleConfig = {
  red: {
    regular: [
      { name: 'Red1', startTime: '08:25', endTime: '09:45', students: [] },
      { name: 'Red2', startTime: '10:40', endTime: '12:00', students: [] },
      { name: 'Red3', startTime: '12:50', endTime: '14:10', students: [] },
      { name: 'Red4', startTime: '14:15', endTime: '15:35', students: [] },
    ],
    late: [
      { name: 'Red1', startTime: '09:35', endTime: '10:50', students: [] },
      { name: 'Red2', startTime: '11:05', endTime: '12:20', students: [] },
      { name: 'Red3', startTime: '13:00', endTime: '14:15', students: [] },
      { name: 'Red4', startTime: '14:20', endTime: '15:35', students: [] },
    ],
  },
  black: {
    regular: [
      { name: 'Black1', startTime: '08:25', endTime: '09:45', students: [] },
      { name: 'Black2', startTime: '10:40', endTime: '12:00', students: [] },
      { name: 'Black3', startTime: '12:50', endTime: '14:10', students: [] },
      { name: 'Black4', startTime: '14:15', endTime: '15:35', students: [] },
    ],
    late: [
      { name: 'Black1', startTime: '09:35', endTime: '10:50', students: [] },
      { name: 'Black2', startTime: '11:05', endTime: '12:20', students: [] },
      { name: 'Black3', startTime: '13:00', endTime: '14:15', students: [] },
      { name: 'Black4', startTime: '14:20', endTime: '15:35', students: [] },
    ],
  },
}
