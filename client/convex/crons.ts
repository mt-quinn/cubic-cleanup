import { cronJobs } from 'convex/server'
import { api } from './_generated/api'

const crons = cronJobs()

// Once a day, sweep abandoned co-op rooms. The cleanupStaleRooms
// mutation deletes any room whose `updatedAt` is older than 24h,
// which covers rooms where both players closed their tabs without
// hitting "Leave co-op" and never came back through the link.
crons.daily(
  'prune stale co-op rooms',
  { hourUTC: 7, minuteUTC: 0 },
  api.rooms.cleanupStaleRooms,
)

export default crons
