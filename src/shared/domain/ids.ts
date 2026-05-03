/**
 * Side-effecting ID minting, behind an Effect service so tests stay
 * deterministic. Two layers ship: `IdsLive` (web crypto) and `IdsTest`
 * (numbered sequence per prefix).
 *
 * Used wherever we'd otherwise reach for `crypto.getRandomValues`:
 *   - new Research Session id (`rs_…`)
 *   - new Research Question id (`q_…`)
 */
import { Context, Effect, Layer, Ref } from 'effect'

export class Ids extends Context.Tag('Ids')<
  Ids,
  {
    readonly mint: (prefix: string) => Effect.Effect<string>
  }
>() {}

const HEX = (bytes: number): string => {
  const buf = crypto.getRandomValues(new Uint8Array(bytes))
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
}

export const IdsLive = Layer.succeed(Ids, {
  mint: (prefix) => Effect.sync(() => `${prefix}${HEX(8)}`),
})

/**
 * Test layer: deterministic ids per prefix. `mint("q_")` returns
 * `q_0001`, `q_0002`, … inside one test run. Use via
 * `Layer.provide(IdsTest)` in `it.effect`.
 */
export const IdsTest = Layer.scoped(
  Ids,
  Effect.gen(function* () {
    const counters = yield* Ref.make(new Map<string, number>())
    return {
      mint: (prefix) =>
        Ref.modify(counters, (m) => {
          const next = (m.get(prefix) ?? 0) + 1
          const updated = new Map(m).set(prefix, next)
          const id = `${prefix}${String(next).padStart(4, '0')}`
          return [id, updated]
        }),
    }
  }),
)
