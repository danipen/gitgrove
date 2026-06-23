import { describe, expect, it } from 'bun:test'
import type { CommitPerson } from '@/lib/coauthors'
import { planFan } from './AvatarStack'

const people = (n: number): CommitPerson[] =>
  Array.from({ length: n }, (_, i) => ({ name: `Person ${i}`, email: `p${i}@example.com` }))

describe('planFan', () => {
  it('shows everyone and never overflows at or below the cap', () => {
    for (let n = 1; n <= 4; n++) {
      const plan = planFan(people(n))
      expect(plan.shown.length).toBe(n)
      expect(plan.overflow).toBe(0)
    }
  })

  it('caps the discs and collapses the rest into the counter once over the cap', () => {
    // 5 people, cap 4 → 3 discs + a "+2" counter (so the width stays fixed).
    const plan = planFan(people(5))
    expect(plan.shown.length).toBe(3)
    expect(plan.overflow).toBe(2)
  })

  it('keeps the disc count fixed no matter how many co-authors pile up', () => {
    // A squashed commit's dozens of trailers must not run off the row.
    const plan = planFan(people(100))
    expect(plan.shown.length).toBe(3)
    expect(plan.overflow).toBe(97)
  })

  it('always keeps the author (first person) visible', () => {
    const all = people(50)
    expect(planFan(all).shown[0]).toBe(all[0])
  })

  it('honours a custom cap', () => {
    const plan = planFan(people(10), 3)
    expect(plan.shown.length).toBe(2)
    expect(plan.overflow).toBe(8)
  })
})
