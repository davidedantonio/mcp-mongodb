import { Decimal128, ObjectId } from 'bson'
import { describe, expect, it } from 'vitest'
import { renderBson, reviveBson } from './../src/bson.js'

describe('the BSON boundary', () => {
  it('tags an ObjectId so it can be recognised on the way back', () => {
    const rendered = renderBson(
      { _id: new ObjectId('507f1f77bcf86cd799439011') },
      0
    )

    expect(rendered).toBe('{"_id":{"$oid":"507f1f77bcf86cd799439011"}}')
  })

  it('renders dates readably rather than as epoch milliseconds', () => {
    const rendered = renderBson({ at: new Date('2026-01-01T00:00:00Z') }, 0)

    expect(rendered).toContain('2026-01-01T00:00:00Z')
    expect(rendered).not.toContain('$numberLong')
  })

  it('keeps decimal money exact instead of turning it into a float', () => {
    const rendered = renderBson({ total: new Decimal128('11768.04') }, 0)

    expect(rendered).toBe('{"total":{"$numberDecimal":"11768.04"}}')
  })

  it('revives what it rendered, which is the whole point', () => {
    const id = new ObjectId('507f1f77bcf86cd799439011')
    const echoed = JSON.parse(renderBson({ _id: id }, 0)) as {
      _id: unknown
    }

    expect(echoed._id).not.toBeInstanceOf(ObjectId)

    const revived = reviveBson(echoed)

    expect(revived._id).toBeInstanceOf(ObjectId)
    expect(String(revived._id)).toBe('507f1f77bcf86cd799439011')
  })

  it('revives inside arrays, so a pipeline works as well as a filter', () => {
    const pipeline = [{ $match: { _id: { $oid: '507f1f77bcf86cd799439011' } } }]
    const revived = reviveBson(pipeline)

    expect(Array.isArray(revived)).toBe(true)
    expect(revived[0]?.$match._id).toBeInstanceOf(ObjectId)
  })

  it('leaves ordinary JSON alone', () => {
    const value = { name: 'Panificio', count: 3, active: true, tags: ['a'] }

    expect(reviveBson(value)).toEqual(value)
  })
})
